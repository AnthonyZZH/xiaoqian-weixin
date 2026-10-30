import {taskInputReceiptMatches} from './input-receipt.mjs';
import fs from 'node:fs';import path from 'node:path';import {atomic} from './persona-cas.mjs';
export class NativeWorker{
 idempotent=true;
 constructor({root,host,authorize,loadRequest,installTools,authorizeTool,persona,budget,limits={}}){Object.assign(this,{root,host,authorize,loadRequest,installTools,authorizeTool,persona,budget});this.maxRequests=limits.requests??4;this.maxSteps=limits.steps??4;this.maxTools=limits.tools??8;this.maxMs=limits.ms??120000;if(!Number.isInteger(this.maxRequests)||this.maxRequests<1||this.maxRequests>8||!Number.isInteger(this.maxSteps)||this.maxSteps<1||this.maxSteps>8||!Number.isInteger(this.maxTools)||this.maxTools<1||this.maxTools>16||!Number.isInteger(this.maxMs)||this.maxMs<1||this.maxMs>300000||typeof host.inspectSession!=='function')throw Error('TASK_BUDGET_OR_INSPECTION_INVALID');this.running=new Map();fs.mkdirSync(root,{recursive:true});}
 file(job){if(!/^[0-9a-f-]{36}$/.test(job.task_id))throw Error('TASK_ID');return path.join(this.root,job.task_id+'.json');}
 read(job){const p=this.file(job);return fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):null;}
 save(job,row){atomic(this.file(job),row);}
 async inspect(job){
  let row=this.read(job);if(!row)return {state:'absent'};
  if(row.state==='completed')return {state:'completed',result:row.result};
  if(row.state==='draft_ready'||row.state==='prepared')return {state:'running'};
  if(this.running.has(job.task_id))return {state:'running'};
  // A crash around create/followup/flush is not permission to append input again.
  const snap=await this.host.inspectSession({sessionId:row.sessionId,messageId:row.messageId,taskId:job.task_id}).catch(()=>({state:'unknown'}));
  if(snap.state==='completed'&&snap.admitted===true&&typeof snap.text==='string'){
   row.state='draft_ready';row.text=snap.text;this.save(job,row);return {state:'running'};
  }
  if(snap.state==='resumable'&&snap.admitted===true&&snap.toolEffectsKnown===true)return {state:'running'};
  return {state:'unknown'};
 }
 async execute(job,ports){
  if(this.running.has(job.task_id))return this.running.get(job.task_id);
  const work=this.perform(job,ports).catch(error=>{const r=this.read(job)??{};const codes=new Set(['TASK_REQUEST_LIMIT','TASK_TIME_LIMIT','TASK_STEP_LIMIT','TASK_TOOL_LIMIT','OWNER_REVOKED','CANCELLED','TASK_GRANT_EXPIRED','PERSONA_CANDIDATE_INVALID','TASK_EXTRA_INPUT_REQUIRES_REVIEW']);r.errorCode=codes.has(error.message)?error.message:'TASK_EXECUTION_FAILED';if(error.uncertain)r.state='unknown';try{this.save(job,r);}catch{}throw error;}).finally(()=>this.running.delete(job.task_id));this.running.set(job.task_id,work);return work;
 }
 async perform(job,{signal,report,check:checkOwner}){
  const req=this.loadRequest(job),owner=req.owner;let row=this.read(job)??{state:'prepared',sessionId:'xq-isolated-'+job.task_id,messageId:'task-input-'+job.task_id,requests:0,steps:0,tools:0};
  row.deadline??=Math.min(req.grant.expiresAt,Date.now()+this.maxMs);
  const check=()=>{checkOwner();if(Date.now()>=row.deadline)throw Error('TASK_TIME_LIMIT');if(this.authorize(owner)!==true)throw Error('OWNER_REVOKED');if(signal.aborted||job.cancelRequested)throw Error('CANCELLED');if(Date.now()>req.grant.expiresAt)throw Error('TASK_GRANT_EXPIRED');};
  check();this.save(job,row);
  if(row.state!=='draft_ready'){
   if(!this.budget.transportAttached)throw Error('TASK_WIRE_BUDGET_NOT_CONNECTED');
   const combined=AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,row.deadline-Date.now()))]);let handle,attempted=false;
   const unbudget=this.budget.install(row.sessionId,{signal:combined,admit:()=>{check();if(++row.requests>this.maxRequests)throw Error('TASK_REQUEST_LIMIT');this.save(job,row);}});
   const setup=async ctx=>{
    ctx.tools.restrict({allow:req.grant.tools});
    ctx.tools.guard(call=>{try{check();if(combined.aborted)return 'TASK_CANCELLED';if(!req.grant.tools.includes(call?.name))return 'TASK_TOOL_DENIED';if(this.authorizeTool({job,grant:req.grant,call})!==true)return 'TASK_RESOURCE_DENIED';if(++row.tools>this.maxTools)return 'TASK_TOOL_LIMIT';this.save(job,row);}catch{return 'TASK_OWNER_OR_BUDGET_DENIED';}});
    if(typeof ctx.on!=='function')throw Error('TASK_PRESTEP_UNAVAILABLE');
    ctx.on('agent/pre-step',(_event,next)=>{check();if(combined.aborted)throw Error('TASK_CANCELLED');if(++row.steps>this.maxSteps)throw Error('TASK_STEP_LIMIT');this.save(job,row);return next();});
    ctx.systemPrompt.section({name:'isolated-owner-task',order:400,text:'Execute only this isolated task and granted resource handles. No parent chat history, group authority or WeChat send permission. Do not spawn/poll other tasks. For persona-edit return JSON {text:string} containing a complete proposed persona, no direct persona writes.'});
    if(req.grant.tools.length){if(typeof this.installTools!=='function')throw Error('TASK_TOOLS_UNAVAILABLE');await this.installTools(ctx,{taskId:job.task_id,grant:structuredClone(req.grant),signal:combined});}
   };
   try{
    const fresh=row.state==='prepared';
    if(fresh){row.state='starting';this.save(job,row);}
    else {const known=await this.host.inspectSession({sessionId:row.sessionId,messageId:row.messageId,taskId:job.task_id});if(known.state!=='resumable'||!known.admitted||!known.toolEffectsKnown)throw Object.assign(Error('NATIVE_STATE_UNKNOWN'),{uncertain:true});}
    const opts={agentOptions:{...this.host.model,maxTokens:Math.min(this.host.model.maxTokens??4096,4096)},setup};
    attempted=true;handle=fresh?await this.host.agents.create({...opts,sessionId:row.sessionId}):await this.host.agents.resume({...opts,resumeSessionId:row.sessionId});
    const abort=()=>handle.agent.cancel({kind:'user'});combined.addEventListener('abort',abort,{once:true});
    try{
     check();if(combined.aborted)throw Error('TASK_CANCELLED');
     if(fresh){
      row.state='admitting';this.save(job,row);
      const payload={task_id:job.task_id,kind:req.kind,instruction:req.instruction,resources:req.grant.publicResources??[]};
      if(req.kind==='persona-edit')payload.persona_base={text:req.personaBase.text,revision:req.personaBase.revision};
      handle.agent.followup({id:row.messageId,role:'user',content:[{type:'text',text:JSON.stringify(payload)}],source:{kind:'isolated-owner-task'}});
      if(await this.host.sessions.flush(handle.agent.session)!==true)throw Object.assign(Error('INPUT_FLUSH_UNKNOWN'),{uncertain:true});
      row.state='admitted';this.save(job,row);
     }
     report(.15);await handle.agent.whenIdle();check();if(combined.aborted)throw Error('TASK_CANCELLED');
     if(await this.host.sessions.flush(handle.agent.session)!==true)throw Object.assign(Error('OUTPUT_FLUSH_UNKNOWN'),{uncertain:true});
     const messages=handle.agent.session.deriveMessages();
     if(!taskInputReceiptMatches(handle.agent.session,row.messageId))throw Error('TASK_EXTRA_INPUT_REQUIRES_REVIEW');
     const answer=[...messages].reverse().find(m=>m.role==='assistant');
     const text=answer?.content?.filter(v=>v.type==='text').map(v=>v.text).join('\n');
     if(typeof text!=='string'||!text.trim()||text.length>64000)throw Error('TASK_RESULT_INVALID');
     row.state='draft_ready';row.text=text;this.save(job,row);
    }finally{combined.removeEventListener('abort',abort);}
   }finally{if(attempted&&!handle){unbudget.deny();throw Object.assign(Error('TASK_NATIVE_CREATE_UNCONFIRMED'),{uncertain:true});}try{if(handle)await handle.dispose();}catch(error){unbudget.deny();error.uncertain=true;throw error;}unbudget();}
  }
  // Child teardown and all awaits finish BEFORE this short synchronous commit.
  check();let result;
  if(req.kind==='persona-edit'){
   const candidate=JSON.parse(row.text);if(typeof candidate.text!=='string')throw Error('PERSONA_CANDIDATE_INVALID');
   row.candidate=candidate;this.save(job,row);check();
   const applied=this.persona.commit(owner,{chatId:owner.chatId,operation:job.task_id,expectedRevision:req.personaBase.revision,text:candidate.text});
   result={kind:req.kind,...applied,task_id:job.task_id};
  }else result={kind:req.kind,text:row.text.slice(0,16000),task_id:job.task_id};
  row.state='completed';row.result=result;delete row.text;try{this.save(job,row);}catch(error){error.uncertain=true;throw error;}return result;
 }
 async cancel(job){const row=this.read(job);if(!row||['prepared','draft_ready','completed'].includes(row.state))return;const proof=await this.host.cancelExact?.(row.sessionId);if(proof?.confirmed!==true)throw Object.assign(Error('TASK_CANCEL_UNCONFIRMED'),{uncertain:true});}
}
