import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {pathToFileURL} from 'node:url';
import {atomicWrite,digest} from './state.mjs';
// Native Agent turns enclose each approval audit, while the owner's Agent stays free.
// The adapter is deterministic host code, never a paid/external model or a planner.
export function createOwnerManagementJobs({hostCtx,stateDir,nativePackageRoot,isCurrentOwner,createBroker,onFinished}){
 const file=path.join(stateDir,'owner-management-jobs.json'),live=new Map();let runtime=null,closed=false,launchChain=Promise.resolve();
 const unavailable={sessionRows:()=>[],submit(){throw Error('WORKER_JOB_STORE_UNAVAILABLE')},status(){throw Error('WORKER_JOB_STORE_UNAVAILABLE')},async consume(){return{consumed:false,code:'CONFIRMATION_NOT_PENDING'}},revoke(){},async close(){}};
 let rows;try{
  if(fs.existsSync(file)){const st=fs.lstatSync(file);if(st.isSymbolicLink()||st.nlink!==1||st.size>2*1024*1024)throw Error('INVALID');rows=JSON.parse(fs.readFileSync(file,'utf8'));}else rows={};
  if(!rows||Object.getPrototypeOf(rows)!==Object.prototype||Object.keys(rows).length>1000)throw Error('INVALID');
  for(const [id,row]of Object.entries(rows)){
   if(!/^[a-f0-9-]{36}$/.test(id)||row.jobId!==id||!['plugin','mcp'].includes(row.kind)||typeof row.key!=='string'||!/^[a-f0-9]{64}$/.test(row.key)||!['queued','running','awaiting-approval','completed','failed','cancelled','unknown'].includes(row.state))throw Error('INVALID');
   if(!['completed','failed','cancelled','unknown'].includes(row.state)){row.state='unknown';row.phase='finished';row.pendingRequestId=null;row.approvalExpiresAt=null;row.code='RESTART_REQUIRES_RECONCILIATION';}
  }
 }catch{return unavailable;}
 const save=()=>atomicWrite(file,rows);try{save();}catch{return unavailable;}
 hostCtx.inject(['llm','agents','sessions'],inner=>{runtime=inner;inner.effect(()=>()=>{if(runtime===inner){runtime=null;for(const job of live.values()){job.cancel.abort();job.handle?.agent.cancel({kind:'user'});job.broker?.close();}}});});
 const current=job=>!closed&&!job.cancel.signal.aborted&&isCurrentOwner(job.principal)===true;
 const code=error=>/^(OWNER_|APPROVAL_|REGISTRY_|INSPECTION_|MCP_|MANAGER_|REQUEST_|TASK_|PERSISTENCE_|NATIVE_|CANCELLED|WORKER_)[A-Z0-9_]*$/.test(error?.code||error?.message||'')?(error.code||error.message):'MANAGEMENT_OPERATION_FAILED';
 const dto=row=>({jobId:row.jobId,kind:row.kind,action:row.action,state:row.state,phase:row.phase,createdAt:row.createdAt,updatedAt:row.updatedAt,sessionId:row.sessionId||null,pendingRequestId:row.pendingRequestId||null,approvalExpiresAt:row.approvalExpiresAt||null,code:row.code||null,nativeOutcome:row.nativeOutcome||null,target:row.target||null,restartSafeReplay:false});
 async function start(job,run){let provider,handle,timer;
  const row=rows[job.id],update=(state,phase)=>{row.state=state;row.phase=phase;row.updatedAt=new Date().toISOString();if(phase==='finished'){row.pendingRequestId=null;row.approvalExpiresAt=null;}save();};
  try{
   if(!runtime)throw Error('WORKER_NATIVE_SERVICES_UNAVAILABLE');if(!current(job))throw Error('OWNER_ONLY');
   const {LlmAdapter}=await import(pathToFileURL(path.join(nativePackageRoot,'dsh-llm/lib/index.js')).href);let entered=false;
   class OneOperation extends LlmAdapter{async*stream(request){
    if(entered)throw Error('WORKER_REPLAY_DENIED');entered=true;
    try{if(!current(job))throw Error('OWNER_ONLY');update('running','preflight');
     const result=await run({job,workerAgent:job.agent,workerCtx:job.ctx,signal:AbortSignal.any([job.cancel.signal,request.signal].filter(Boolean)),beforeEffect:()=>{job.effectMayRun=true;update('running','execution');},callId:'owner-management-'+job.id});
     if(!current(job))throw Error('OWNER_AUTHORITY_REVOKED');
     job.finished=true;const outcome=result?.status||result?.outcome;
     row.nativeOutcome=['installed','already_installed','configured','running','already_running','stopped','applied','restart-required','requires-restart','failed','unknown'].includes(outcome)?outcome:'execution-returned-requires-inspection';
    }catch(error){job.error=code(error);}
    yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:'Owner management operation finished; consult the host job ledger.'};yield{type:'block-end',index:0,block:{type:'text',text:'Owner management operation finished; consult the host job ledger.'}};yield{type:'finish',reason:{kind:'stop'}};
   }}
   const route='xiaoqian-owner-management-'+job.id;
   provider=runtime.plugin({name:route,inject:['llm'],apply(ctx){ctx.llm.registerAdapter([route],new OneOperation());}},{});await provider.await();
   handle=await runtime.agents.create({sessionId:row.sessionId,agentOptions:{provider:route,model:'one-operation'},setup:async(ctx,agent)=>{
    job.agent=agent;job.ctx=ctx;ctx.tools.restrict({allow:[]});ctx.tools.guard(()=> 'OWNER_MANAGEMENT_WORKER_NO_TOOLS');
    job.broker=createBroker(job,{ctx,agent,onWaiting:requestId=>{row.pendingRequestId=requestId;row.approvalExpiresAt=new Date(Date.now()+90000).toISOString();update('awaiting-approval','approval');},onPrompt:prompt=>{row.pendingRequestId=prompt.requestId;row.approvalExpiresAt=prompt.expiresAt;update('awaiting-approval','approval');},onApproved:()=>{row.pendingRequestId=null;row.approvalExpiresAt=null;update('running','approved');}});
   }});
   job.handle=handle;timer=setTimeout(()=>{job.cancel.abort();handle.agent.cancel({kind:'user'});},300000);
   handle.agent.followup({id:'owner-job-input-'+job.id,role:'user',content:[{type:'text',text:'Execute the single host-bound management operation '+job.id}],source:{kind:'xiaoqian-owner-management'}});
   if(await runtime.sessions.flush(handle.agent.session)!==true)throw Error('PERSISTENCE_NOT_CONFIRMED');
   await handle.agent.whenIdle();if(await runtime.sessions.flush(handle.agent.session)!==true)throw Error('PERSISTENCE_NOT_CONFIRMED');
   row.code=job.error||null;update(job.error?(job.effectMayRun?'unknown':'failed'):job.finished?'completed':'unknown','finished');
  }catch(error){row.code=code(error);update(job.effectMayRun?'unknown':job.cancel.signal.aborted?'cancelled':'failed','finished');}
  finally{clearTimeout(timer);job.broker?.close();try{await handle?.dispose();}finally{await provider?.dispose();live.delete(job.id);try{await onFinished?.(job,dto(row));}catch{/* The operation result remains durable; never retry an unconfirmed notice. */}}}
 }
 return{sessionRows:()=>[...live.values()].filter(j=>j.agent).map(j=>({id:j.id,chatId:j.chatId,sessionId:j.row.sessionId,kind:'native-task',agent:j.agent,observedAt:Date.now()})),submit({principal,chatId,kind,action,callId,args,run}){
  if(closed||isCurrentOwner(principal)!==true)throw Error('OWNER_ONLY');if(!runtime)throw Error('WORKER_NATIVE_SERVICES_UNAVAILABLE');
  if(typeof callId!=='string'||!/^[A-Za-z0-9_.:-]{1,200}$/.test(callId))throw Error('NATIVE_CALL_ID_REQUIRED');
  const key=digest(JSON.stringify([principal.bindingId,kind,callId])),fingerprint=digest(JSON.stringify([action,args]));
  const old=Object.values(rows).find(r=>r.key===key);if(old){if(old.fingerprint!==fingerprint)throw Error('REQUEST_ACTION_CHANGED');return{...dto(old),duplicate:true};}
  if(Object.keys(rows).length>=1000||live.size>=8)throw Error('WORKER_CAPACITY_REQUIRES_REVIEW');
  let target=null;if(kind==='plugin'){if(action==='install'&&typeof args.spec==='string'&&/^(@[a-z0-9-]+\/[a-z0-9._-]+|[a-z0-9][a-z0-9._-]*)(@[0-9][a-zA-Z0-9.+-]*)?$/.test(args.spec))target=args.spec;else if(typeof args.entryId==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(args.entryId))target=args.entryId;}else{let name=args.serverName;try{if(args.configJson)name=JSON.parse(args.configJson).serverName;}catch{}if(typeof name==='string'&&/^[A-Za-z0-9_-]{1,32}$/.test(name))target=name;}
  const id=randomUUID(),row={jobId:id,key,fingerprint,kind,action,chatId,target,state:'queued',phase:'queued',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),sessionId:'owner-management-'+id};rows[id]=row;save();
  const job={id,principal,chatId,cancel:new AbortController(),row};live.set(id,job);job.promise=launchChain.then(()=>new Promise(r=>setImmediate(r))).then(()=>start(job,run));launchChain=job.promise.catch(()=>{});
  return dto(row);
 },status(principal,jobId){if(isCurrentOwner(principal)!==true)throw Error('OWNER_ONLY');const selected=jobId?[rows[jobId]]:Object.values(rows).slice(-30);if(selected.some(r=>!r||r.key===undefined))throw Error('REQUEST_NOT_FOUND');return{readOnly:true,jobs:selected.map(dto)};},
 async consume({chatId,event}){for(const job of live.values()){if(job.chatId!==chatId||!job.broker)continue;const result=await job.broker.consumeOwnerMessage(event);if(result.consumed)return{...result,jobId:job.id};}return{consumed:false,code:'CONFIRMATION_NOT_PENDING'};},
 revoke(principal){for(const job of live.values())if(job.principal.agent===principal.agent){job.cancel.abort();job.handle?.agent.cancel({kind:'user'});job.broker?.close();}},
 async close(){closed=true;for(const job of live.values()){job.cancel.abort();job.handle?.agent.cancel({kind:'user'});job.broker?.close();}await Promise.allSettled([...live.values()].map(j=>j.promise));}};
}
