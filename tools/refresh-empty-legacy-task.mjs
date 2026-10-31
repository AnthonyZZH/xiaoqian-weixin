import fs from 'node:fs';
export const inject=['xiaoqianBridge'];
const marker=Symbol.for('xiaoqian.empty-legacy-task.refresh.v1');
export function install(core){
 if(core[marker])return core[marker];
 if(!Array.isArray(core.capabilities?.taskManager?.tools)||core.capabilities.taskManager.tools.length)throw Error('LEGACY_EXECUTOR_NOT_EMPTY');
 const original=core.registerAgent;
 const replacement=async function(ctx,agent,chat,bridge){
  if(!chat.owner||chat.mode!=='private')return original.call(this,ctx,agent,chat,bridge);
  const service=ctx.tools,tools=new Proxy(service,{get(t,k){if(k==='register')return definition=>definition.name==='wechat_task'?()=>{}:t.register(definition);const v=Reflect.get(t,k,t);return typeof v==='function'?v.bind(t):v;}});
  const scoped=new Proxy(ctx,{get(t,k){if(k==='tools')return tools;const v=Reflect.get(t,k,t);return typeof v==='function'?v.bind(t):v;}});
  return original.call(this,scoped,agent,chat,bridge);
 };
 core.registerAgent=replacement;
 const api={async refresh(){return core.serial(async()=>{
  const owners=[...core.chats.values()].filter(c=>c.owner&&c.mode==='private');if(owners.length!==1)throw Error('OWNER_BINDING_AMBIGUOUS');
  const id=owners[0].id,h=core.handles.get(id);if(!h)return {state:'future_registration_filtered',refreshed:false};
  const a=h.agent;if(a.status!=='idle'||a.inbox?.nextTurn?.length||a.inbox?.nextStep?.length)throw Error('OWNER_NOT_IDLE');
  const state=core.state(id);if(state.pendingWake||Object.values(state.replyPermits||{}).some(p=>p.status==='active'))throw Error('OWNER_HAS_PENDING_REPLY');
  const sessionId=a.session.id;await core.flush(a);await h.dispose();core.handles.delete(id);
  const fresh=await core.handle(id);if(fresh.agent.session.id!==sessionId)throw Error('OWNER_SESSION_CHANGED');
  const names=(await fresh.agent.ctx.tools.schemas(fresh.agent)).map(t=>t.name);
  if(names.includes('wechat_task')||!names.includes('wechat_task_status'))throw Error('LEGACY_TASK_SCHEMA_NOT_REFRESHED');
  return {state:'refreshed',refreshed:true,sameSession:true,legacySubmit:false,legacyStatus:true,longTasks:names.filter(n=>n.startsWith('owner_long_task')).length};
 });},close(){if(core.registerAgent===replacement)core.registerAgent=original;if(core[marker]===api)delete core[marker];}};
 core[marker]=api;return api;
}
export function apply(ctx,config={}){
 if(config.enabled!==true)return;const core=ctx.xiaoqianBridge.core,api=install(core);let stopped=false,timer;
 ctx.effect(()=>()=>{stopped=true;clearTimeout(timer);api.close();});
 const started=Date.now();const attempt=async()=>{try{const result=await api.refresh();if(!stopped&&config.proofFile)fs.writeFileSync(config.proofFile,JSON.stringify({at:new Date().toISOString(),pid:process.pid,...result}));}catch(e){if(stopped)return;if(['OWNER_NOT_IDLE','OWNER_HAS_PENDING_REPLY'].includes(e.message)){if(Date.now()-started<120000){timer=setTimeout(attempt,2000);timer.unref?.();return;}if(config.proofFile)fs.writeFileSync(config.proofFile,JSON.stringify({at:new Date().toISOString(),pid:process.pid,state:'deferred',code:'OWNER_BUSY_NO_SESSION_CHANGED'}));return;}if(config.proofFile)fs.writeFileSync(config.proofFile,JSON.stringify({at:new Date().toISOString(),pid:process.pid,state:'failed',code:/^[A-Z_]+$/.test(e.message)?e.message:'REFRESH_FAILED'}));}};
 void attempt();
}
