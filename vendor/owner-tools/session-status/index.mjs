const ERRORS={SEND_UNCONFIRMED:'发送结果不确定，需要核对该操作；不表示整个会话失败。',PERSISTENCE_NOT_CONFIRMED:'持久化未确认。',DRIVER_ACK_FAILED:'驱动ACK失败。',MARKET_PROCESS_TIMEOUT:'市场读取超时。',MARKET_TOTAL_TIMEOUT:'市场读取超时。',COMMUNITY_CATALOG_UNAVAILABLE:'市场目录当前不可用。',MANAGER_UNAVAILABLE:'原生管理服务不可用。',MCP_START_FAILED:'MCP启动失败。',MCP_START_TIMEOUT:'MCP启动超时。',TOOL_OUTPUT_INVALID:'工具结果未通过输出校验。',TOOL_CANCELLED:'工具已取消。',TASK_FAILED:'任务已报告失败。',TASK_RESULT_NOT_DURABLE:'任务结果未确认持久化。',NETWORK_TIMEOUT:'网络等待超时。',APPROVAL_UNAVAILABLE_USE_WEB:'审批通道不可用。',APPROVAL_REJECTED_USE_WEB:'审批未获允许。',APPROVAL_CANCELLED_USE_WEB:'审批已取消。',UNCLASSIFIED_ERROR:'记录存在错误；原始信息已隐藏，请由宿主检查。'};
const secret=/^(sk-|gh[pousr]_|github_pat_|Bearer\b|AKIA)/i;
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v)&&!secret.test(v)?v:null;
const tool=v=>id(v);
const epoch=v=>{const n=typeof v==='number'?v:typeof v==='string'?Date.parse(v):NaN;return Number.isFinite(n)&&n>=0&&n<=8640000000000000?n:null;};
const iso=v=>{const n=epoch(v);return n===null?null:new Date(n).toISOString();};
const failure=value=>{const proposed=value?.code||value?.name;const code=Object.hasOwn(ERRORS,proposed)?proposed:proposed==='ToolOutputError'?'TOOL_OUTPUT_INVALID':'UNCLASSIFIED_ERROR';return{code,summary:ERRORS[code]};};

/** No message contents, tool arguments or error messages are accessed here. */
export function summarizeEvents(session,{maxEvents=2048}={}){
 const result={startedAt:null,lastProgressAt:null,phase:null,currentTools:[],pendingApproval:null,pendingApprovalCountKnown:0,lastOutcome:null,lastError:null,eventWindowComplete:true};
 if(!session||!Number.isSafeInteger(session.seq)||typeof session.eventAt!=='function'){result.eventWindowComplete=false;return result;}
 const start=Math.max(0,session.seq-maxEvents);result.eventWindowComplete=start===0;
 const calls=new Map(),approvals=new Set();let turnStartSeen=false;
 for(let i=start;i<session.seq;i++){
  const e=session.eventAt(i);if(!e)continue;const d=e.data||{},at=iso(e.time);
  if(e.type==='turn/start'){turnStartSeen=true;calls.clear();approvals.clear();result.startedAt=at;result.phase='model';result.lastOutcome=null;}
  else if(e.type==='step/start')result.phase='model';
  else if(e.type==='tool/call'){const name=tool(d.name);if(name&&id(d.callId))calls.set(d.callId,name);result.phase='tool';}
  else if(e.type==='tool/result'){
   calls.delete(d.message?.callId);
   if(d.message?.isError===true)result.lastError={...failure(d.error),at};
   if(!calls.size)result.phase='model';
  }else if(e.type==='approval/asked'){if(id(d.id))approvals.add(d.id);result.phase='approval';}
  else if(e.type==='approval/decided'){approvals.delete(d.id);result.phase=calls.size?'tool':'model';}
  else if(e.type==='turn/end'){
   calls.clear();approvals.clear();result.phase='idle';
   const kind=d.reason?.kind;result.lastOutcome=kind==='completed'?'completed':['aborted','cancelled'].includes(kind)?'cancelled':['error','failed'].includes(kind)?'failed':'unknown';
   if(result.lastOutcome==='failed')result.lastError={...failure(d.reason),at};
  }
  if(['turn/start','turn/end','step/start','step/end','tool/call','tool/result','approval/asked','approval/decided','agent/inbox/spliced','assistant/message'].includes(e.type)&&at)result.lastProgressAt=at;
 }
 result.currentTools=[...new Set(calls.values())].slice(0,20);result.pendingApprovalCountKnown=approvals.size;
 result.pendingApproval=approvals.size>0?true:(result.eventWindowComplete||turnStartSeen)?false:null;
 return result;
}

