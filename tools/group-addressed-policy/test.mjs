import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {explicitlyCallsName,install} from './index.mjs';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
test('current explicit vocative accepted, discussion/quotes not matched',()=>{
 for(const s of ['小千','小千，你在吗','小千帮我查一下','@小千 你好','小千：请看这个'])assert.equal(explicitlyCallsName(s),true,s);
 for(const s of ['大家说小千很可爱','小千的回复不错','小千说她不知道','“小千，你好”','> 小千你看看','转发：小千你好','小千：我不知道','普通聊天'])assert.equal(explicitlyCallsName(s),false,s);
});
function fixture(){
 const states={'bread-group':{messages:{},replyPermits:{old:{status:'open'}},groupPaused:false},'owner-dm':{messages:{},replyPermits:{}}};let calls=[];
 const core={chats:new Map([['bread-group',{mode:'group',owner:false}],['owner-dm',{id:'owner-dm',mode:'private',owner:true}]]),state:id=>states[id],chat:id=>core.chats.get(id),handles:new Map(),serial:fn=>Promise.resolve().then(fn),store:{data:{paused:false},save(){},audit(){}},permits:{active:new Map(),issue(id,o){const key=hash(o.sourceId);states[id].replyPermits[key]={status:'open'};return key;},consume(id,c){return c;},close(id,key){states[id].replyPermits[key].status='policy-changed';}},async handle(){return{};},async ingest(r){for(const m of r.messages){const g=this.permits.issue(r.chatId,{sourceId:m.id});states[r.chatId].messages[hash(m.id)]={status:'accepted',grantId:g};}return{ackable:r.messages.map(m=>m.id),accepted:r.messages.length};},async send(id,a,c){return driver.call('send_text',{targetId:id,idempotencyKey:a.deliveryId+':text'});}};
 const driver={async call(op,args){calls.push({op,args});return{status:'ok'};}};
 return {core,driver,states,calls};
}
test('ordinary input ACKed without Agent, addressed input receives grant',async()=>{
 const f=fixture();const p=install(f,{normalizeMessage:m=>m});await p.ready;
 assert.equal(f.states['bread-group'].replyPermits.old.status,'policy-changed');
 const a=await f.core.ingest({chatId:'bread-group',messages:[{id:'ordinary',role:'user',text:'普通闲聊'},{id:'call',role:'user',text:'小千，你在吗'}]});
 assert.equal(a.accepted,1);assert.deepEqual(a.ackable,['call','ordinary']);assert.equal(f.states['bread-group'].messages[hash('ordinary')].status,'baseline');
 const g=f.states['bread-group'].messages[hash('call')].grantId;assert.doesNotThrow(()=>f.core.permits.consume('bread-group',{grantId:g}));
 assert.throws(()=>f.core.permits.consume('bread-group',{grantId:'old'}),/GROUP_NOT_ADDRESSED/);
 assert.equal((await f.core.send('bread-group',{text:'synthetic'},{grantId:g})).status,'ok');
});
test('send and actual driver reject unaddressed group; private unaffected',async()=>{
 const f=fixture();const p=install(f,{normalizeMessage:m=>m});await p.ready;
 await assert.rejects(f.core.send('bread-group',{text:'x'},{grantId:'old'}),/GROUP_NOT_ADDRESSED/);
 assert.equal((await f.driver.call('send_text',{targetId:'bread-group',idempotencyKey:'old:text'})).status,'rejected');
 const r=await f.core.ingest({chatId:'owner-dm',messages:[{id:'private',role:'user',text:'普通私聊'}]});assert.equal(r.accepted,1);
 p.close();assert.equal(f.states['bread-group'].groupPaused,true);
});
