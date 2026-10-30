import {taskInputIds} from '../vendor/isolated-owner/input-receipt.mjs';
import {IsolatedOwnerTasks,registerTaskTools} from '../vendor/isolated-owner/isolated-owner.mjs';
import {PersonaCAS,blockLegacyOwnerPersonaWrites} from '../vendor/isolated-owner/persona-cas.mjs';
import {digest} from './state.mjs';
/** Pure metadata projection. Never opens task/request/native files or reads task/result fields. */
export function projectIsolatedTaskStatus({core,jobs={},handles=new Map(),ownerEntries=new Map(),closed=false,clock=Date.now}){
 if(closed||core?.closed||!(core?.chats instanceof Map)||!(core.handles instanceof Map))return [];
 const data=core.store?.data??{},rows=[],now=clock(),finite=v=>Number.isFinite(v)&&v>=0?v:null;
 const states={queued:'queued',starting:'queued',running:'running',recovering:'running',paused:'paused',cancel_requested:'running',completed:'idle',cancelled:'idle',failed:'failed',unknown:'unknown'};
 const codes={OWNER_REVOKED:'TASK_FAILED',EXECUTOR_FAILED:'TASK_FAILED',EXECUTION_UNCERTAIN:'TASK_RESULT_NOT_DURABLE',TASK_STORAGE_FAILED:'PERSISTENCE_NOT_CONFIRMED'};
 for(const [id,j]of Object.entries(jobs)){
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)||j?.task_id!==id)continue;
  const chat=core.chats.get(j.chatId),stored=data.chats?.[j.chatId],entry=[...ownerEntries.values()].find(e=>e.chatId===j.chatId&&e.bindingId===j.principal&&core.handles.get(j.chatId)?.agent===e.agent);
  if(!entry||chat?.owner!==true||chat.mode!=='private'||stored?.binding!==j.principal||digest(JSON.stringify([chat.id,chat.title,chat.mode,chat.owner]))!==j.principal)continue;
  const sid='xq-isolated-'+id,h=handles.get(sid);let engineState=null,queueLength=null;
  try{if(h){engineState=['running','idle'].includes(h.agent.status)?h.agent.status:null;const a=h.agent.inbox?.nextTurn,b=h.agent.inbox?.nextStep;if(Array.isArray(a)&&Array.isArray(b))queueLength=a.length+b.length;}}catch{/* unavailable observation stays unknown */}
  const status=Object.hasOwn(states,j.status)?j.status:'unknown',terminal=['completed','cancelled','failed','unknown'].includes(status);
  let code=null;try{const error=j.error;code=typeof error==='string'&&Object.hasOwn(codes,error)?codes[error]:(status==='failed'?'TASK_FAILED':null);}catch{code='TASK_FAILED';}
  rows.push({id,chatId:j.chatId,sessionId:h?sid:null,kind:'long-task',loaded:!!h,engineState,queueLength,knownState:states[status],terminal,paused:!!data.paused,observedAt:now,startedAt:null,createdAt:finite(j.createdAt),lastProgressAt:finite(j.updatedAt)??finite(j.createdAt),phase:status==='queued'||status==='starting'?'queued':terminal?'idle':status==='running'?'model':'task',lastOutcome:terminal?status:null,lastError:code?{code}:null});
 }
 return rows;
}
import {completedNativeTaskText} from './owner-long-tasks.mjs';
export function createOwnerIsolatedTasks({hostCtx,getCore,isCurrentOwner,root,model}){
 const entries=new Map(),handles=new Map();let service,persona,restore,closed=false;
 const names=['owner_long_task','owner_long_task_status','owner_long_task_cancel'];
 const current=o=>{const e=[...entries.values()].find(e=>e.chatId===o.chatId&&e.bindingId===o.principal);return !!e&&!closed&&o.mode==='private'&&isCurrentOwner({agent:e.agent,bindingId:e.bindingId})===true;};
 const capability=()=>{if(typeof hostCtx.get('sessionQuery')?.readSession!=='function')throw Error('TASK_SESSION_QUERY_UNAVAILABLE');const p=hostCtx.get('xiaoqianIsolatedProvider');if(!p||p.provider!==model.provider||p.budget?.transportAttached!==true)throw Error('TASK_FINAL_PROVIDER_BUDGET_UNAVAILABLE');return p;};
 const host={model,sessions:hostCtx.sessions,agents:{
  async create(o){return track(await hostCtx.agents.create(o));},
  async resume(o){return track(await hostCtx.agents.resume(o));}
 },async inspectSession({sessionId,messageId}){
  const query=hostCtx.get('sessionQuery');if(!query?.readSession)return {state:'unknown'};
  try{
   const snap=await query.readSession(sessionId),events=snap.events??[];
   const accepted=events.some(e=>e.type==='user/message'&&e.data?.id===messageId||e.type==='agent/inbox/spliced'&&e.data?.inserted?.some(m=>m.id===messageId));
   if(!accepted)return {state:'unknown'};
   const inputIds=taskInputIds(events);
   if([...inputIds].some(id=>id!==messageId))return {state:'unknown'};
   // This release supports no-effect reasoning/persona tasks only.
   if(events.some(e=>/tool.*(call|execute|result)/.test(e.type)))return {state:'unknown'};
   const text=completedNativeTaskText(snap,messageId);
   if(text)return {state:'completed',admitted:true,text};
   const live=hostCtx.agents.get(sessionId);if(live&&!handles.has(sessionId))return {state:'unknown'};
   return {state:'resumable',admitted:true,toolEffectsKnown:true};
  }catch{return {state:'unknown'};}
 },async cancelExact(sessionId){
  const h=handles.get(sessionId),live=hostCtx.agents.get(sessionId);
  if(!h)return {confirmed:!live};
  h.agent.cancel({kind:'user'});await h.agent.whenIdle();
  if(h.agent.status!=='idle'||h.agent.inbox.nextTurn.length||h.agent.inbox.nextStep.length)return {confirmed:false};
  if(await hostCtx.sessions.flush(h.agent.session)!==true)return {confirmed:false};
  await h.dispose();return {confirmed:true};
 }};
 function track(raw){const id=raw.agent.id;let disposing;const wrapped={...raw,dispose(){return disposing??=(async()=>{await raw.dispose();handles.delete(id);})();}};handles.set(id,wrapped);return wrapped;}
 function ensure(){
  const core=getCore();if(!core?.features)throw Error('TASK_CORE_NOT_READY');
  if(!persona){persona=new PersonaCAS({features:core.features,authorize:current,coordinatedWriters:true});restore=blockLegacyOwnerPersonaWrites(core.features);core.capabilities.personaCAS=persona;}
  const p=capability();if(service){if(service.worker.budget!==p.budget)throw Error('TASK_PROVIDER_BUDGET_CHANGED');return service;}
  service=new IsolatedOwnerTasks({root,host,authorize:current,persona,budget:p.budget,
   grantForRequest:(_owner,{kind})=>{
    // No generic owner tool forwarding. Effectful tasks fail closed until a separately
    // reviewed resource-scoped executor is bound; the model cannot mint this grant.
    if(!['reasoning','persona-edit'].includes(kind))throw Error('TASK_SCOPED_EXECUTOR_UNAVAILABLE');
    return {tools:[],expiresAt:Date.now()+120000,publicResources:[]};
   },
   enqueueCompletion:event=>core.queueTaskCompletion(event)
  });return service;
 }
 const sessionStatusRows=()=>projectIsolatedTaskStatus({core:getCore(),jobs:service?.backend.db.jobs,handles,ownerEntries:entries,closed});
 const facade={submit(owner,args){return ensure().submit(owner,args);},status(owner,args){return ensure().status(owner,args);},cancel(owner,args){return ensure().cancel(owner,args);}};
 return {available:()=>names,sessionStatusRows,register({ctx,agent,bindingId,chatId,defineTool}){
  const e={ctx,agent,bindingId,chatId};entries.set(agent,e);
  getCore().capabilities.isolatedTaskStatusRows=sessionStatusRows;
  // Install coordinated persona writes before any foreground owner setter executes.
  // Unsupported provider remains explicit fail closed; it never falls back to unbounded work.
  try{ensure();}catch(error){getCore().store.audit('ISOLATED_TASKS_UNAVAILABLE',chatId,{code:String(error.message).slice(0,80)});}
  const owner={chatId,principal:bindingId,mode:'private'};
  registerTaskTools({ctx,agent,owner,service:facade,isCurrentOwner:exec=>exec?.agent===agent&&current(owner),defineTool});
  ctx.systemPrompt.section({name:'owner-isolated-task-guide',order:317,text:'For substantial persona rewriting or reasoning, promptly call owner_long_task with kind persona-edit or reasoning and a self-contained task instruction. Return the task_id immediately and continue chatting; never poll status in a loop. Ordinary chat uses this session. Persona drafts run in a separate Agent and commit only if the original revision still matches. Do not do the full long rewrite first on the foreground Agent. Installation, diagnostics and files require a separately scoped executor; unavailable means no action occurred.'});
  ctx.effect(()=>()=>entries.delete(agent));
  setImmediate(()=>{void getCore().drainTaskCompletions().catch(()=>{});});
 },async close(){closed=true;if(getCore()?.capabilities.isolatedTaskStatusRows===sessionStatusRows)delete getCore().capabilities.isolatedTaskStatusRows;await service?.close();restore?.();if(getCore()?.capabilities.personaCAS===persona)delete getCore().capabilities.personaCAS;}};
}
