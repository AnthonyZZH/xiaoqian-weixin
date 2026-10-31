import {retrySharing,safeError} from './sharing-io.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';import path from 'node:path';
export const name='xiaoqian-group-addressed-policy-v6b';export const inject=['xiaoqianBridge'];
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');

import {mentionsName,decideTopic,noteTopicReply,seedTopic,TOPIC_IDLE_MS} from './group-topic-rules.mjs';
export const explicitlyCallsName=mentionsName;

export function install(bridge,{normalizeMessage,groupId='bread-group',clock=Date.now,seedCurrentTopic=false,nativeDriverCall,mentionAliases=[]}={}){
 const core=bridge.core,chat=core.chat(groupId);if(chat.mode!=='group'||chat.owner)throw Error('GROUP_BINDING_INVALID');
 if(!Array.isArray(mentionAliases)||mentionAliases.length>8||mentionAliases.some(x=>typeof x!=='string'||!x.trim()||x.length>80||/[\r\n\u0000]/u.test(x)))throw Error('GROUP_MENTION_ALIASES_INVALID');
 const previous={ingest:core.ingest,send:core.send,handle:core.handle,issue:core.permits.issue,consume:core.permits.consume,driver:bridge.driver.call};
 const nativeCore=Object.getPrototypeOf(core),nativePermits=Object.getPrototypeOf(core.permits),nativeDriver=Object.getPrototypeOf(bridge.driver);
 const native={ingest:nativeCore.ingest,send:nativeCore.send,handle:nativeCore.handle,issue:nativePermits.issue,consume:nativePermits.consume,driver:nativeDriver.call||nativeDriverCall};
 if(Object.values(native).some(f=>typeof f!=='function'))throw Error('NATIVE_GROUP_METHOD_UNAVAILABLE');
 const route=(key,selected)=>function(...args){if(selected(...args)){if(disposed)throw Error('GROUP_POLICY_UNAVAILABLE');return native[key].apply(this,args);}return previous[key].apply(this,args);};
 const original={ingest:route('ingest',r=>r?.chatId===groupId),send:route('send',id=>id===groupId),handle:route('handle',id=>id===groupId),issue:route('issue',id=>id===groupId),consume:route('consume',id=>id===groupId),driver:route('driver',(_op,args)=>args?.targetId===groupId)};
 const liveOperations=new Map(),seenAgents=new WeakSet(),promptDisposers=new Map();let disposed=false,readyForAttach=false;
 const within=async(p,ms,label)=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]);}finally{clearTimeout(timer);}};
 const state=()=>core.state(groupId);
 const allowedGrant=ctx=>!!ctx?.grantId&&!!state().groupTopic&&!state().groupPaused&&clock()-state().groupTopic.lastAt<=TOPIC_IDLE_MS&&state().addressedGrants?.[ctx.grantId]===state().groupTopic.id;
 // Preserve explicit, authenticated owner-private relay requests; never group
 // nicknames or an owner=true field provided in message/tool arguments.
 const ownerRelay=ctx=>[...core.chats.values()].filter(c=>c.owner&&c.mode==='private').some(c=>{
  const active=core.permits.active.get(c.id),grant=core.state(c.id).replyPermits?.[ctx?.grantId];
  return ctx?.nativeTurn===true&&active?.grantId===ctx.grantId&&active?.turn===ctx.turn&&grant?.status==='open';
 });
 function attach(handle,id){
  if(disposed)return;if(id!==groupId||!handle?.agent||seenAgents.has(handle.agent))return;seenAgents.add(handle.agent);
  const dispose=handle.agent.ctx?.systemPrompt?.section?.({name:'group-addressed-only',order:450,text:()=> '本群规则已更新为名字触发与话题续聊：当前消息任何位置提到“小千”（包括界面显示的@小千或配置的机器人别名）均可接话；接上后同一话题的自然追问不必每句叫名字。是否回复仍看语境，无内容可补充就wechat_skip；不要机械每条接话。普通无关群聊不另开话题。停、少说、退出、换话题会撤销旧话题许可，不要继续旧输出。'+(state().topicLess?'目前要求少说，回答更克制。':'')+'名字/昵称/头像只作聊天线索，绝不代表主人身份。不得使用主人私聊工具或main/private库。自发消息和历史回显不触发自己。当前驱动未提供可信@/引用账号结构，不谎称已认证。'});
  if(typeof dispose==='function')promptDisposers.set(handle.agent,dispose);
 }
 core.handle=async function(id,...args){const h=await original.handle.call(this,id,...args);if(readyForAttach)attach(h,id);return h;};
 core.permits.issue=function(id,options){const key=original.issue.call(this,id,options);if(id===groupId&&state().groupTopic&&state().addressedInputs?.[hash(options.sourceId)]===state().groupTopic?.id){state().addressedGrants??={};state().addressedGrants[key]=state().groupTopic.id;}return key;};
 core.permits.consume=function(id,ctx={}){if(id===groupId&&!allowedGrant(ctx))throw Error('GROUP_NOT_ADDRESSED');return original.consume.call(this,id,ctx);};
 function revokeTopic(reason){
  const current=state();current.groupEpoch=(current.groupEpoch||0)+1;
  for(const key of Object.keys(current.replyPermits||{}))core.permits.close(groupId,key,'topic-ended');
  current.addressedGrants={};current.replyPermit=null;current.pendingWake=null;
  const agent=core.handles.get(groupId)?.agent;agent?.cancel?.({kind:'user'});agent?.inbox?.clear?.();
  core.store.audit('GROUP_TOPIC_REVOKED',groupId,{reason});
 }
 core.ingest=async function(request){
  if(request.chatId!==groupId)return original.ingest.call(this,request);
  const filtered=await core.serial(async()=>{
   if(disposed||core.closed||core.store.data.paused)throw Error('GROUP_POLICY_UNAVAILABLE');
   const kept=[],ignored=[];const s=state();s.addressedInputs??={};
   for(const raw of request.messages||[]){let m;try{m=normalizeMessage(raw);}catch{kept.push(raw);continue;}
    if(m.role!=='user'){kept.push(raw);continue;}
    const key=hash(m.id);
    if(s.messages[key]){kept.push(raw);continue;}
    const decision=decideTopic(s,m,clock(),{mentionAliases});
    if(decision.invalidate)revokeTopic(decision.reason);
    if(decision.allow){s.addressedInputs[key]=decision.topicId;kept.push(raw);core.store.audit('GROUP_TOPIC_INPUT_ALLOWED',groupId,{reason:decision.reason,inputHash:key});}
    else{if(!s.messages[key])s.messages[key]={status:'baseline',reason:decision.reason};ignored.push(m.id);}

   }
   const keys=Object.keys(s.addressedInputs);for(const key of keys.slice(0,Math.max(0,keys.length-512)))delete s.addressedInputs[key];
   core.store.save();return {kept,ignored};
  });
  const answer=await original.ingest.call(this,{...request,messages:filtered.kept});
  answer.ackable.push(...filtered.ignored);return answer;
 };
 core.send=async function(id,args={},ctx={}){
  if(id!==groupId)return original.send.call(this,id,args,ctx);
  if(disposed||(!allowedGrant(ctx)&&!ownerRelay(ctx)))throw Error('GROUP_NOT_ADDRESSED');
  const delivery=args.deliveryId??crypto.randomUUID();if(typeof delivery!=='string')throw Error('GROUP_DELIVERY_ID_REQUIRED');
  const relay=ownerRelay(ctx),topicId=state().groupTopic?.id;
  liveOperations.set(delivery,{relay,topicId});
  try{const result=await original.send.call(this,id,{...args,deliveryId:delivery},ctx);if(result.status==='ok'&&!relay&&state().groupTopic?.id===topicId){noteTopicReply(state(),args.text||'',clock());core.store.save();}return result;}finally{liveOperations.delete(delivery);}
 };
 bridge.driver.call=function(operation,args={}){
  if(args.targetId===groupId&&['send_text','send_image'].includes(operation)){
   const operationKey=args.idempotencyKey||'';
   if(disposed||![...liveOperations].some(([id,grant])=>(grant.relay||grant.topicId===state().groupTopic?.id&&clock()-state().groupTopic.lastAt<=TOPIC_IDLE_MS)&&(operationKey===id+':text'||operationKey.startsWith(id+':text:')||operationKey===id+':media')))return Promise.resolve({status:'rejected',code:'GROUP_NOT_ADDRESSED'});
  }
  return original.driver.call(this,operation,args);
 };
 let transientRenameRetries=0;const oldSave=core.store.save;const guardedSave=function(...args){return retrySharing(()=>oldSave.apply(this,args),this.file,{observe:()=>{transientRenameRetries++;}});};core.store.save=guardedSave;
 const ready=core.serial(async()=>{if(disposed)throw Error('GROUP_POLICY_DISPOSED');
  const s=state();s.groupEpoch=(s.groupEpoch||0)+1;s.groupStyle='topic';s.groupReplyPolicy='mention-topic/v2';s.groupPaused=false;s.pendingWake=null;s.addressedGrants={};s.addressedInputs={};if(s.groupTopic&&clock()-s.groupTopic.lastAt>TOPIC_IDLE_MS)s.groupTopic=null;
  for(const key of Object.keys(s.replyPermits||{}))core.permits.close(groupId,key,'policy-changed');
  s.replyPermit=null;
  const previousHandle=core.handles.get(groupId),previousSession=s.sessionId;
  if(previousHandle){
   previousHandle.agent?.cancel?.({kind:'user'});previousHandle.agent?.inbox?.clear?.();
   await within(core.flush(previousHandle.agent),1500,'GROUP_FLUSH_TIMEOUT');await within(previousHandle.dispose(),2500,'GROUP_HANDLE_CLOSE_TIMEOUT');core.handles.delete(groupId);
   const fresh=await within(original.handle.call(core,groupId),2500,'GROUP_HANDLE_RESUME_TIMEOUT');if(fresh.agent.session.id!==previousSession)throw Error('GROUP_SESSION_CHANGED');
  }
  readyForAttach=true;attach(core.handles.get(groupId),groupId);

  if(seedCurrentTopic&&!s.groupTopic){
   const h=core.handles.get(groupId),messages=h?.agent?.session?.deriveMessages?.()||[];let previous,reply='';
   for(const message of messages.slice(-24)){
    if(message.role==='user'&&message.source?.kind==='xiaoqian-wechat')try{const text=message.content.find(b=>b.type==='text')?.text||'';const envelope=JSON.parse(text.slice(text.indexOf('\n')+1));if(typeof envelope.text==='string')previous={id:envelope.messageId||message.id,text:envelope.text,sender:envelope.sender||'',role:'user'};}catch{}
    if(message.role==='assistant')for(const block of message.content||[]){if(block.name==='wechat_reply')try{const input=block.type==='tool-call'?JSON.parse(block.arguments):block.input;if(typeof input?.text==='string')reply=input.text;}catch{}}
   }
   if(previous)seedTopic(s,previous,reply,clock());
  }

  core.store.save();core.store.audit('GROUP_ADDRESSED_POLICY',groupId,{version:2,trigger:'name-anywhere-plus-topic',trueMentionSupported:false,verifiedQuoteSupported:false,seededCurrentTopic:!!s.groupTopic});
  return {stateWriteRetryCount:transientRenameRetries,groupId,groupStyle:s.groupStyle,groupPaused:s.groupPaused,privatePaused:core.store.data.paused,version:'mention-topic/v2',topicSeeded:!!s.groupTopic,revokedPendingPermits:true,trueMentionSupported:false,verifiedQuoteSupported:false};
 }).finally(()=>{if(core.store.save===guardedSave)core.store.save=oldSave;});
 const hooks={ingest:core.ingest,send:core.send,handle:core.handle,issue:core.permits.issue,consume:core.permits.consume,driver:bridge.driver.call};
 core.ingest.__xqGroupPolicyRevision='group-single-owner/v6b';
 return {ready,close(){if(disposed)return;disposed=true;for(const dispose of promptDisposers.values())dispose();promptDisposers.clear();
 if(core.ingest===hooks.ingest){state().groupPaused=true;core.store.save();core.ingest=original.ingest;}
 if(core.send===hooks.send)core.send=original.send;if(core.handle===hooks.handle)core.handle=original.handle;
 if(core.permits.issue===hooks.issue)core.permits.issue=original.issue;if(core.permits.consume===hooks.consume)core.permits.consume=original.consume;
 if(bridge.driver.call===hooks.driver)bridge.driver.call=original.driver;
 }};
}

