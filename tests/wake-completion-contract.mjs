
import assert from 'node:assert/strict';
import {WeChatCore} from '../src/core.mjs';
import {ReplyPermits} from '../src/reply-permits.mjs';
import {OwnerDecisionBridge,expireOwnerWake} from '../src/owner-decision-bridge.mjs';
async function fixture(){
 let handler,finishes=0,decision;
 const state={pendingWake:{wakeId:'w'},messages:{},deliveries:{},replyPermits:{}};
 const core={state:()=>state,store:{save(){},audit(){}},chain:Promise.resolve()};
 core.serial=fn=>{const job=core.chain.then(fn);core.chain=job.catch(()=>{});return job};
 core.completeWakeWithoutDecision=(...args)=>WeChatCore.prototype.completeWakeWithoutDecision.call(core,...args);
 core.permits=new ReplyPermits(core);
 const bridge=new OwnerDecisionBridge({async call(op,args){assert.equal(op,'schedule_finish');finishes++;decision=args.decision;return {status:'ok',finished:true}}},{onTimeout:e=>expireOwnerWake(core,e)});
 bridge.resume();core.initiative=bridge;
 const claim={eventId:'w',token:'t',timer:null};bridge.claims.set('owner',claim);
 const agent={session:{},inbox:{nextTurn:[]}};
 const key=core.permits.issue('owner',{sourceId:'w',nativeMessageId:'m',kind:'proactive',wakeId:'w'});
 const other=core.permits.issue('owner',{sourceId:'normal',nativeMessageId:'normal',kind:'incoming'});
 core.permits.attach('owner',{on(name,fn){handler=fn}},agent);
 const emit=(type,data)=>handler(agent.session,{type,data});
 emit('turn/start',{turn:8});emit('user/message',{id:'m'});
 const end=()=>emit('turn/end',{turn:8,reason:{kind:'completed'}});
 return {core,state,bridge,claim,key,other,end,emit,get finishes(){return finishes},get decision(){return decision}};
}
for(const mode of ['no-tool','reply','skip','timeout','completed-first','timeout-first']){
 const f=await fixture();
 if(mode==='reply'||mode==='skip'){
  f.state.replyPermits[f.key].remaining=0;f.state.pendingWake=null;
  f.bridge.claims.delete('owner');f.end();await f.core.chain;
  assert.equal(f.finishes,0);
 }else if(mode==='timeout'||mode==='timeout-first'){
  await f.bridge.expire({chatId:'owner',wakeId:'w'},f.claim);
  f.end();await f.core.chain;assert.equal(f.finishes,1);assert.equal(f.decision,'decision_timeout');
 }else{
  f.end();await f.core.chain;
  await f.bridge.expire({chatId:'owner',wakeId:'w'},f.claim);
  f.end();await f.core.chain;assert.equal(f.finishes,1);assert.equal(f.decision,'completed_without_decision');
 }
 assert.equal(f.state.replyPermits[f.other].status,'open');
 f.bridge.close();console.log('PASS',mode);
}
