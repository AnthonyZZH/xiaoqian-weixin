import crypto from 'node:crypto';
const hash=s=>crypto.createHash('sha256').update(String(s)).digest('hex');
const n=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const safeCode=v=>typeof v==='string'&&/^[A-Za-z0-9_./-]{1,100}$/.test(v)?v:null;
/** Metadata-only observer. Never derives messages, assembles a prompt, reads a
 * persona/ledger/file body, touches driver/UI, dispatches a model or switches. */
export function createNumericSampler({bridge,sourceCaps,libraryPolicy,clock=Date.now,maxEvents=256,initialNumeric,onUsage}={}){
 let cursor=0,lastAgent=null,usage=[],completed=0,hits=0,misses=0,lastKey=null,cached=null;
 function sample(){
  const {core,driver}=bridge,owner=[...core.chats.values()].find(c=>c.owner===true&&c.mode==='private');
  const h=owner&&core.handles.get(owner.id),s=owner&&core.store.data.chats[owner.id],agent=h?.agent;
  if(!agent)return {schema:'xq.rotation.numeric-shadow/v1',at:new Date(clock()).toISOString(),autoEnabled:false,decision:{recommendation:'hold',reason:'OWNER_AGENT_NOT_AVAILABLE'}};
  const session=agent.session,seq=n(session.seq),generation=n(session.surface?.contentGeneration);
  if(agent!==lastAgent){cursor=0;lastAgent=agent;usage=[];completed=0;lastKey=null;if(initialNumeric?.owner_session_sha256===hash(session.id)&&n(initialNumeric.seq)!==null&&initialNumeric.seq<=seq){cursor=initialNumeric.seq;usage=(initialNumeric.cached_numeric_usage??[]).slice(-8);completed=n(initialNumeric.completed_turns_observed)??0;}}
  const key=JSON.stringify([session.id,seq,generation,s?.binding,core.model?.provider,core.model?.model]);
  if(key!==lastKey||cursor<seq){
   misses++;const deadline=performance.now()+4;let count=0;
   while(cursor<seq&&count++<maxEvents&&performance.now()<deadline){
    const event=session.eventAt(cursor++);if(!event)continue;
    if(event.type==='assistant/message'){try{onUsage?.(event);}catch{}
     const u=event.data?.usage;
     if(u&&['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'].every(k=>n(u[k])!==null)){
      const source=event.data?.message?.source;
      usage.push({seq:n(event.seq),at_ms:n(event.time),provider:safeCode(source?.provider),model:safeCode(source?.model),hit:u.cacheReadTokens,miss:u.inputTokens,write:u.cacheWriteTokens,output:u.outputTokens});usage=usage.slice(-8);
     }
    }else if(event.type==='turn/end'&&event.data?.reason?.kind==='completed')completed++;
   }
   lastKey=key;
   const missing=['CURRENT_RETAINED_CONTEXT_NUMERIC_METER_UNAVAILABLE','CURRENT_SUMMARY_INPUT_NUMERIC_METER_UNAVAILABLE','GLOBAL_POLICY_TOOL_ENVELOPE_UPPER_UNDECLARED','SUMMARY_ARTIFACT_BYTE_CAP_NOT_BOUND','RETRIEVAL_LENGTH_AND_CALL_BOUND_NOT_BOUND','SAME_INPUT_BILLING_OR_ACTUAL_INPUT_NOT_BOUND','CURRENT_CALIBRATION_SOURCE_BINDING_NOT_REGISTERED','CURRENT_TARIFF_BINDING_NOT_REGISTERED'];
   if(cursor<seq)missing.unshift('NUMERIC_USAGE_SCAN_IN_PROGRESS');
   cached={owner_session_sha256:hash(session.id),owner_binding_sha256:hash(s?.binding||''),seq,surface_generation:generation,numeric_scanned_events:cursor,completed_turns_observed:completed,
    cached_numeric_usage:usage,missing,
    numeric_version_sha256:hash(JSON.stringify([key,cursor,completed,usage.map(v=>v.seq)]))};
  }else hits++;
  const read=driver?.readDiagnosticsStatus?.(),last=read?.last;
  return {schema:'xq.rotation.numeric-shadow/v1',at:new Date(clock()).toISOString(),hostPid:process.pid,autoEnabled:false,automatic_permission:false,mode:'conservative_interval_shadow',
   ...cached,cache:{hits,misses},source_caps:sourceCaps,library_policy_hints:libraryPolicy,
   safe_point_metadata:{agent_idle:agent.status==='idle',next_turn_count:n(agent.inbox?.nextTurn?.length),next_step_count:n(agent.inbox?.nextStep?.length),pending_wake:!!s?.pendingWake,fence:!!s?.rotationFence,uncertain:!!s?.rotationUncertain},
   health:{paused:core.store.data.paused===true,driver_paused:driver?.paused===true,closed:core.closed===true,ownerImages:bridge.mediaInputs?.autoImages===true,groupImages:bridge.mediaInputs?.groupImages===true,lastReadAt:typeof last?.at==='string'?last.at:null,lastReadOutcome:safeCode(last?.outcome),lastReadElapsedMs:n(last?.elapsed_ms)},
   decision:{recommendation:'hold',reason:cached.missing[0],missing:cached.missing,comparison:'L >= U',L:null,U:null,guaranteed_saving:false,ordinary_chat_continues:true},
   effects:{modelCalls:0,libraryCalls:0,driverCalls:0,sessionSwitches:0,newBodyReads:0}};
 }
 return Object.freeze({sample});
}

