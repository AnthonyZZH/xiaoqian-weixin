import {createOwnerToolkit} from '../vendor/owner-tools/index.mjs';
import {digest} from './state.mjs';

// This is host-side binding. No model argument selects an owner, Agent or executor.
export async function createOwnerSupplements({getCore,config,services={}}){
  const bindings=new Map();let paused=false,closed=false;
  const isCurrentOwner=({agent,bindingId})=>{
    const core=getCore(),entry=bindings.get(agent),chat=entry&&core?.chats.get(entry.chatId);
    return Boolean(!closed&&!paused&&core&&!core.closed&&!core.store.data.paused&&entry&&
      chat?.owner===true&&chat.mode==='private'&&bindingId===entry.bindingId&&
      digest(JSON.stringify([chat.id,chat.title,chat.mode,chat.owner]))===bindingId&&
      core.state(chat.id).binding===bindingId);
  };
  const kit=await createOwnerToolkit({isCurrentOwner,
    searchEnabled:config.searchEnabled===true,python:config.python||'python',
    // These callbacks are supplied by trusted integration, never YAML credentials.
    ...(services.getProvider?{getProvider:services.getProvider}:{}),
    ...(services.worker?{worker:services.worker}:{}),
    ...(services.attachments?{attachments:services.attachments}:{}),
    ...(services.projectExecutor?{projectExecutor:services.projectExecutor,projectIds:services.projectIds||[]}:{}),
  });
  function rebind(entry){entry.bound=kit.bind({agent:entry.agent,bindingId:entry.bindingId});}
  return {
    available:()=>kit.available(),
    register({agentCtx,agent,chat,defineTool}){
      if(!chat.owner)return;
      const bindingId=digest(JSON.stringify([chat.id,chat.title,chat.mode,chat.owner]));
      const entry={agent,chatId:chat.id,bindingId,bound:null};bindings.set(agent,entry);rebind(entry);
      const defining=definition=>defineTool({...definition,async execute(args,exec){
        const core=getCore();
        if(!entry.bound||!isCurrentOwner({agent,bindingId}))throw new Error('OWNER_AUTHORITY_REVOKED');
        try{
          const result=await entry.bound.execute(definition.name,args,exec);
          core.store.audit('OWNER_TOOL_OK',chat.id,{tool:definition.name});
          return definition.name==='owner_balance'?{...result,queriedAt:new Date().toISOString()}:result;
        }catch(error){
          const code=/^[A-Z0-9_]{1,80}$/.test(error?.code||'')?error.code:'OWNER_TOOL_FAILED';
          core.store.audit('OWNER_TOOL_ERROR',chat.id,{tool:definition.name,code});throw Object.assign(new Error(code),{code});
        }
      }});
      entry.bound.register(agentCtx,defining);
      agentCtx.effect?.(()=>()=>{entry.bound?.revoke();bindings.delete(agent);});
    },
    pause(){paused=true;for(const entry of bindings.values()){entry.bound?.revoke();entry.bound=null;}},
    resume(){if(closed)return;paused=false;for(const entry of bindings.values())if(!entry.bound)rebind(entry);},
    close(){closed=true;paused=true;for(const entry of bindings.values())entry.bound?.revoke();bindings.clear();},
  };
}
