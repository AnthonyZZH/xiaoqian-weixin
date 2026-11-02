import {createHash} from 'node:crypto';
import {wrapLibraryRead,createRetrievalBudget,DEFAULT_RETRIEVAL_POLICY,ROTATION_INJECTION_LIMITS,checkRotationHandoff} from './retrieval-budget.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
export const inject=['xiaoqianBridge'];
export const POLICY_SLOT=Symbol.for('xiaoqian.retrieval-budget.v1');
export function apply(ctx,config={}){
 const bridge=ctx.xiaoqianBridge,core=bridge.core;
 if(bridge[POLICY_SLOT])throw Error('RETRIEVAL_BUDGET_ALREADY_INSTALLED');
 const policy={...DEFAULT_RETRIEVAL_POLICY,...config.policy};createRetrievalBudget(policy);
 const owner=[...core.chats.values()].find(c=>c.owner&&c.mode==='private');if(!owner)throw Error('OWNER_UNAVAILABLE');
 const binding=core.store.data.chats[owner.id]?.binding,installed=new Map();let closed=false;
 const input=agent=>{const messages=agent.session.deriveMessages();const m=messages.findLast(m=>m.role==='user');if(!m?.id)throw Error('RETRIEVAL_INPUT_REFERENCE_REQUIRED');let query='';if(m.source?.kind==='xiaoqian-wechat'){const t=m.content.find(b=>b.type==='text')?.text??'';try{const envelope=JSON.parse(t.slice(t.indexOf('\n')+1));if(typeof envelope.text==='string')query=envelope.text.slice(0,1000);}catch{}}return {key:agent.session.id+':'+m.id,query};};
 function install(agent){
  if(installed.has(agent))return;
  const tool=agent.ctx.tools.get('xiaoqian_library_read',agent),search=agent.ctx.tools.get('xiaoqian_library_search',agent);
  const isCurrent=exec=>!closed&&exec.agent===agent&&core.handles.get(owner.id)?.agent===agent&&core.store.data.chats[owner.id]?.binding===binding&&!core.closed;
  const budget=createRetrievalBudget(policy),hook=wrapLibraryRead(tool,{isCurrent,input:()=>input(agent),policy,budget});
  const baseSearch=search?.execute,baseRender=search?.output?.render;let wrappedSearch,renderSearch;
  if(search&&typeof baseSearch==='function'){
   wrappedSearch=async(args,exec)=>{if(!isCurrent(exec))throw Error('LIBRARY_AGENT_SCOPE_DENIED');const v=await baseSearch.call(search,args,exec);if(!isCurrent(exec))throw Error('LIBRARY_AGENT_SCOPE_DENIED');const r=budget.project(v,{},input(agent).key);return r??{ok:false,code:'RETRIEVAL_DEFAULT_BUDGET_EXHAUSTED'};};
   renderSearch=(args,v)=>v?.code==='RETRIEVAL_DEFAULT_BUDGET_EXHAUSTED'?[]:baseRender(args,v);search.execute=wrappedSearch;search.output.render=renderSearch;
  }
  installed.set(agent,{hook,close(){hook.close();if(search&&search.execute===wrappedSearch){search.execute=baseSearch;search.output.render=baseRender;}}});
 }
 const originalOpen=core.openHandle,wrappedOpen=async function(id,options){if(id===owner.id&&options?.handoff)checkRotationHandoff(options.handoff);const h=await originalOpen.apply(this,arguments);if(id===owner.id)install(h.agent);return h;};
 // All checks/guards are synchronous before any new rotation Agent creation.
 const current=core.handles.get(owner.id)?.agent;
 if(!current||current.status!=='idle'||current.inbox?.nextTurn?.length||current.inbox?.nextStep?.length)throw Error('RETRIEVAL_INSTALL_REQUIRES_IDLE_OWNER');
 install(current);core.openHandle=wrappedOpen;
 const api={policy,rotationLimits:ROTATION_INJECTION_LIMITS,enforced:true,status(){return {enforced:!closed,revision:policy.revision,ownerSessionSha256:sha(core.handles.get(owner.id)?.agent.session.id??''),readWrapped:installed.has(core.handles.get(owner.id)?.agent),rotationGuardInstalled:core.openHandle===wrappedOpen,policy:{maxChars:policy.maxChars,maxFragments:policy.maxFragments},archiveStorageChanged:false};},close(){if(closed)return;closed=true;if(core.openHandle===wrappedOpen)core.openHandle=originalOpen;for(const entry of installed.values())entry.close();installed.clear();if(bridge[POLICY_SLOT]===api)delete bridge[POLICY_SLOT];}};
 bridge[POLICY_SLOT]=api;ctx.effect(()=>()=>api.close());
}
