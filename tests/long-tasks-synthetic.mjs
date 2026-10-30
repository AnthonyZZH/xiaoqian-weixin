import fs from 'node:fs';import path from 'node:path';import {setTimeout as wait} from 'node:timers/promises';import {save} from '../vendor/long-tasks/backend.mjs';
/** Real bounded asynchronous CPU work, with durable checkpoints, no external effects. */
export class SyntheticExecutor{
 idempotent=true;
 constructor(root,{steps=20,delay=5}={}){if(!Number.isInteger(steps)||steps<1||steps>1000||!Number.isInteger(delay)||delay<0||delay>100)throw Error('BOUNDS');this.root=root;fs.mkdirSync(root,{recursive:true});this.steps=steps;this.delay=delay;this.running=new Map();}
 file(j){if(!/^[0-9a-f-]{36}$/.test(j.task_id))throw Error('TASK_ID');return path.join(this.root,j.task_id+'.json');}
 async inspect(j){const f=this.file(j);return fs.existsSync(f)?JSON.parse(fs.readFileSync(f)):{state:'absent',step:0,sum:0};}
 execute(j,{signal,report,check}){
  if(this.running.has(j.task_id))return this.running.get(j.task_id);
  const run=(async()=>{let r=await this.inspect(j);if(r.state==='completed')return r.result;if(r.state==='cancelled')throw Error('CANCELLED');
   for(let i=r.step??0;i<this.steps;i++){check();await wait(this.delay,undefined,{signal});let sum=r.sum??0;for(let n=0;n<1000;n++)sum+=(i+n)%97;
    r={state:'running',step:i+1,sum};save(this.file(j),r);report((i+1)/this.steps);}
   const result={kind:'synthetic-computation',steps:this.steps,checksum:r.sum};save(this.file(j),{...r,state:'completed',result});return result;
  })().finally(()=>this.running.delete(j.task_id));this.running.set(j.task_id,run);return run;
 }
 async cancel(j){const old=await this.inspect(j);if(old.state==='completed')return;save(this.file(j),{...old,state:'cancelled'});}
}
