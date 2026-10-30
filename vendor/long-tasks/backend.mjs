import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
export function save(file,data){const temp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(data),{flag:'wx'});fs.renameSync(temp,file);}
export class LongTasks{
 constructor({root,executor,authorize,concurrency=2}){
  if(!executor?.idempotent||typeof authorize!=='function')throw Error('EXECUTOR_CONTRACT_REQUIRED');
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw Error('CONCURRENCY_INVALID');
  this.root=path.resolve(root);fs.mkdirSync(this.root,{recursive:true});this.file=path.join(this.root,'jobs.json');this.lock=path.join(this.root,'worker.lock');
  if(fs.existsSync(this.lock)){const old=JSON.parse(fs.readFileSync(this.lock));try{process.kill(old.pid,0);throw Error('WORKER_ACTIVE');}catch(e){if(e.code!=='ESRCH')throw e;fs.unlinkSync(this.lock);}}
  fs.writeFileSync(this.lock,JSON.stringify({pid:process.pid}),{flag:'wx'});
  try{this.db=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file)): {version:1,jobs:{}};if(this.db.version!==1||!this.db.jobs)throw Error('STATE_INVALID');}
  catch(e){fs.unlinkSync(this.lock);throw e;}
  this.executor=executor;this.authorize=authorize;this.limit=concurrency;this.active=new Map();this.closed=false;this.scheduled=false;
  this.pumpSoon();
 }
 auth(ctx){if(!ctx||ctx.mode!=='private'||this.authorize(ctx)!==true)throw Error('OWNER_REQUIRED');}
 submit(ctx,{task,key}){
  this.auth(ctx);if(this.closed||this.storageFailed)throw Error('CLOSED_OR_STORAGE_FAILED');if(typeof task!=='string'||!task.trim()||task.length>4000||typeof key!=='string'||!key||key.length>200)throw Error('INPUT_INVALID');
  const prior=Object.values(this.db.jobs).find(j=>j.chatId===ctx.chatId&&j.key===key);
  if(prior){if(prior.task!==task)throw Error('IDEMPOTENCY_CONFLICT');return this.view(prior);}
  if(Object.keys(this.db.jobs).length>=1000)throw Error('TASK_LIMIT');
  const id=crypto.randomUUID();const j={task_id:id,jobId:id,chatId:ctx.chatId,principal:ctx.principal,mode:ctx.mode,key,task,status:'queued',progress:0,createdAt:Date.now(),result:null,error:null,cancelRequested:false};
  this.db.jobs[id]=j;this.persist();this.pumpSoon();return this.view(j);
 }
 view(j){return {task_id:j.task_id,jobId:j.jobId,status:j.status,progress:j.progress,result:j.result,error:j.error,cancelRequested:j.cancelRequested};}
 row(ctx,id){this.auth(ctx);const j=this.db.jobs[id];if(!j||j.chatId!==ctx.chatId||j.principal!==ctx.principal)throw Error('TASK_NOT_FOUND');return j;}
 status(ctx,{task_id,jobId}){return this.view(this.row(ctx,task_id??jobId));}
 cancel(ctx,{task_id,jobId}){const j=this.row(ctx,task_id??jobId);if(['completed','failed','cancelled'].includes(j.status))return this.view(j);j.cancelRequested=true;j.status='cancel_requested';this.persist();this.active.get(j.task_id)?.controller.abort();this.pumpSoon();return this.view(j);}
 persist(){save(this.file,this.db);}
 pumpSoon(){if(this.closed||this.scheduled)return;this.scheduled=true;setImmediate(()=>{this.scheduled=false;this.pump();});}
 pump(){if(this.closed||this.storageFailed)return;for(const j of Object.values(this.db.jobs)){if(this.active.size>=this.limit)break;if(this.active.has(j.task_id)||['completed','failed','cancelled','unknown'].includes(j.status))continue;
  const controller=new AbortController();const slot={controller};this.active.set(j.task_id,slot);
  slot.promise=this.run(j,controller.signal).catch(()=>{this.storageFailed=true;j.status='unknown';j.error='TASK_STORAGE_FAILED';}).finally(()=>{this.active.delete(j.task_id);this.pumpSoon();});
 }}
 async run(j,signal){
  try{
   const ctx={chatId:j.chatId,principal:j.principal,mode:j.mode};
   if(this.authorize(ctx)!==true){j.status='failed';j.error='OWNER_REVOKED';return;}
   const previous=await this.executor.inspect(j);
   if(previous.state==='completed'){j.status='completed';j.result=previous.result;j.progress=1;return;}
   if(previous.state==='cancelled'){j.status='cancelled';return;}
   if(previous.state==='unknown'){j.status='unknown';j.error='EXECUTION_UNCERTAIN';return;}
   if(j.cancelRequested){await this.executor.cancel(j);j.status='cancelled';return;}
   j.status=previous.state==='absent'?'starting':'recovering';this.persist();
   const report=p=>{if(typeof p==='number'&&Number.isFinite(p)){j.progress=Math.max(j.progress,Math.min(0.99,Math.max(0,p)));this.persist();}if(this.authorize(ctx)!==true)throw Error('OWNER_REVOKED');};
   j.status='running';this.persist();
   const result=await this.executor.execute(j,{signal,report,check:()=>{if(this.authorize(ctx)!==true)throw Error('OWNER_REVOKED');}});
   if(j.cancelRequested){j.status='cancelled';return;}
   const encoded=JSON.stringify(result);if(!encoded||encoded.length>1048576)throw Error('RESULT_INVALID');j.result=JSON.parse(encoded);j.progress=1;j.status='completed';j.error=null;
  }catch(e){if(this.closed){j.status='paused';j.error=null;}else if(j.cancelRequested&&!e?.uncertain){j.status='cancelled';}else{j.status=e?.uncertain?'unknown':'failed';j.error=e?.code==='OWNER_REVOKED'||e?.message==='OWNER_REVOKED'?'OWNER_REVOKED':e?.uncertain?'EXECUTION_UNCERTAIN':'EXECUTOR_FAILED';}}
  finally{j.updatedAt=Date.now();this.persist();}
 }
 close(){return this.closing??=(async()=>{this.closed=true;for(const s of this.active.values())s.controller.abort();await Promise.allSettled([...this.active.values()].map(s=>s.promise));fs.unlinkSync(this.lock);})();}
}
