import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {pathToFileURL} from 'node:url';
import {WeChatCore} from '../src/core.mjs';import {OwnerDecisionBridge,expireOwnerWake} from '../src/owner-decision-bridge.mjs';
const native='C:/xiaoqian/app/dsh/node_modules/@deepseek-ai/';
const load=name=>import(pathToFileURL(native+name+'/lib/index.js').href);
const {Context}=await load('cordis'),{LlmAdapter}=await load('dsh-llm');
let offlineTurns=0;
class Offline extends LlmAdapter{
 async*stream(){offlineTurns++;yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:'Synthetic completed turn without a tool.'};yield{type:'block-end',index:0,block:{type:'text',text:'Synthetic completed turn without a tool.'}};yield{type:'finish',reason:{kind:'stop'}};}
}
const until=async fn=>{const end=Date.now()+5000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('BOUNDED_NATIVE_TEST_TIMEOUT');};
test('actual rc4 Agent emits matching completed turn; settles only its wake once',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'xq-wake-native-synthetic-')),ctx=new Context(),fibers=[],events=[],finishes=[];
 let core,polled=false;const fake={resume(){},pause(){},async close(){},async call(op,args){
  if(op==='schedule_poll'){if(polled)return{status:'ok',events:[]};polled=true;return{status:'ok',events:[{chat_id:'owner',event_id:'synthetic-wake',idle_minutes:5,unanswered:0}]};}
  if(op==='schedule_claim')return{status:'ok',claim:{token:'synthetic-token'}};
  if(op==='schedule_finish'){finishes.push(args);return{status:'ok',finished:true};}
  throw Error('FORBIDDEN_NATIVE_TEST_EFFECT:'+op);
 }};
 const initiative=new OwnerDecisionBridge(fake,{onTimeout:e=>expireOwnerWake(core,e),setTimer:()=>({synthetic:true}),clearTimer(){}});
 try{
  for(const name of ['dsh-system-prompt','dsh-session','dsh-agent','dsh-llm','dsh-tools','dsh-session-projection','dsh-agent-loop'])fibers.push(ctx.plugin((await load(name)).default,{}));
  fibers.push(ctx.plugin(await load('dsh-session-persistence-jsonl'),{root:path.join(tmp,'sessions'),compression:'none'}));
  fibers.push(ctx.plugin({inject:['llm'],apply(c){c.llm.registerAdapter(['offline-wake-contract'],new Offline());}},{}));
  for(const f of fibers)await f.await();
  ctx.on('session/event',(session,event)=>{if(['turn/start','user/message','turn/end'].includes(event.type))events.push({session:session.id,type:event.type,turn:event.data.turn,id:event.data.id,reason:event.data.reason?.kind});});
  const bridge=ctx.plugin({inject:['agents','sessions','tools'],apply(c){core=new WeChatCore({stateDir:path.join(tmp,'bridge'),chats:[{id:'owner',title:'Synthetic owner',mode:'private',owner:true}],agents:c.agents,sessions:c.sessions,driver:fake,initiative,capabilities:{ownerNativeTools:[]},model:{provider:'offline-wake-contract',model:'fixture'}});}},{});
  fibers.push(bridge);await bridge.await();
  const untouched=core.permits.issue('owner',{sourceId:'synthetic-independent-input',nativeMessageId:'synthetic-not-emitted',kind:'incoming'});
  core.resume();await initiative.tick(event=>core.wake(event.chatId,event));
  await until(()=>finishes.length===1&&core.state('owner').pendingWake===null);await core.chain;
  assert.equal(finishes[0].decision,'completed_without_decision');assert.equal(finishes[0].eventId,'synthetic-wake');
  assert.equal(core.state('owner').replyPermits[untouched].status,'open');
  assert.equal(initiative.claims.size,0);assert.equal(initiative.deadlines.size,0);
  assert.equal(core.store.data.audit.filter(e=>e.code==='WAKE_COMPLETED_WITHOUT_DECISION').length,1);
  assert.equal(core.store.data.audit.filter(e=>e.code==='WAKE_DECISION_TIMEOUT').length,0);
  const ended=events.find(e=>e.type==='turn/end');assert.equal(ended.reason,'completed');assert.equal(typeof ended.turn,'number');
  const user=events.find(e=>e.type==='user/message');assert.ok(user&&events.find(e=>e.type==='turn/start'&&e.turn===ended.turn));
  assert.equal(core.state('owner').messages['wake:'+crypto.createHash('sha256').update('synthetic-wake').digest('hex')].decision,'completed_without_decision');
  console.log(JSON.stringify({sdk:'installed-rc4',reason:ended.reason,eventSessionMatches:true,oneFinish:true,unrelatedGrantPreserved:true,externalModelCalls:0,offlineTurns,wechatCalls:0}));
 }finally{if(core)await core.close();initiative.close();for(const f of fibers.reverse())await f.dispose();}
});
