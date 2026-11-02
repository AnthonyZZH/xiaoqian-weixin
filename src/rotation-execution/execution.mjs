import crypto from 'node:crypto';
import {projectSummaryInput,SUMMARY_GUIDE} from './rotation-summary-projection.mjs';
import {createSummaryGuard,createColdGuard} from './wire-guards.mjs';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const sorted=v=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
export const canonical=v=>JSON.stringify(sorted(v));
export const snapshotDigest=s=>sha(canonical({schema:'xq.rotation.archive/v1',...s}));
const check=(v,c)=>{if(!v)throw Error(c);};
/** Complete transaction entry. Expensive capture/archive/model paths are reached
 * only after a REAL already-produced input and the frozen one-read test pass. */
export function createExecution({autoEnabled=false,core,ownerId,dimensions,advise,capture,createPorts,worker,journal,wireGuards,hostCtx,pending,model,revision,limits,renderPrompt,clock=()=>new Date().toISOString()}){
 let busy=false,recovering=false,closed=false,last={reason:autoEnabled?'WAITING_FOR_REAL_OWNER_INPUT':'AUTO_DISABLED',autoEnabled};
 const idle=()=>{const a=core.handles.get(ownerId)?.agent,s=core.state(ownerId);return a?.status==='idle'&&!a.inbox.nextTurn.length&&!a.inbox.nextStep.length&&!s.pendingWake&&!s.rotationFence&&!s.rotationUncertain;};
 async function reconcile(){const p=pending.read();if(!p?.open)return {status:'none'};if(p.post_commit_guard_code)return {status:'uncertain',reason:'POST_COMMIT_WIRE_GUARD_REVIEW_REQUIRED'};if(!pending.stopped(p))return {status:'uncertain',reason:'PREVIOUS_WORKER_STOP_UNCONFIRMED'};const ports=await createPorts({reconcile:true});try{const out=await worker({mode:'reconcile_receipt',receipt:p,journal},ports.ports);if(['committed','kept_old'].includes(out.result.status))pending.close(out.result);return out.result;}finally{await ports.close();}}
 async function beforeInput(input){
  if(closed||busy)return {status:'skip',reason:'ROTATION_ENTRY_BUSY'};
  if(autoEnabled!==true)return {status:'skip',reason:'AUTO_DISABLED'};
  // Receipt comes from the actual core producer, not model-selected arguments.
  if(!core.isPreparedOwnerInput?.(input)||input.chatId!==ownerId||input.message.content.some(b=>b.type!=='text'))return {status:'skip',reason:'ACTUAL_OWNER_TEXT_INPUT_REQUIRED'};
  busy=true;let ports,controller,timer,oldAgent,summaryHandle;
  try{
   const recovery=await reconcile();if(recovery.status==='uncertain')return {status:'queued',reason:recovery.reason};
   if(!idle())return {status:'skip',reason:'OWNER_NOT_IDLE'};
   oldAgent=core.handles.get(ownerId).agent;const seq=oldAgent.session.seq,rev=revision(core,ownerId),binding=core.state(ownerId).binding;
   const current=()=>!closed&&!core.closed&&!core.store.data.paused&&core.handles.get(ownerId)?.agent===oldAgent&&oldAgent.session.seq===seq&&revision(core,ownerId)===rev&&core.state(ownerId).binding===binding&&core.isPreparedOwnerInput(input);
   const d=await dimensions();if(!current()||d.seq!==seq||d.session_sha256!==sha(oldAgent.session.id))return {status:'skip',reason:'NUMERIC_VIEW_CHANGED'};
   // No cancellation of unknown/common input: charge the actual new input only
   // to U, conservatively, using the same configured empirical meter family.
   const inputUpper=6*JSON.stringify(input.message).length;
   let measured={...d,reload_units_upper:d.reload_units_upper+inputUpper,reload_components:{...d.reload_components,actual_next_input_upper:inputUpper}};
   const decision=await advise(measured,clock());
   if(!current())return {status:'skip',reason:'ROTATION_VERSION_CHANGED'};
   if(decision.comparison_passes!==true)return {status:'skip',reason:decision.reason??'ECONOMIC_PERMISSION_MISSING'};
   const snapshot=await capture();check(current()&&snapshot.revision===rev,'ROTATION_SNAPSHOT_CHANGED');
   const digest=snapshotDigest(snapshot),operation='rotation-'+sha(ownerId+'\0'+snapshot.agent_id+'\0'+digest);
   controller=new AbortController();timer=setTimeout(()=>controller.abort(),90000);timer.unref?.();
   ports=await createPorts({snapshot,input,controller,current});
   const summaryKey=operation+'/summary',summaryId='xq-summary-'+sha(summaryKey).slice(0,32);
   const archiveId=sha(operation+'/archive');
   const projection=projectSummaryInput(snapshot,{canonicalMessages:oldAgent.session.deriveMessages(),previousHandoff:core.state(ownerId).rotationHandoff,archiveId});
   // The payload is the existing normalized producer, once per canonical ID.
   // If sizing differs from the frozen shadow, abort BEFORE a paid dispatch.
   const payloadUnits=Buffer.byteLength(JSON.stringify(projection.text),'utf8')-2;
   if(pending.read()?.operation_id===operation)return {status:'skip',reason:'DURABLE_OPERATION_ALREADY_ATTEMPTED'};
   // This is a real dormant summary Agent, not a fabricated future SDK view.
   // Local creation/assembly does not dispatch a provider request.
   summaryHandle=await hostCtx.agents.create({sessionId:summaryId,agentOptions:{...core.model,reasoningEffort:'off',maxTokens:1024},setup:async ctx=>{ctx.tools.restrict({allow:[]});ctx.tools.guard(()=> 'SUMMARY_NO_TOOLS');ctx.systemPrompt.section({name:'rotation-summary-only',order:400,text:SUMMARY_GUIDE});}});
   const summaryAssembly=await summaryHandle.agent.ctx.systemPrompt.assemble({scope:summaryHandle.agent,agent:summaryHandle.agent});
   check(summaryAssembly.tools.length===0,'SUMMARY_TOOLS_NOT_EMPTY');
   const summaryUpper=payloadUnits+6*JSON.stringify(renderPrompt(summaryAssembly)).length+d.framing_units_upper;
   measured={...measured,summary_input_units_upper:summaryUpper,summary_input_units_lower:payloadUnits};
   const actualDecision=await advise(measured,clock());check(current()&&actualDecision.comparison_passes===true,'ACTUAL_SUMMARY_SCOPE_NOT_ECONOMIC');
   ports.ports['summary.build']=async(s,a,key)=>{
    check(current()&&snapshotDigest(s)===digest&&a===archiveId&&key===summaryKey,'SUMMARY_SOURCE_CHANGED');
    const cached=pending.summaryResult(operation);if(cached)return cached;
    pending.summaryStarted(operation,summaryId);let h=summaryHandle,guard;
    try{
     guard=wireGuards.install(summaryId,createSummaryGuard({model,payload:projection.text,guide:SUMMARY_GUIDE,unitsUpper:summaryUpper,isCurrent:current}),controller.signal);
     h.agent.followup({id:'summary-'+sha(key),role:'user',content:[{type:'text',text:projection.text}],source:{kind:'owner-rotation-summary'}});
     check(await hostCtx.sessions.flush(h.agent.session)===true,'SUMMARY_INPUT_NOT_DURABLE');await h.agent.whenIdle();controller.signal.throwIfAborted();check(await hostCtx.sessions.flush(h.agent.session)===true,'SUMMARY_OUTPUT_NOT_DURABLE');
     const m=h.agent.session.deriveMessages().findLast(m=>m.role==='assistant');const value=JSON.parse(m?.content.filter(b=>b.type==='text').map(b=>b.text).join(''));
     check(typeof value.text==='string'&&value.text.length<=limits.summaryTextChars&&Array.isArray(value.evidence_ids)&&value.evidence_ids.every(id=>projection.metadata&&projection.text&&snapshot.transcript.some(r=>r[0]===id)),'SUMMARY_RESULT_INVALID');
     const result={text:value.text,evidence_ids:[...new Set(value.evidence_ids)],snapshot_digest:digest};check(JSON.stringify(result).length<=limits.summaryChars,'SUMMARY_INJECTION_LIMIT');
     pending.summaryComplete(operation,result);return result;
    }catch(error){error.uncertain=true;throw error;}finally{try{await h?.dispose();summaryHandle=null;guard?.close();}catch(error){guard?.deny();controller.abort();error.uncertain=true;throw error;}}
   };
   const create=ports.ports['session.create_dormant'];
   ports.ports['session.create_dormant']=async(payload,key)=>{
    check(current(),'ROTATION_VERSION_CHANGED');const h=JSON.parse(payload);const {summary,...fixed}=h;
    check(JSON.stringify(summary).length<=limits.summaryChars&&JSON.stringify(fixed).length<=limits.fixedHandoffChars,'ROTATION_HANDOFF_LIMIT');
    const created=await create(payload,key);
    // Guard registration happens before the coordinator's atomic route commit.
    await ports.installColdGuard(created,wireGuards,createColdGuard({model,input:input.message,handoff:payload,unitsUpper:measured.reload_units_upper,isCurrent:()=>core.state(ownerId).binding===binding&&core.state(ownerId).sessionId===created.agent_id}),controller,{unitsUpper:measured.reload_units_upper,input:input.message,renderPrompt,current});
    return created;
   };
   pending.begin({open:true,hostPid:process.pid,workerStopped:false,conversation_id:ownerId,agent_id:snapshot.agent_id,snapshot_digest:digest,input_sha256:sha(canonical(input.message)),operation_id:operation,started_at:clock(),completed_turns:snapshot.completed_turns,observed_tokens:snapshot.observed_tokens,cold_units_upper:measured.reload_units_upper});
   const result=await worker({mode:'execute_prechecked',snapshot,journal,decision:{snapshot_digest:digest,recommendation:'rotate_next_turn',L:actualDecision.L,U:actualDecision.U},summary_artifact_max_bytes:6*limits.summaryChars+4096},ports.ports);
   pending.stoppedNow();if(['committed','failed','kept_old'].includes(result.result.status))pending.close(result.result);
   last={...result.result,at:clock(),autoEnabled};return last;
  }catch(error){if(error.workerStopped===true)pending.stoppedNow();last={status:pending.read()?.open||core.state(ownerId).rotationUncertain?'queued':'skip',reason:/^[A-Z0-9_]+$/.test(error.message??'')?error.message:'ROTATION_EXECUTION_FAILED',at:clock(),autoEnabled};return last;}
  finally{clearTimeout(timer);try{await summaryHandle?.dispose();if(ports)await ports.close();}finally{busy=false;}}
 }
 return {beforeInput,reconcile,async recoverPending(){if(closed||busy||recovering)return {status:'skip',reason:'RECOVERY_BUSY'};recovering=true;try{const result=await reconcile();if(result.status!=='none')last={...last,recovery:result.status,recoveryReason:result.reason};return result;}finally{recovering=false;}},status:()=>({...last,busy,recovering,autoEnabled}),close(){closed=true;}};
}