/** Optional live progress; ignores stream frame data and never stores prompt text. */
export function createProgressObserver({clock=Date.now}={}){
 const records=new WeakMap();
 return{attach(ctx,agent){if(records.has(agent))return;const r={lastProgressAt:null,lastError:null};records.set(agent,r);
  for(const event of ['agent/status','agent/assistant-stream','agent/inbox/inserted','agent/inbox/claimed'])ctx.on(event,()=>{r.lastProgressAt=iso(clock());});
  ctx.on('agent/error',payload=>{r.lastProgressAt=iso(clock());r.lastError={...failure(payload?.error),at:r.lastProgressAt};});
 },get(agent){const r=records.get(agent);return r?{...r}:null;}};
}

export function sessionStatusDto(row,{now=Date.now(),staleMs=120000,progressWarningMs=120000,observer=null,includeDisplayNames=false}={}){
 const observed=epoch(row.observedAt),age=observed===null?null:Math.max(0,now-observed),stale=observed===null||observed>now+5000||age>staleMs;
 const agent=row.agent,events=summarizeEvents(agent?.session),progress=agent&&observer?.get(agent);
 const metadataLoaded=row.loaded===true;
 let queueLength=Number.isSafeInteger(row.queueLength)&&row.queueLength>=0&&row.queueLength<=100000?row.queueLength:null,engineState=['running','idle'].includes(row.engineState)?row.engineState:null,sourceError=null;
 if(agent){try{engineState=['running','idle'].includes(agent.status)?agent.status:null;}catch{sourceError='RUNTIME_STATUS_UNAVAILABLE';}
  try{const a=agent.inbox?.nextTurn,b=agent.inbox?.nextStep;if(Array.isArray(a)&&Array.isArray(b))queueLength=a.length+b.length;}catch{sourceError='INBOX_UNAVAILABLE';}}
 const durable=row.persisted||{},count=(value,states)=>Object.values(value||{}).filter(v=>states.includes(v?.status)).length;
 const unknownSends=count(durable.deliveries,['unknown']),pendingSends=count(durable.deliveries,['sending']),unknownInputs=count(durable.messages,['unknown']),pendingInputs=count(durable.messages,['accepting']);
 const held=Object.keys(durable.identityHeld||{}).length,deferred=Number.isSafeInteger(durable.deferredSummary?.count)?durable.deferredSummary.count:0;
 const blockers=[];const add=(code,scope)=>blockers.push({code,scope});
 if(row.paused)add('PAUSED','session');if(stale)add('OBSERVATION_STALE','observation');if(!agent&&!metadataLoaded&&!row.terminal)add('SESSION_NOT_LOADED','observation');
 if(events.pendingApproval)add('WAITING_OWNER_APPROVAL','session');if(durable.rotationFence)add('ROTATION_QUEUED','session');if(durable.rotationUncertain)add('ROTATION_UNCERTAIN','session');
 if(unknownSends)add('SEND_UNKNOWN_RECONCILIATION','operation');if(unknownInputs)add('INBOUND_ACCEPTANCE_UNKNOWN','input');if(held||deferred)add('INPUT_VERIFICATION_PENDING','input');
 if(sourceError)add(sourceError,'observation');
 let known=engineState||(['running','idle','queued','paused','failed','unknown'].includes(row.knownState)?row.knownState:'unknown');if(queueLength>0&&known==='idle')known='queued';if(row.paused)known='paused';
 let state=stale?'unknown':known;if(!['running','idle','queued','paused','failed','unknown'].includes(state))state='unknown';
 let lastProgressAt=events.lastProgressAt||row.lastProgressAt||null;
 if(progress?.lastProgressAt&&(!lastProgressAt||epoch(progress.lastProgressAt)>epoch(lastProgressAt)))lastProgressAt=progress.lastProgressAt;
 const progressAt=epoch(lastProgressAt),delayed=state==='running'&&progressAt!==null&&now-progressAt>progressWarningMs;
 if(delayed)add('NO_RECENT_PROGRESS_EVIDENCE','observation');
 let phase=events.pendingApproval?'approval':events.currentTools.length?'tool':events.phase||(['model','tool','approval','queued','idle','task','unknown'].includes(row.phase)?row.phase:'unknown');if(state==='queued')phase='queued';
 const title=includeDisplayNames&&typeof row.displayName==='string'&&!/[\r\n]|sk-[A-Za-z0-9]{16,}|Bearer\s|github_pat_/i.test(row.displayName)?row.displayName.slice(0,100):null;
 const outcome=['completed','cancelled','failed','unknown'].includes(row.lastOutcome)?row.lastOutcome:events.lastOutcome;
 return{id:id(row.id),chatId:id(row.chatId),sessionId:id(row.sessionId),kind:['chat','native-task','long-task'].includes(row.kind)?row.kind:'chat',displayName:title,state,lastKnownState:known,engineState,phase:stale?'unknown':phase,lastKnownPhase:phase,currentTools:stale?[]:events.currentTools,lastKnownTools:events.currentTools,loaded:!!agent||metadataLoaded,observedAt:iso(row.observedAt),observationAgeSeconds:age===null?null:Math.round(age/1000),stale,startedAt:events.startedAt||iso(row.startedAt),lastProgressAt:iso(lastProgressAt),progressAgeSeconds:progressAt===null?null:Math.max(0,Math.round((now-progressAt)/1000)),progressDelayed:delayed,queueLength,pendingApproval:stale?null:events.pendingApproval,pendingApprovalCountKnown:events.pendingApprovalCountKnown,pendingWake:!!durable.pendingWake,unknownSends,pendingSends,unknownInputs,pendingInputs,heldInputs:held,deferredInputs:deferred,lastOutcome:outcome,lastError:progress?.lastError||events.lastError||(row.lastError?failure(row.lastError):null),eventWindowComplete:events.eventWindowComplete,blockers};
}

