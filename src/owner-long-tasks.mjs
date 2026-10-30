import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {LongTasks,save} from '../vendor/long-tasks/backend.mjs';
import {HarnessExecutor} from '../vendor/long-tasks/native.mjs';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const uncertain=()=>Object.assign(Error('NATIVE_EXECUTION_UNCERTAIN'),{uncertain:true});
const immediate=()=>new Promise(r=>setImmediate(r));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function completedNativeTaskText(snapshot,messageId){
 const events=snapshot.events||[];
 const accepted=events.some(v=>(v.type==='user/message'&&v.data?.id===messageId)||(v.type==='agent/inbox/spliced'&&v.data?.inserted?.some(m=>m.id===messageId)));
 if(!accepted)return null;
 const start=events.findLastIndex(v=>v.type==='turn/start'),end=events.findLastIndex(v=>v.type==='turn/end');
 if(start<0||end<start||events[end].data?.reason?.kind!=='completed')return null;
 const index=events.findLastIndex(v=>v.type==='assistant/message'&&Array.isArray(v.data?.message?.content));
 if(index<=start||index>=end)return null;
 return events[index].data.message.content.filter(v=>v.type==='text').map(v=>v.text).join('\n')||null;
}
export function createOwnerLongTasks({hostCtx,isCurrentOwner,root,model}){
 fs.mkdirSync(root,{recursive:true});const nativeRoot=path.join(root,'native');fs.mkdirSync(nativeRoot,{recursive:true});
 const entries=new Map(),runs=new Map(),reports=new Map(),providerName='xiaoqian-owner-long-task';let backend=null,closed=false,registered=false;
 const context=e=>({chatId:e.chatId,principal:e.bindingId,mode:'private'});
 const current=ctx=>{const e=[...entries.values()].find(e=>e.chatId===ctx.chatId&&e.bindingId===ctx.principal);return !!e&&!closed&&isCurrentOwner({agent:e.agent,bindingId:e.bindingId})===true;};
 const file=id=>path.join(nativeRoot,id+'.json');
 const read=id=>fs.existsSync(file(id))?JSON.parse(fs.readFileSync(file(id),'utf8')):null;
 const persist=row=>save(file(row.task_id),row);
 function entryFor(job){const e=[...entries.values()].find(e=>e.chatId===job.chatId&&e.bindingId===job.principal);if(!e||!current(context(e)))throw Error('OWNER_REVOKED');return e;}
 async function lookup(id){
  const row=read(id);if(!row)return {state:'absent'};
  if(row.state==='completed')return {state:'completed',result:row.result};
  if(row.state==='cancelled')return {state:'cancelled'};
  if(runs.has(id))return {state:'running'};
  if(row.kind==='text-analysis'&&row.state==='running')return {state:'running'};
  if(row.kind==='model'&&row.accepted){
   const query=hostCtx.get('sessionQuery');if(!query?.readSession)return {state:'unknown'};
   try{
    const snapshot=await query.readSession(row.sessionId),events=snapshot.events;
    const accepted=events.some(v=>(v.type==='user/message'&&v.data?.id===row.messageId)||(v.type==='agent/inbox/spliced'&&v.data?.inserted?.some(m=>m.id===row.messageId)));if(!accepted)return {state:'unknown'};
    const text=completedNativeTaskText(snapshot,row.messageId);if(text){row.result={output:[{type:'text',text:text.slice(0,16000)}],stopReason:'completed'};row.state='completed';persist(row);return {state:'completed',result:row.result};}
    return {state:'running'};
   }catch{return {state:'unknown'};}
  }
  return {state:'unknown'};
 }
 async function perform(job,signal){
  signal=AbortSignal.any([signal,AbortSignal.timeout(300000)]);
  const e=entryFor(job),request=JSON.parse(job.task),prior=read(job.task_id);
  const row=prior||{task_id:job.task_id,kind:request.kind,state:'running',sessionId:'xiaoqian-long-'+job.task_id,messageId:'long-input-'+job.task_id,launches:0,iteration:0,rolling:hash(request.text)};
  row.state='running';row.launches++;persist(row);
  const check=()=>{if(signal.aborted)throw Error('CANCELLED');entryFor(job);};
  let handle;
  try{
   check();
   let result;
   if(request.kind==='text-analysis'){
    for(let i=row.iteration;i<request.iterations;i++){
     check();row.rolling=hash(row.rolling+'\0'+request.text);row.iteration=i+1;
     if(i%128===0){if(i%2048===0){persist(row);reports.get(job.task_id)?.(Math.min(0.98,(i+1)/request.iterations));}await immediate();}
    }
    result={output:[{type:'text',text:JSON.stringify({kind:'text-analysis',characters:request.text.length,lines:request.text.split('\n').length,words:request.text.trim().split(/\s+/u).filter(Boolean).length,sha256:hash(request.text),fingerprint:row.rolling,iterations:request.iterations})}],stopReason:'completed'};
   }else{
    const setup=async(ctx)=>{ctx.tools.restrict({allow:[]});ctx.tools.guard(()=> 'OWNER_LONG_TASK_NO_TOOLS');ctx.systemPrompt?.section?.({name:'owner-long-task-scope',order:400,text:'Work only on the supplied task. You have no tools, no WeChat access, no project/private files and no parent chat history. Return the text result; never claim external actions.'});};
    handle=row.accepted?await hostCtx.agents.resume({resumeSessionId:row.sessionId,agentOptions:model,setup}):await hostCtx.agents.create({sessionId:row.sessionId,agentOptions:model,setup});
    row.modelAllocated=true;persist(row);
    const abort=()=>handle.agent.cancel({kind:'user'});signal.addEventListener('abort',abort,{once:true});
    try{
     check();if(!row.accepted){handle.agent.followup({id:row.messageId,role:'user',content:[{type:'text',text:request.text}],source:{kind:'xiaoqian-owner-long-task'}});if(await hostCtx.sessions.flush(handle.agent.session)!==true)throw uncertain();row.accepted=true;persist(row);}
     await handle.agent.whenIdle();check();if(await hostCtx.sessions.flush(handle.agent.session)!==true)throw uncertain();
     const message=[...handle.agent.session.deriveMessages()].reverse().find(v=>v.role==='assistant');const text=message?.content?.filter(v=>v.type==='text').map(v=>v.text).join('\n');if(!text)throw Error('MODEL_RESULT_MISSING');
     result={output:[{type:'text',text:text.slice(0,16000)}],stopReason:'completed'};
    }finally{signal.removeEventListener('abort',abort);await handle.dispose();handle=null;}
   }
   row.state='completed';row.result=result;persist(row);return result;
  }catch(error){
   if(handle)try{handle.agent.cancel({kind:'user'});await handle.dispose();}catch{error=uncertain();}
   if(signal.aborted){row.state='cancelled';row.result={output:[],stopReason:'aborted'};}else{row.state='unknown';row.result={output:[],stopReason:'error',diagnostic:'Task execution did not complete; no automatic replay.'};}
   persist(row);return row.result;
  }
 }
 function native(){const ownerEntry=[...entries.values()].find(e=>current(context(e)));const service=ownerEntry?.ctx.get('subagents')||hostCtx.get('subagents');if(!service?.startActivation||!service?.registerProvider)throw Error('NATIVE_SUBAGENTS_UNAVAILABLE');
  if(!registered){
   service.registerProvider({name:providerName,capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},inheritsParentContext:false,async start(request){
    const message=request.prompt?.find(v=>v.type==='text')?.text;let payload;try{payload=JSON.parse(message);}catch{throw Error('TASK_ID_REQUIRED');}
    const job=backend?.db.jobs[payload.task_id];if(!job||entryFor(job).agent!==request.parent)throw Error('OWNER_TASK_BINDING_REQUIRED');
    if(runs.has(job.task_id))throw Error('TASK_ALREADY_RUNNING');
    const controller=new AbortController();const run={controller,result:null};runs.set(job.task_id,run);
    const abort=()=>controller.abort();request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
    run.result=immediate().then(()=>perform(job,controller.signal)).finally(()=>{request.signal.removeEventListener('abort',abort);runs.delete(job.task_id);});
    return {id:'xiaoqian-long-'+job.task_id,result:run.result,async dispose(){controller.abort();await run.result;}};
   }});registered=true;
  }
  return service;
 }
 async function activate(job,signal){const e=entryFor(job),request=JSON.parse(job.task);let reserved=read(job.task_id);if(!reserved){reserved={task_id:job.task_id,kind:request.kind,state:'reserved',sessionId:'xiaoqian-long-'+job.task_id,messageId:'long-input-'+job.task_id,launches:0,iteration:0,rolling:hash(request.text)};persist(reserved);}reserved.admissions=(reserved.admissions||0)+1;persist(reserved);const activation=await native().startActivation({provider:providerName,label:'Owner long task',request:{parent:e.agent,prompt:[{type:'text',text:JSON.stringify({task_id:job.task_id})}]},signal,delivery:'caller'});const receipt=read(job.task_id);receipt.activationChildId=activation.childId;persist(receipt);if(await hostCtx.sessions.flush(e.agent.session)!==true){await activation.dispose();throw uncertain();}return activation;}
 const executor=new HarnessExecutor({lookup,start:activate,attach:job=>activate(job,new AbortController().signal),cancel:async id=>{const run=runs.get(id);if(run){run.controller.abort();await run.result;}}});
 const execute=executor.execute.bind(executor);executor.execute=async(job,ports)=>{reports.set(job.task_id,ports.report);try{const result=await execute(job,ports);if(result.stopReason!=='completed'){if(result.stopReason==='aborted')throw Error('CANCELLED');throw uncertain();}return result;}finally{reports.delete(job.task_id);}};
 return {available:()=>['owner_long_task','owner_long_task_status','owner_long_task_cancel'],register({ctx,agent,bindingId,chatId,defineTool}){
  const e={ctx,agent,bindingId,chatId};entries.set(agent,e);
  if(!backend)backend=new LongTasks({root:path.join(root,'ledger'),executor,authorize:current,concurrency:1});
  const auth=exec=>{if(exec?.agent!==agent||!current(context(e)))throw Error('OWNER_ONLY');};
  const submit=(args,exec)=>{auth(exec);native();if(!exec.callId)throw Error('CALL_ID_REQUIRED');const kind=args.kind||'model';if(!['model','text-analysis'].includes(kind)||typeof args.task!=='string'||!args.task.trim()||args.task.length>3500)throw Error('TASK_INVALID');const iterations=args.iterations??2048;if(!Number.isInteger(iterations)||iterations<1||iterations>200000)throw Error('ITERATIONS_INVALID');return backend.submit(context(e),{task:JSON.stringify({kind,text:args.task,iterations}),key:hash(bindingId+'\0'+exec.callId)});};
  const status=(args,exec)=>{auth(exec);return backend.status(context(e),args);},cancel=(args,exec)=>{auth(exec);return backend.cancel(context(e),args);};
  for(const [name,parameters,fn] of [['owner_long_task',{task:{type:'string',required:true},kind:{type:'string'},iterations:{type:'number'}},submit],['owner_long_task_status',{task_id:{type:'string',required:true}},status],['owner_long_task_cancel',{task_id:{type:'string',required:true}},cancel]])ctx.tools.register(defineTool({name,description:'Owner-only persistent asynchronous task. model consumes the existing provider; text-analysis is deterministic local text/hash analysis with no model or tools. Submission immediately returns task_id. Poll status/result or cancel; no WeChat notification or automatic replay of unknown work.',parameters,output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:fn}));
  ctx.systemPrompt?.section?.({name:'owner-background-task-guide',order:317,text:'For a substantial text reasoning task use owner_long_task (kind=model) and immediately tell the owner its returned task_id; do not wait in the foreground. owner_long_task_status returns status/progress/result and owner_long_task_cancel requests cancellation. These children have no file/shell/WeChat tools or parent chat history. Local text-analysis is an actual deterministic non-model operation, not a model-task acceptance test. Unknown work must not be automatically resubmitted.'});
  ctx.effect(()=>()=>{entries.delete(agent);});
 },async close(){closed=true;await backend?.close();}};
}
