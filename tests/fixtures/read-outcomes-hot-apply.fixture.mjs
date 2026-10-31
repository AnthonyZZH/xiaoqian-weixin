import fs from 'node:fs';import {retrySharing,safeError} from './sharing-io.mjs';
export const inject=['xiaoqianBridge'];
export function apply(ctx,cfg){
 const bridge=ctx.xiaoqianBridge,core=bridge.core,driver=bridge.driver;let closed=false,ours=false,timer;
 const proof=v=>{try{fs.writeFileSync(cfg.proof,JSON.stringify({at:new Date().toISOString(),pid:process.pid,...v}));}catch{}};
 const resume=()=>{if(ours&&!core.closed){retrySharing(()=>core.resume(),core.store.file);ours=false;}};
 ctx.effect(()=>()=>{closed=true;clearTimeout(timer);try{resume();}catch{}});
 if(driver._call?.readOutcomeRevision==='read-outcomes/v1'){proof({stage:'already-current',status:driver.readDiagnosticsStatus(),noRestart:true});return;}
 const started=Date.now(),originalGuard=driver.call,oldPrototype=Object.getPrototypeOf(driver);
 const bounded=(value,ms,code)=>{let t;return Promise.race([value,new Promise((_,reject)=>{t=setTimeout(()=>reject(Error(code)),ms);})]).finally(()=>clearTimeout(t));};
 async function attempt(){
  if(closed)return;
  try{
   if(process.pid!==cfg.expectedPid)throw Error('HOST_CHANGED');
   await core.serial(()=>{
    if(core.closed||core.store.data.paused||driver.pending||core.jobs.size||[...core.handles.values()].some(h=>h.agent.status!=='idle'||h.agent.inbox?.nextTurn?.length||h.agent.inbox?.nextStep?.length))throw Error('SAFE_POINT_BUSY');
    if(['_call','_request','_ensure','_stop'].some(k=>Object.hasOwn(driver,k)))throw Error('UNEXPECTED_TRANSPORT_OVERRIDE');
    for(const chat of core.chats.keys())if(Object.values(core.state(chat).deliveries||{}).some(d=>d.status==='sending'))throw Error('SAFE_POINT_BUSY');
    ours=true;retrySharing(()=>core.pause(),core.store.file);proof({stage:'driver-drain',hostRestart:false});
   });
   const guard=setTimeout(()=>{try{resume();}catch(e){proof({stage:'resume-error',error:safeError(e)});}},12000);guard.unref?.();
   try{
    await bounded(driver.queue,8000,'DRIVER_DRAIN_TIMEOUT');
    if(closed||!ours||driver.child||driver.pending)throw Error('DRIVER_NOT_QUIESCENT');
    const {DurableDriverClient}=await import(cfg.transportUri);
    if(closed||!ours||core.closed)throw Error('RELOAD_CANCELLED');
    if(DurableDriverClient.prototype._call?.readOutcomeRevision!=='read-outcomes/v1')throw Error('TRANSPORT_REVISION_MISMATCH');
    Object.setPrototypeOf(driver,DurableDriverClient.prototype);
    if(driver.call!==originalGuard)throw Error('GROUP_GUARD_CHANGED');
    resume();proof({stage:'loaded-awaiting-natural-read',guardPreserved:driver.call===originalGuard,oldRpcStopped:driver.child===null,paused:core.store.data.paused,driverPaused:driver.paused,status:driver.readDiagnosticsStatus(),hostRestart:false});
   }catch(e){if(Object.getPrototypeOf(driver)!==oldPrototype)Object.setPrototypeOf(driver,oldPrototype);throw e;}
   finally{clearTimeout(guard);resume();}
  }catch(e){
   try{resume();}catch(error){proof({stage:'resume-error',error:safeError(error)});return;}
   if(e.message==='SAFE_POINT_BUSY'&&Date.now()-started<30000){timer=setTimeout(attempt,100);timer.unref?.();return;}
   proof({stage:'not-loaded',error:safeError(e),paused:core.store.data.paused,driverPaused:driver.paused,hostRestart:false});
  }
 }
 void attempt();
}
