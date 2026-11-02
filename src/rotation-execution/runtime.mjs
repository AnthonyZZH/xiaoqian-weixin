import fs from 'node:fs';import path from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';
import {bindOwnerRotationExecution} from './host-binding.mjs';
import {adviseDimensions} from './live-advisor.mjs';
import {renderPrompt} from './native-render.mjs';
export const inject=['xiaoqianBridge','loader','xiaoqianIsolatedProvider'];
const SLOT=Symbol.for('xiaoqian.owner-rotation-execution.v1');
/** Whitelist projection from the ALREADY running host configuration. Never
 * reads provider entries, credentials, config files, profile text or bodies. */
export function projectRunningConfig(entries,core){
 const found=entries.map(e=>e.options?.config).filter(c=>typeof c?.stateDir==='string'&&path.resolve(c.stateDir,'bridge')===path.resolve(core.store.dir));
 if(found.length!==1)throw Error('RUNNING_HOST_CONFIGURATION_NOT_UNIQUE');const c=found[0];
 if(c.rotation?.autoEnabled===true)throw Error('LEGACY_AUTOMATIC_ROTATION_CONFLICT');
 return {chats:[...core.chats.values()],library:{url:c.library?.url},longTasks:{root:c.longTasks?.root},rotation:{python:c.rotation?.python}};
}
export function extractOwnerPrefix(core){
 // Existing adapters may wrap the instance method. Keep that wrapper in the
 // actual call chain; inspect the native prototype producer only for its fixed
 // data envelope. Both candidates must satisfy the SAME authority/field checks.
 const candidates=[core.ingest,Object.getPrototypeOf(core)?.ingest];
 for(const fn of new Set(candidates)){
  if(typeof fn!=='function')continue;const code=Function.prototype.toString.call(fn);
  if(!/origin\s*:\s*['"]wechat-ui['"]\s*,\s*messageId\s*:\s*m\.id\s*,\s*sender\s*:\s*m\.sender\s*,\s*text\s*:\s*m\.text\s*,\s*media\s*:\s*m\.media/.test(code)||!code.includes('this.permits.issue'))continue;
  const m=code.match(/text\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*\+\s*JSON\.stringify\(\s*envelope\s*\)/);
  if(!m)continue;const literal=m[1];return literal[0]==='"'?JSON.parse(literal):JSON.parse('"'+literal.slice(1,-1).replace(/\\'/g,"'").replace(/"/g,'\\"')+'"');
 }
 throw Error('HOST_INGRESS_PRODUCER_CHANGED');
}
async function activate(ctx,options={}){
 if(typeof options.autoEnabled!=='boolean')throw Error('EXPLICIT_AUTO_ENABLED_REQUIRED');
 if(options.autoEnabled===true&&options.economicPolicy!=='empirical-single-read-v4')throw Error('EXPLICIT_SINGLE_READ_EMPIRICAL_POLICY_REQUIRED');
 const bridge=ctx.xiaoqianBridge;if(bridge[SLOT])throw Error('ROTATION_EXECUTION_ALREADY_BOUND');
 const projected=projectRunningConfig([...ctx.loader.entries()],bridge.core);
 const source=path.resolve(options.sourceRoot),root=path.resolve(options.executionRoot),numericRoot=path.resolve(options.numericRoot);
 const load=n=>import(pathToFileURL(path.join(source,n)).href);
 const [library,session,state,policy]=await Promise.all([load('vendor/library-adapter/index.mjs'),load('src/rotation-session.mjs'),load('src/state.mjs'),load('src/policy.mjs')]);
 if(!ctx.xiaoqianIsolatedProvider?.budget?.transportAttached)throw Error('ACTUAL_FINAL_TRANSPORT_UNAVAILABLE');
 const modules={createMainLibraryAdapter:library.createMainLibraryAdapter,createRotationLibrary:(await load('src/rotation-library.mjs')).createRotationLibrary,createRotationSession:session.createRotationSession,rotationRevision:session.rotationRevision,atomicWrite:state.atomicWrite,normalizeMessage:policy.normalizeMessage,taskWireBudget:ctx.xiaoqianIsolatedProvider.budget,coordinatorRoot:path.join(path.dirname(fileURLToPath(import.meta.url)),'vendor/session-rotation'),renderPrompt,ownerPromptPrefix:extractOwnerPrefix(bridge.core)};
 const bound=bindOwnerRotationExecution({bridge,hostCtx:ctx,config:{...projected,rotation:{...projected.rotation,root,autoEnabled:options.autoEnabled}},modules,advise:(dimensions,at)=>adviseDimensions({root:numericRoot,python:projected.rotation.python,dimensions,at})});
 bridge[SLOT]=bound;ctx.effect(()=>()=>{bound.close();if(bridge[SLOT]===bound)delete bridge[SLOT];});
 let stopped=false;const save=()=>{if(stopped)return;try{modules.atomicWrite(path.join(root,'execution-status.json'),{at:new Date().toISOString(),hostPid:process.pid,...bound.status(),sourceBindings:{pythonConfigured:typeof projected.rotation.python==='string'&&path.isAbsolute(projected.rotation.python),libraryConfigured:typeof projected.library.url==='string',sourceModulesImported:true,legacyAutoEnabled:false},basePaused:bridge.core.store.data.paused===true,driverPaused:bridge.driver.paused===true,modelProbes:0});}catch{}};
 let recoveryTried=null;const pulse=async()=>{if(stopped)return;try{const s=bound.status(),key=s.pendingOpen?JSON.stringify([s.pendingOperationId,s.pendingWorkerStopped]):null;if(key&&key!==recoveryTried&&!s.busy){const r=await bound.service.recoverPending();if(r.reason!=='RECOVERY_BUSY'&&r.reason!=='PREVIOUS_WORKER_STOP_UNCONFIRMED')recoveryTried=key;}save();}catch{save();}};
 save();void pulse();const timer=setInterval(pulse,5000);timer.unref();ctx.effect(()=>()=>{stopped=true;clearInterval(timer);});
}
export async function apply(ctx,options={}){try{return await activate(ctx,options);}catch(error){if(options.executionRoot){fs.mkdirSync(options.executionRoot,{recursive:true});fs.writeFileSync(path.join(options.executionRoot,'activation-failure.json'),JSON.stringify({at:new Date().toISOString(),hostPid:process.pid,autoEnabled:options.autoEnabled===true,reason:/^[A-Z0-9_]+$/.test(error?.message??'')?error.message:'EXECUTION_ACTIVATION_FAILED'}));}throw error;}}
