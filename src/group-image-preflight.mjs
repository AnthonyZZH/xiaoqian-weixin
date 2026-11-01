import crypto from 'node:crypto';

const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const check=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const fingerprint=m=>JSON.stringify(m);

/** Trusted host interface only. Neither tickets nor image permission are JSON inputs. */
export function createGroupImagePreflight({core,normalizeMessage,nativeIngest,groupId,decideTopic,topicIdleMs,clock=Date.now,ttlMs=15000}){
 check(typeof groupId==='string'&&groupId&&typeof decideTopic==='function'&&Number.isFinite(topicIdleMs)&&topicIdleMs>0,'EXISTING_GROUP_TEXT_POLICY_REQUIRED');
 check(core&&typeof normalizeMessage==='function'&&typeof nativeIngest==='function','GROUP_PREFLIGHT_DEPENDENCY_REQUIRED');
 check(Number.isFinite(ttlMs)&&ttlMs>0&&ttlMs<=15000,'GROUP_PREFLIGHT_TTL_INVALID');
 const chat=core.chat(groupId),binding=core.state(groupId).binding;
 check(chat.mode==='group'&&chat.owner!==true,'GROUP_BINDING_INVALID');
 const batches=new WeakMap();let closed=false;
 function active(){
  const s=core.state(groupId),c=core.chat(groupId);
  check(!closed&&!core.closed&&!core.store.data.paused,'GROUP_POLICY_UNAVAILABLE');
  check(c===chat&&c.mode==='group'&&c.owner!==true&&s.binding===binding,'GROUP_BINDING_CHANGED');
  return s;
 }
 function snapshot(s){return JSON.stringify([s.binding,s.sessionId,s.groupEpoch||0,s.topicEpoch||0,s.groupTopic??null,s.groupPaused===true]);}
 function revokeTopic(reason,s){
  s.groupEpoch=(s.groupEpoch||0)+1;
  for(const key of Object.keys(s.replyPermits||{}))core.permits.close(groupId,key,'topic-ended');
  s.addressedGrants={};s.replyPermit=null;s.pendingWake=null;
  const agent=core.handles.get(groupId)?.agent;agent?.cancel?.({kind:'user'});agent?.inbox?.clear?.();
  core.store.audit('GROUP_TOPIC_REVOKED',groupId,{reason});
 }
 function known(ticket){
  const row=ticket&&typeof ticket==='object'?batches.get(ticket):null;
  check(row,'GROUP_PREFLIGHT_UNKNOWN');const s=active();
  check(clock()<row.expiresAt&&snapshot(s)===row.scope,'GROUP_PREFLIGHT_STALE');
  check(row.original.every((m,i)=>fingerprint(m)===row.fingerprints[i]),'GROUP_PREFLIGHT_MESSAGE_CHANGED');
  return {row,s};
 }
 async function preflight(request){return core.serial(async()=>{
  check(request?.chatId===groupId&&Array.isArray(request.messages)&&request.messages.length<=200,'GROUP_PREFLIGHT_REQUEST_INVALID');
  const s=active(),before=snapshot(s),kept=[],ignored=[],images=new Map(),imageIds=new Set();s.addressedInputs??={};
  for(const raw of request.messages){
   let m;try{m=normalizeMessage(raw);}catch{kept.push(raw);continue;}
   if(m.role!=='user'){kept.push(raw);continue;}
   const key=hash(m.id);
   if(s.messages[key]){kept.push(raw);continue;}
   // Match native ingest's paused-group baseline path without capturing pixels.
   if(s.groupPaused){kept.push(raw);continue;}
   const decision=decideTopic(s,m,clock());
   if(decision.invalidate)revokeTopic(decision.reason,s);
   if(decision.allow){
    s.addressedInputs[key]=decision.topicId;kept.push(raw);
    if(!imageIds.has(m.id)){images.set(raw,{id:m.id,topicId:decision.topicId,claimed:false});imageIds.add(m.id);}
    core.store.audit('GROUP_TOPIC_INPUT_ALLOWED',groupId,{reason:decision.reason,inputHash:key});
   }else{
    if(!s.messages[key])s.messages[key]={status:'baseline',reason:decision.reason};ignored.push(m.id);
   }
  }
  const keys=Object.keys(s.addressedInputs);for(const key of keys.slice(0,Math.max(0,keys.length-512)))delete s.addressedInputs[key];
  core.store.save();
  const ticket=Object.freeze({}),original=[...request.messages];
  batches.set(ticket,{before,scope:snapshot(s),expiresAt:clock()+ttlMs,original,fingerprints:original.map(fingerprint),kept,ignored,images});
  return Object.freeze({ticket,messages:Object.freeze([...kept])});
 });}
 function allowsImage(ticket,message){
  const {row,s}=known(ticket),entry=row.images.get(message);
  check(!row.consumed,'GROUP_PREFLIGHT_CONSUMED');
  // This is routing permission, not proof of image presence. The caller checks
  // its trusted raw->normalized map; native image input authenticates raw pixels.
  return !!entry&&!entry.claimed&&entry.id===message.id&&!s.messages[hash(entry.id)]&&!s.groupPaused&&
   entry.topicId===s.groupTopic?.id&&clock()-s.groupTopic.lastAt<=topicIdleMs;
 }
 function claimImage(ticket,message){
  if(!allowsImage(ticket,message))return false;
  // Consume before awaiting capture; unknown capture must never retry this claim.
  batches.get(ticket).images.get(message).claimed=true;return true;
 }
 function hasClaimedImage(ticket,message){
  try{
   const {row,s}=known(ticket),entry=row.images.get(message);
   return !row.consumed&&entry?.claimed===true&&entry.id===message.id&&!s.messages[hash(entry.id)]&&!s.groupPaused&&
    entry.topicId===s.groupTopic?.id&&clock()-s.groupTopic.lastAt<=topicIdleMs;
  }catch{return false;}
 }
 async function consume(ticket,request){return core.serial(async()=>{
  const {row}=known(ticket);
  check(!row.consumed,'GROUP_PREFLIGHT_CONSUMED');
  check(request?.chatId===groupId&&Array.isArray(request.messages)&&request.messages.length===row.kept.length&&request.messages.every((m,i)=>m===row.kept[i]),'GROUP_PREFLIGHT_SCOPE_MISMATCH');
  row.consumed=true;
  // Invoked synchronously after awaited image content, immediately before
  // followup. Revalidate the whole batch, and permit each claimed image once.
  const groupImageGuard=message=>{
   try{
    const current=known(ticket),entry=current.row.images.get(message);
    if(!current.row.consumed||!entry?.claimed||entry.delivered||entry.id!==message.id||
      current.s.groupPaused||entry.topicId!==current.s.groupTopic?.id||clock()-current.s.groupTopic.lastAt>topicIdleMs)return false;
    entry.delivered=true;return true;
   }catch{return false;}
  };
  return {chatId:groupId,messages:[...row.kept],ignored:[...row.ignored],groupImageGuard};
 });}
 function install(){
  const previous=core.ingest;
  const wrapper=async function(request){
   if(request?.chatId!==groupId)return previous.call(this,request);
   const prepared=Object.hasOwn(request,'preflightTicket')?{ticket:request.preflightTicket,messages:request.messages}:await preflight(request);
   const filtered=await consume(prepared.ticket,{chatId:groupId,messages:prepared.messages});
   const {preflightTicket,...rest}=request;
   try{
    const answer=await nativeIngest.call(this,{...rest,messages:filtered.messages,groupImageGuard:filtered.groupImageGuard});
    answer.ackable.push(...filtered.ignored);return answer;
   }finally{batches.delete(prepared.ticket);}
  };
  wrapper.__xqGroupPolicyRevision='qwq-single-owner/v6b-image-preflight';core.ingest=wrapper;
  return ()=>{if(core.ingest===wrapper)core.ingest=previous;};
 }
 return Object.freeze({preflight,allowsImage,claimImage,hasClaimedImage,consume,install,close(){closed=true;}});
}
