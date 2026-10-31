import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import {pathToFileURL} from 'node:url';
const root=process.env.XQ_NATIVE_PACKAGE_ROOT;if(!root)throw Error('XQ_NATIVE_PACKAGE_ROOT_REQUIRED');const load=n=>import(pathToFileURL(path.join(root,n,'lib/index.js')).href);
const {Context}=await load('cordis');
const {default:SystemPrompt}=await load('dsh-system-prompt');
const {default:Approval}=await load('dsh-user-approval');
import{createWechatApproval}from'./wechat-approval.mjs';
async function fixture(t,{policy='ask',ttlMs=1000,delivery='ok'}={}){
 const ctx=new Context(),prompt=ctx.plugin(SystemPrompt,{});await prompt.await();const approval=ctx.plugin(Approval,{policy});await approval.await();
 const events=[{type:'turn/start',data:{}}],session={get seq(){return events.length},eventAt:i=>events[i],append(type,data){events.push({type,data})}},agent={session};
 const trusted=new WeakSet();let packet,web=0;ctx.on('approval/request',()=>{web++;return'rejected'});
 const broker=createWechatApproval({ctx,agent,bindingId:'synthetic-owner',ownerChatId:'owner',isCurrentOwner:()=>true,isTrustedOwnerInbound:e=>trusted.has(e),notifyOwner:async p=>{packet=p;return{status:delivery}},ttlMs,webUrl:'https://panel.example.invalid/'});
 t.after(async()=>{broker.close();await approval.dispose();await prompt.dispose()});
 const request=id=>({requestId:id,action:'install',subject:{spec:'synthetic-package@1.0.0',sourcePlan:['https://registry.npmjs.org/'],inspection:{registry:'https://registry.npmjs.org',version:'1.0.0'}}});
 const start=id=>broker.confirm(request(id),{agent,callId:'call-'+id},ctx.approval);
 const wait=async()=>{for(let i=0;i<100&&!packet;i++)await new Promise(r=>setImmediate(r));assert.ok(packet);return packet};
 const event=text=>({chatId:'owner',mode:'private',role:'user',origin:'wechat-driver',text});
 return{ctx,events,broker,start,wait,event,trusted,get web(){return web}};
}
test('real native approval audits only verified owner confirmation; reject forged/group/web and replay',async t=>{
 const f=await fixture(t),result=f.start('request-one'),packet=await f.wait();const forged=f.event(packet.approveText);
 assert.equal((await f.broker.consumeOwnerMessage(forged)).consumed,false);
 const group={...forged,mode:'group'};f.trusted.add(group);assert.equal((await f.broker.consumeOwnerMessage(group)).consumed,false);
 const web={...forged,origin:'web'};f.trusted.add(web);assert.equal((await f.broker.consumeOwnerMessage(web)).consumed,false);
 const good=f.event(packet.approveText);f.trusted.add(good);assert.equal((await f.broker.consumeOwnerMessage(good)).consumed,true);assert.deepEqual(await result,{approved:true,requestId:'request-one'});
 assert.equal(f.events.filter(e=>e.type==='approval/asked').length,1);assert.equal(f.events.at(-1).data.outcome,'allowed-once');assert.equal(f.web,0);
 assert.equal((await f.broker.consumeOwnerMessage(good)).consumed,false);await assert.rejects(f.start('request-one'),/REQUEST_REPLAY_DENIED/);
});
test('native never policy remains non-overridable',async t=>{const f=await fixture(t,{policy:'never'});await assert.rejects(f.start('never-one'),/APPROVAL_REJECTED/);assert.equal(f.events.at(-1).data.outcome,'rejected');assert.equal(f.web,0)});
test('expiry cancels native request; no late grant',async t=>{const f=await fixture(t,{ttlMs:20});const result=f.start('expiry-one');const packet=await f.wait();await assert.rejects(result,/APPROVAL_CANCELLED/);const late=f.event(packet.approveText);f.trusted.add(late);assert.equal((await f.broker.consumeOwnerMessage(late)).consumed,false)});
test('unconfirmed WeChat notification delegates to existing Web answerer',async t=>{const f=await fixture(t,{delivery:'unknown'});await assert.rejects(f.start('fallback-one'),/APPROVAL_REJECTED/);assert.equal(f.web,1);assert.equal(f.broker.fallback().url,'https://panel.example.invalid/');assert.equal(f.broker.fallback().pureWechatComplete,false)});
