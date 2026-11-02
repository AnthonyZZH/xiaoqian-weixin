import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {apply as installRetrievalBudget} from './retrieval-runtime.mjs';
import {createNumericSampler} from './numeric-sampler-r2.mjs';
import {createLiveProjection} from './live-projection-r3.mjs';
import {adviseDimensions} from './live-advisor.mjs';
export const inject=['xiaoqianBridge'];
const moduleRoot=path.dirname(fileURLToPath(import.meta.url)),slot=Symbol.for('xiaoqian.numeric-shadow.interval-v3');
export function apply(ctx,config={}){
 if(config.autoEnabled!==false)throw Error('NUMERIC_SHADOW_REQUIRES_AUTO_FALSE');
 const bridge=ctx.xiaoqianBridge;

 // Trusted deployment inputs; no private seed/config/proof file is bundled.
 if(typeof config.stateRoot!=='string'||!path.isAbsolute(config.stateRoot))throw Error('ABSOLUTE_NUMERIC_STATE_ROOT_REQUIRED');
 const root=config.stateRoot;fs.mkdirSync(root,{recursive:true});
 const sourceCaps=config.sourceCaps,libraryPolicy=config.libraryPolicy;
 if(!Number.isSafeInteger(sourceCaps?.bounds?.archive_bytes_upper)||sourceCaps.bounds.archive_bytes_upper<=0)throw Error('VERIFIED_SOURCE_CAPS_REQUIRED');
 if(libraryPolicy?.expected_incremental_external_api_fee!=='0'||libraryPolicy.not_execution_permission!==true)throw Error('VERIFIED_LOCAL_LIBRARY_FEE_POLICY_REQUIRED');
 const pairs=config.pairs??[];if(!Array.isArray(pairs))throw Error('CALIBRATION_RECORDS_INVALID');
 const owner=[...bridge.core.chats.values()].filter(c=>c.owner===true&&c.mode==='private');if(owner.length!==1)throw Error('UNIQUE_OWNER_REQUIRED');
 const initialNumeric=undefined; // Calibrate from future ordinary requests; no seed replay.
 if(!bridge[Symbol.for('xiaoqian.retrieval-budget.v1')])installRetrievalBudget(ctx,config);
 if(bridge[slot]){if(bridge[slot].status?.autoEnabled!==false)throw Error('NUMERIC_SHADOW_SLOT_CONFLICT');bridge[slot].close();}
 const projection=createLiveProjection({bridge,pairs,caps:sourceCaps,ownerChatId:owner[0].id});
 const sampler=createNumericSampler({bridge,sourceCaps,libraryPolicy,initialNumeric,onUsage:projection.observeUsage});
 let stopped=false,lastWrite=0,busy=false,timer,lastKey=null,advisor=null;
 const api={status:null,close(){if(stopped)return;stopped=true;clearInterval(timer);projection.close();if(bridge[slot]===api)delete bridge[slot];}};
 async function tick(){
  if(stopped||busy)return;busy=true;
  try{
   const value=sampler.sample();
   try{
    const dimensions=await projection.measure();
    const advisorKey=JSON.stringify([dimensions.version_sha256,value.at.slice(0,13)]);
    if(advisorKey!==lastKey){advisor=await adviseDimensions({root:moduleRoot,python:config.python,at:value.at,dimensions});lastKey=advisorKey;}
    if(stopped)return;
    value.numeric_dimensions=dimensions;value.collector_interface=projection.status();
    value.missing=[];value.decision={...advisor,ordinary_chat_continues:true};
    value.calculator={policy:'single-read-interval-v3',result:advisor,source:'conservative-rotation-r1/live-adapter-r2',intervalScenarioAvailable:true,automaticEvidenceComplete:false,authority:'shadow-only empirical scenario; not automatic permission'};
   }catch(error){
    const reason=/^[A-Z0-9_]{1,100}$/.test(error?.message||'')?error.message:'LIVE_NUMERIC_PROJECTION_FAILED';
    value.missing=[reason];value.collector_interface=projection.status();value.decision={recommendation:'hold',reason,missing:[reason],L:null,U:null,automatic_permission:false,ordinary_chat_continues:true};
   }
   delete value.effects.newBodyReads;value.effects.bodyFileReads=0;value.effects.bodyPersisted=0;value.effects.bodyExported=0;value.effects.projectionScope='existing native cached fold and already serialized collector gateway';
   value.adapterRevision='live-numeric-r3';api.status=value;
   if(!lastWrite||Date.now()-lastWrite>=10000){const tmp=path.join(root,'shadow-numeric.json.tmp');fs.writeFileSync(tmp,JSON.stringify(value,null,2));fs.renameSync(tmp,path.join(root,'shadow-numeric.json'));lastWrite=Date.now();}
  }catch(error){try{fs.writeFileSync(path.join(root,'shadow-error.json'),JSON.stringify({at:new Date().toISOString(),hostPid:process.pid,autoEnabled:false,decision:{recommendation:'hold',reason:'NUMERIC_SAMPLER_FAILED'},errorType:error?.name||'Error',ordinary_chat_continues:true}));}catch{}}
  finally{busy=false;}
 }
 bridge[slot]=api;try{ctx.effect(()=>()=>api.close());}catch(e){api.close();throw e;}
 timer=setInterval(tick,1000);timer.unref();void tick();
 fs.writeFileSync(path.join(root,'activation-r3.json'),JSON.stringify({at:new Date().toISOString(),hostPid:process.pid,autoEnabled:false,registered:true,adapterRevision:'live-numeric-r3',collectorInterface:projection.status(),driverPaused:bridge.driver?.paused===true,paused:bridge.core.store.data.paused===true,modelCalls:0,sessionSwitches:0}));
}
