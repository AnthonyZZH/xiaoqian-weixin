import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {LongTasks} from '../long-tasks/backend.mjs';import {atomic} from './persona-cas.mjs';import {NativeWorker} from './native-worker.mjs';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
export const KIND_TOOLS=Object.freeze({reasoning:[], 'persona-edit':[],diagnose:['task_diagnose'],install:['task_install'],files:['task_file_read','task_file_write']});
class Backend extends LongTasks{persist(){super.persist();try{this.terminal?.();}catch{this.completionStorageError=true;}}}
export class IsolatedOwnerTasks{
 constructor({root,host,authorize,grantForRequest,installTools,authorizeTool=()=>false,persona,budget,enqueueCompletion,limits}){
  Object.assign(this,{root:path.resolve(root),authorize,grantForRequest,persona,enqueueCompletion});
  this.requests=path.join(this.root,'requests');this.events=path.join(this.root,'completions');
  fs.mkdirSync(this.requests,{recursive:true});fs.mkdirSync(this.events,{recursive:true});this.delivering=new Set();this.closed=false;
  const worker=new NativeWorker({root:path.join(this.root,'native'),host,authorize,loadRequest:j=>this.request(j),installTools,authorizeTool,persona,budget,limits});
  this.worker=worker;this.backend=new Backend({root:path.join(this.root,'ledger'),executor:worker,authorize:c=>c.mode==='private'&&authorize(c)===true,concurrency:1});
  this.backend.terminal=()=>this.captureCompletions();this.captureCompletions();
 }
 auth(c){if(this.closed||c?.mode!=='private'||this.authorize(c)!==true)throw Error('OWNER_ONLY');}
 request(j){const spec=JSON.parse(j.task);if(!/^[a-f0-9]{64}$/.test(spec.requestKey))throw Error('TASK_REQUEST_INVALID');const r=JSON.parse(fs.readFileSync(path.join(this.requests,spec.requestKey+'.json'),'utf8'));if(r.owner.chatId!==j.chatId||r.owner.principal!==j.principal)throw Error('TASK_SCOPE_MISMATCH');return r;}
 submit(owner,{kind,instruction,requestId}){
  this.auth(owner);if(!this.worker.budget.transportAttached)throw Error('TASK_WIRE_BUDGET_NOT_CONNECTED');
  if(!Object.hasOwn(KIND_TOOLS,kind)||typeof instruction!=='string'||!instruction.trim()||instruction.length>3500||typeof requestId!=='string'||!requestId||requestId.length>200)throw Error('TASK_INPUT_INVALID');
  const requestKey=sha(owner.chatId+'\0'+owner.principal+'\0'+requestId),file=path.join(this.requests,requestKey+'.json');
  if(fs.existsSync(file)){const old=JSON.parse(fs.readFileSync(file));if(old.kind!==kind||old.instruction!==instruction)throw Error('TASK_REQUEST_CONFLICT');}
  else{
   const grant=structuredClone(this.grantForRequest(owner,{kind,instruction}));
   if(!grant||!Array.isArray(grant.tools)||(KIND_TOOLS[kind].length>0&&grant.tools.length===0)||new Set(grant.tools).size!==grant.tools.length||grant.tools.some(n=>!KIND_TOOLS[kind].includes(n))||!Number.isFinite(grant.expiresAt)||grant.expiresAt<=Date.now()||grant.expiresAt>Date.now()+600000)throw Error('TASK_LEAST_PRIVILEGE_GRANT_REQUIRED');
   if(grant.tools.length&&typeof this.worker.installTools!=='function')throw Error('TASK_TOOLS_UNAVAILABLE');
   const r={kind,instruction,owner:{chatId:owner.chatId,principal:owner.principal,mode:'private'},grant};
   if(kind==='persona-edit')r.personaBase=this.persona.snapshot(owner.chatId);
   atomic(file,r);
  }
  // Sync admission only: no model wait, native setup, completion delivery or core.serial.
  return this.backend.submit(owner,{task:JSON.stringify({requestKey}),key:requestKey});
 }
 status(owner,args){this.auth(owner);const v=this.backend.status(owner,args),j=this.backend.db.jobs[v.task_id];return {...v,error:this.worker.read(j)?.errorCode??v.error};}
 cancel(owner,args){this.auth(owner);return this.backend.cancel(owner,args);}
 captureCompletions(){
  for(const job of Object.values(this.backend.db.jobs)){
   if(!['completed','failed','cancelled','unknown'].includes(job.status))continue;
   const file=path.join(this.events,job.task_id+'.json');
   if(!fs.existsSync(file))atomic(file,{event_id:'task-complete:'+job.task_id,task_id:job.task_id,chatId:job.chatId,principal:job.principal,status:'pending',taskStatus:job.status,result:job.result,error:this.worker.read(job)?.errorCode??job.error});
   if(this.enqueueCompletion&&!this.delivering.has(job.task_id)){const row=JSON.parse(fs.readFileSync(file));if(row.status==='pending'){this.delivering.add(job.task_id);setImmediate(()=>{void this.deliver(job.task_id).catch(()=>{this.backend.completionStorageError=true;}).finally(()=>this.delivering.delete(job.task_id));});}}
  }
 }
 async deliver(taskId){
  if(this.closed)return;const file=path.join(this.events,taskId+'.json'),row=JSON.parse(fs.readFileSync(file));
  const owner={chatId:row.chatId,principal:row.principal,mode:'private'};if(this.authorize(owner)!==true)return;
  // Host must enqueue this stable event once; it must not directly reuse an old reply permit.
  row.status='delivering';atomic(file,row);
  try{const ack=await this.enqueueCompletion({...row,status:undefined});if(ack?.accepted!==true)throw Error('COMPLETION_NOT_ACKNOWLEDGED');row.status='delivered';atomic(file,row);}
  catch{row.status='unknown';atomic(file,row);}
 }
 pending(owner){this.auth(owner);return fs.readdirSync(this.events).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(this.events,n)))).filter(r=>r.chatId===owner.chatId&&r.principal===owner.principal&&r.status!=='delivered');}
 async close(){this.closed=true;await this.backend.close();if([...this.worker.budget.slots.values()].some(s=>s.blocked))throw Error('TASK_CLEANUP_UNCONFIRMED_KEEP_WIRE_FENCE');}
}
export function registerTaskTools({ctx,agent,owner,service,isCurrentOwner,defineTool}){
 const auth=exec=>{if(exec?.agent!==agent||isCurrentOwner(exec)!==true)throw Error('OWNER_ONLY');};
 for(const [name,parameters,call]of [
  ['owner_long_task',{kind:{type:'string',required:true},task:{type:'string',required:true}},(args,exec)=>{auth(exec);if(!exec.callId)throw Error('CALL_ID_REQUIRED');return service.submit(owner,{kind:args.kind,instruction:args.task,requestId:exec.callId});}],
  ['owner_long_task_status',{task_id:{type:'string',required:true}},(args,exec)=>{auth(exec);return service.status(owner,args);}],
  ['owner_long_task_cancel',{task_id:{type:'string',required:true}},(args,exec)=>{auth(exec);return service.cancel(owner,args);}]
 ])ctx.tools.register(defineTool({name,description:'Queue an explicit substantial owner task and return task_id immediately. Do not wait or poll repeatedly. Persona drafts run in another Agent; ordinary chat does not create a new task.',parameters,output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:call}));
}