export function createOwnerSessionStatus({getManagedSessions,isCurrentOwner,clock=Date.now,observer=null,staleMs=120000,includeDisplayNames=false}={}){
 if(typeof getManagedSessions!=='function'||typeof isCurrentOwner!=='function')throw Error('TRUSTED_SESSION_SOURCE_REQUIRED');
 return{bind({agent,bindingId}){let revoked=false;const auth=async exec=>{if(revoked||exec?.agent!==agent||(await isCurrentOwner({agent,bindingId}))!==true)throw Error('OWNER_ONLY');if(exec.signal?.aborted)throw Error('CANCELLED');};
 const execute=async(args={},exec)=>{await auth(exec);let source;try{source=await getManagedSessions();}catch{throw Error('STATUS_SOURCE_UNAVAILABLE');}await auth(exec);const rows=Array.isArray(source)?source:source?.rows;
  if(!Array.isArray(rows)||rows.length>2000)throw Error('MANAGED_SESSION_SOURCE_INVALID');
  const filtered=args.chatId?rows.filter(r=>r.chatId===args.chatId):rows;if(args.chatId&&!filtered.length)throw Error('SESSION_NOT_MANAGED');
  const offset=args.offset??0,limit=args.limit??50;if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('PAGE_INVALID');
  const now=clock(),items=filtered.slice(offset,offset+limit).map(row=>{try{return sessionStatusDto(row,{now,observer,staleMs,includeDisplayNames});}catch{const fallback=sessionStatusDto({id:row.id,chatId:row.chatId,sessionId:row.sessionId,kind:row.kind,observedAt:null,lastError:{code:'UNCLASSIFIED_ERROR'}},{now});fallback.blockers.push({code:'SESSION_OBSERVATION_UNAVAILABLE',scope:'observation'});return fallback;}});await auth(exec);
  const coverage=source.coverage?{chatRegistry:source.coverage.chatRegistry===true,legacyNativeTasks:source.coverage.legacyNativeTasks===true,longTaskRootConfigured:source.coverage.longTaskRootConfigured===true,extraRegistryConfigured:source.coverage.extraRegistryConfigured===true,isolatedTaskRegistry:source.coverage.isolatedTaskRegistry===true,longTaskFileScanSuppressed:source.coverage.longTaskFileScanSuppressed===true}:null;
  return{scope:'xiaoqian-registered-sessions-only',readOnly:true,asOf:iso(now),total:filtered.length,offset,nextOffset:offset+items.length<filtered.length?offset+items.length:null,coverage,sessions:items};
 };
 return{execute,revoke(){revoked=true},register(ctx,defineTool){ctx.effect?.(()=>()=>{revoked=true;});ctx.tools.register(defineTool({name:'owner_sessions_status',description:'只读查看小千受管会话状态、阶段、队列和阻塞元数据。缺少或过期观测标为unknown；不会读取聊天正文、执行取消或改变权限。',parameters:{chatId:{type:'string',description:'可选：仅筛选已注册聊天ID'},offset:{type:'number'},limit:{type:'number'}},output:{schema:{type:'json'},render:(_a,r)=>[{type:'text',text:JSON.stringify(r)}]},execute}));}};
 }};
}
