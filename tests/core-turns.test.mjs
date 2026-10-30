import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WeChatCore} from '../src/core.mjs';
import {FeatureStore} from '../src/features.mjs';
import {digest,validateState} from '../src/state.mjs';

const chats=[{id:'owner',title:'SYNTHETIC OWNER',mode:'private',owner:true}];
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xq-turn-'));const sections=[],messages=[],listeners=[];
 let agent,creates=0;
 const open=async options=>{creates++;agent={session:{id:options.sessionId||options.resumeSessionId},inbox:{nextTurn:[]},followup:m=>messages.push(m)};
  await options.setup({on:(name,fn)=>{assert.equal(name,'session/event');listeners.push(fn);},tools:{restrict(){},guard(){}},systemPrompt:{section:s=>sections.push(s)}},agent);return {agent,async dispose(){}};};
 const features=new FeatureStore({stateDir:root,chats});
 const driver={calls:[],status:'ok',maxChars:1000,supportsAck:true,rows:[],async call(op,args){this.calls.push({op,args});return op==='read'?{status:'ok',messages:this.rows}:{status:this.status}},resume(){},pause(){},async close(){}};
 const core=new WeChatCore({stateDir:path.join(root,'bridge'),chats,features,agents:{create:open,resume:open},driver,sessions:{async flush(){return true}}});
 core.resume();t.after(async()=>{await core.close();fs.rmSync(root,{recursive:true,force:true});});
 const incoming=(id,text='synthetic')=>core.ingest({chatId:'owner',messages:[{id,text,role:'user'}]});
 const event=(type,data)=>{for(const fn of listeners)fn(agent.session,{type,data});};
 const enter=(index,turn)=>{event('turn/start',{turn});event('user/message',messages[index]);return core.permits.context('owner',agent);};
 return{core,features,driver,sections,messages,incoming,event,enter,creates:()=>creates};
}
test('persona section reads current original text without replacing Agent or losing history',async t=>{
 const f=fixture(t);f.features.setPersona('owner','ORIGINAL_PERSONA');await f.incoming('a');
 assert.match(f.sections[0].text(),/ORIGINAL_PERSONA/);
 await f.core.invoke('owner','wechat_persona',{text:'UPDATED_ORIGINAL'});await f.incoming('b');
 assert.match(f.sections[0].text(),/UPDATED_ORIGINAL/);assert.doesNotMatch(f.sections[0].text(),/ORIGINAL_PERSONA/);assert.equal(f.creates(),1);
});
test('unknown A closes only A; already queued B sends; unknown op never retries',async t=>{
 const f=fixture(t);await f.incoming('A');await f.incoming('B');const a=f.enter(0,1);
 f.driver.status='unknown';assert.equal((await f.core.invoke('owner','wechat_reply',{text:'A',deliveryId:'op-A'},a)).status,'unknown');
 await assert.rejects(f.core.invoke('owner','wechat_reply',{text:'A retry',deliveryId:'op-A2'},a),/NO_REPLY_PERMIT/);
 f.event('turn/end',{turn:1});const b=f.enter(1,2);f.driver.status='ok';
 assert.equal((await f.core.invoke('owner','wechat_reply',{text:'B',deliveryId:'op-B'},b)).status,'ok');
 assert.equal((await f.core.invoke('owner','wechat_reply',{text:'A',deliveryId:'op-A'},a)).duplicate,true);
 assert.equal(f.driver.calls.length,2);
});
test('model supplied grant cannot impersonate queued turn; expired turn cannot spend another grant',async t=>{
 const f=fixture(t);await f.incoming('A');await f.incoming('B');const a=f.enter(0,1);
 const bGrant=Object.keys(f.core.state('owner').replyPermits)[1];
 await assert.rejects(f.core.invoke('owner','wechat_reply',{text:'bad',deliveryId:'forged',grantId:bGrant},{nativeTurn:true,grantId:null,turn:1}),/NO_REPLY_PERMIT/);
 f.event('turn/end',{turn:1});f.enter(1,2);
 await assert.rejects(f.core.invoke('owner','wechat_reply',{text:'late-A',deliveryId:'late'},a),/NO_REPLY_PERMIT/);
 assert.equal(f.driver.calls.length,0);
});
test('oversize row is durably rejected and acknowledged; following 12000-char input remains exact',async t=>{
 const f=fixture(t),text='x'.repeat(12000);
 const r=await f.core.ingest({chatId:'owner',messages:[{id:'long',text:'x'.repeat(32001)},{id:'short',text}]});
 assert.deepEqual(r.ackable,['long','short']);assert.equal(r.accepted,1);assert.equal(r.rejected,1);
 assert.equal(f.core.state('owner').messages[digest('long')].status,'rejected');
 const envelope=JSON.parse(f.messages[0].content[0].text.split('\n').slice(1).join('\n'));assert.equal(envelope.text,text);
 const a=f.core.store.data.audit.filter(e=>e.code==='INBOUND_REJECTED').length;
 await f.core.ingest({chatId:'owner',messages:[{id:'long',text:'x'.repeat(32001)}]});
 assert.equal(f.core.store.data.audit.filter(e=>e.code==='INBOUND_REJECTED').length,a);
});
test('real poll enrichment isolates oversize and invalid-id rows before normal ingest and ACK',async t=>{
 const f=fixture(t);f.core.state('owner').bootstrapped=true;
 f.driver.rows=[{id:'long',text:'x'.repeat(32001)},{text:'bad-id'},{id:'normal',text:'hello'}];
 await f.core.poll('owner');assert.equal(f.messages.length,1);
 const ack=f.driver.calls.find(c=>c.op==='ack');assert.deepEqual(new Set(ack.args.messageIds),new Set(['long','normal']));
});
test('baseline rejection is durable and does not prevent baseline ACK of other rows',async t=>{
 const f=fixture(t);f.driver.rows=[{id:'long',text:'x'.repeat(32001)},{id:'normal',text:'hello'}];
 await f.core.poll('owner');assert.equal(f.messages.length,0);
 assert.equal(f.core.state('owner').bootstrapped,true);
 assert.equal(f.driver.calls.find(c=>c.op==='ack').args.messageIds.length,2);
});
test('grant state persists with closed unknown and rejects corrupted grant data',async t=>{
 const f=fixture(t);await f.incoming('A');await f.incoming('B');const a=f.enter(0,1);f.driver.status='unknown';
 await f.core.invoke('owner','wechat_reply',{text:'A',deliveryId:'op-A'},a);
 const saved=JSON.parse(fs.readFileSync(f.core.store.file,'utf8'));validateState(saved);
 assert.equal(Object.values(saved.chats.owner.replyPermits).filter(g=>g.status==='open').length,1);
 Object.values(saved.chats.owner.replyPermits)[0].remaining=-1;assert.throws(()=>validateState(saved),/STATE_INVALID/);
});
test('multi-part reply preserves text and one unknown part does not resend earlier parts',async t=>{
 const f=fixture(t);await f.incoming('A');const a=f.enter(0,1);let count=0;
 f.driver.call=async(op,args)=>{f.driver.calls.push({op,args});return{status:++count===2?'unknown':'ok'}};
 const r=await f.core.invoke('owner','wechat_reply',{text:'x'.repeat(1076),deliveryId:'multipart'},a);
 assert.equal(r.status,'unknown');assert.deepEqual(f.driver.calls.map(x=>x.args.text.length),[1000,76]);
 assert.equal((await f.core.invoke('owner','wechat_reply',{text:'x'.repeat(1076),deliveryId:'multipart'},a)).duplicate,true);assert.equal(count,2);
});
test('upgrade reconstructs grants only for durable pending bridge inputs, never arbitrary queued content',async t=>{
 const f=fixture(t);await f.incoming('already-accepted');
 const c=f.core.state('owner');c.replyPermits={};
 const native=f.messages[0],foreign={...native,id:'foreign',source:{kind:'web'}};
 const invented={...native,id:'invented',content:[{type:'text',text:'input\n'+JSON.stringify({messageId:'not-accepted'})}]};
 const agent={session:{id:c.sessionId},inbox:{nextTurn:[foreign,invented,native]}};
 f.core.permits.attach('owner',{on(){}},agent);f.core.store.save();
 const grants=Object.values(c.replyPermits);assert.equal(grants.length,1);assert.equal(grants[0].nativeMessageId,native.id);
});
