import test from 'node:test';import assert from 'node:assert/strict';
import {WeChatCore} from '../src/core.mjs';import {ReplyPermits} from '../src/reply-permits.mjs';
test('paused or closed core does not settle a completion callback',async()=>{
 for(const closed of [false,true]){
  const core={closed,store:{data:{paused:!closed}},serial:fn=>Promise.resolve().then(fn),state(){throw Error('STATE_READ_AFTER_CLOSE');}};
  assert.equal(await WeChatCore.prototype.completeWakeWithoutDecision.call(core,'synthetic',{}),false);
 }
});
test('secondary audit failure cannot produce unhandled rejection',async()=>{
 const state={replyPermits:{}};let handler;
 const core={state:()=>state,store:{save(){},audit(){throw Error('SYNTHETIC_AUDIT_UNAVAILABLE');}},async completeWakeWithoutDecision(){throw Error('SYNTHETIC_SETTLE_FAILURE');}};
 const permits=new ReplyPermits(core);const agent={session:{},inbox:{nextTurn:[]}};
 permits.issue('synthetic',{sourceId:'wake',nativeMessageId:'fixture',kind:'proactive',wakeId:'wake'});
 permits.attach('synthetic',{on(name,fn){handler=fn;}},agent);
 for(const [type,data]of [['turn/start',{turn:1}],['user/message',{id:'fixture'}],['turn/end',{turn:1,reason:{kind:'completed'}}]])handler(agent.session,{type,data});
 await new Promise(r=>setImmediate(r));assert.equal(permits.active.size,0);
});
