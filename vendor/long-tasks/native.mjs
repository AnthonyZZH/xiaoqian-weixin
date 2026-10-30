/** Native DSH managed activation adapter. No models are called merely by import. */
export class HarnessExecutor{
 idempotent=true;
 constructor({lookup,start,attach,cancel}){for(const p of [lookup,start,attach,cancel])if(typeof p!=='function')throw Error('NATIVE_PORTS_REQUIRED');Object.assign(this,{lookup,start,attach,cancelPort:cancel});}
 async inspect(job){return this.lookup(job.task_id);}
 async execute(job,{signal,report,check}){
  check();const state=await this.lookup(job.task_id);let handle;
  if(state.state==='completed')return state.result;
  if(state.state==='unknown'){const e=Error('UNCERTAIN');e.uncertain=true;throw e;}
  try{handle=state.state==='absent'?await this.start(job,signal):await this.attach(job);}
  catch(e){e.uncertain=true;throw e;}
  let cancellation;const stop=()=>{cancellation=Promise.resolve().then(()=>handle.dispose());cancellation.catch(()=>{});};signal.addEventListener('abort',stop,{once:true});
  if(signal.aborted)stop();
  try{report(0.1);const result=await handle.result;check();if(signal.aborted)throw Error('CANCELLED');report(0.99);return result;}
  finally{signal.removeEventListener('abort',stop);try{await (cancellation??handle.dispose());}catch(e){e.uncertain=true;throw e;}}
 }
 async cancel(job){await this.cancelPort(job.task_id);}
}
