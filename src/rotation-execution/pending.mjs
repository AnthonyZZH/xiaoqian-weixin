import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
/** Opaque receipt only. Summary text remains in native durable SDK session and
 * normal archive. No second body log is created here. */
export function createPending(root,{atomicWrite,hostPid=process.pid,isAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}}={}){
 const file=path.join(root,'execution-pending.json'),results=new Map();
 const read=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
 const write=row=>atomicWrite(file,row);
 const patch=v=>{const p=read();if(p)write({...p,...v});};
 return {read,begin:write,stopped:p=>p.workerStopped===true||(p.hostPid!==hostPid&&!isAlive(p.hostPid)),stoppedNow:()=>patch({workerStopped:true}),guardRejected:code=>patch({open:true,workerStopped:true,post_commit_guard_code:code}),close:r=>patch({open:false,result:{status:r.status,reason:r.reason,active_agent_id:r.active_agent_id??null}}),summaryStarted(operation,session){const p=read();if(p?.summary_started===true&&!results.has(operation))throw Object.assign(Error('SUMMARY_PREVIOUS_OUTCOME_UNKNOWN'),{uncertain:true});patch({summary_started:true,summary_session_id:session});},summaryResult:operation=>results.get(operation)??null,summaryComplete(operation,result){results.set(operation,result);patch({summary_result_sha256:hash(JSON.stringify(result))});}};
}