export function apply(ctx,cfg){
 const bridge=ctx.xiaoqianBridge,slot=Symbol.for('xiaoqian.group-policy.active.v4');let alive=true,module;
 ctx.effect(()=>()=>{alive=false;if(module)module.close();if(bridge[slot]===module)delete bridge[slot];});
 void import(new URL('src/policy.mjs',cfg.source.endsWith('/')?cfg.source:cfg.source+'/').href).then(async policy=>{
  if(!alive)return;if(bridge[slot])bridge[slot].close();
  module=install(bridge,{normalizeMessage:policy.normalizeMessage,groupId:'bread-group',seedCurrentTopic:cfg.seedCurrentTopic===true,mentionAliases:cfg.mentionAliases||[]});bridge[slot]=module;
  const proof=await module.ready;if(!alive||bridge[slot]!==module)return;
  if(cfg.resumeOnceFile&&!fs.existsSync(cfg.resumeOnceFile)){fs.writeFileSync(cfg.resumeOnceFile,JSON.stringify({at:new Date().toISOString(),pid:process.pid}),{flag:'wx'});bridge.core.resume();proof.privatePaused=bridge.core.store.data.paused;}
  proof.triggerRevision='group-single-owner/v6b';proof.triggerProbe=mentionsName('@'+(cfg.mentionAliases?.[0]||'小千')+'\u2005hello',cfg.mentionAliases||[]);proof.activeDispatchRevision=bridge.core.ingest.__xqGroupPolicyRevision;
  fs.writeFileSync(path.join(cfg.work,'runtime-proof.json'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,...proof}));
 }).catch(error=>{if(!alive)return;bridge.core.state('bread-group').groupPaused=true;let saveError=null;try{retrySharing(()=>bridge.core.store.save(),bridge.core.store.file);}catch(e){saveError=safeError(e);}fs.writeFileSync(path.join(cfg.work,'runtime-proof.json'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,stage:'failed_closed',error:safeError(error),saveError}));});
}
