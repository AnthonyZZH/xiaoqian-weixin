import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBridge} from '../src/index.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scratch=path.join(project,'.test-scratch');
const chats=[{id:'owner',title:'Owner test',mode:'private',owner:true},{id:'group',title:'Group test',mode:'group',owner:false}];
function nativeMock(){
 const instances=[];
 const agents={async create(options){const definitions=[];const instance={options,definitions};const agent={session:{id:options.sessionId},followup(m){assert.equal(m.role,'user');assert.equal(typeof m.id,'string');},inject(){}};instance.agent=agent;
 await options.setup({tools:{restrict(filter){instance.allow=filter.allow;},guard(fn){instance.guard=fn;},register(def){definitions.push(def);}},systemPrompt:{section(){}}},agent);
 instances.push(instance);return {agent,async dispose(){}};},async resume(options){return this.create(options);}};
 return {instances,agents,sessions:{async flush(){return true;}}};
}
async function fixture(t){fs.mkdirSync(scratch,{recursive:true});const stateDir=fs.mkdtempSync(path.join(scratch,'plugin-'));const ctx=nativeMock();const driver={calls:[],async call(operation,args){this.calls.push({operation,args});return {status:'ok',messages:[]};},pause(){},resume(){},async close(){}};
 const bridge=await createBridge(ctx,{stateDir,chats,mode:'mock'},{defineTool:def=>def,driver});t.after(async()=>{await bridge.core.close();const safe=path.resolve(stateDir);assert.ok(safe.startsWith(path.resolve(scratch)+path.sep));fs.rmSync(safe,{recursive:true,force:true});});bridge.core.resume();return {bridge,ctx,driver};}

test('native plugin scopes group registrations and checks explicit execution Agent',async t=>{
 const {bridge,ctx,driver}=await fixture(t);await bridge.core.ingest({chatId:'group',messages:[{id:'m',text:'hello'}]});const instance=ctx.instances[0];
 assert.equal(instance.definitions.some(d=>d.name==='wechat_task'),false);
 assert.equal(instance.definitions.some(d=>d.name==='wechat_relay'),false);
 const reply=instance.definitions.find(d=>d.name==='wechat_reply');assert.ok(reply);
 await assert.rejects(reply.execute({text:'hello'},{agent:{},callId:'call-1',signal:new AbortController().signal}),/TOOL_AGENT_MISMATCH/);
 assert.equal(driver.calls.length,0);
 await assert.rejects(reply.execute({text:'hello'},{agent:instance.agent,callId:'',signal:new AbortController().signal}),/TOOL_CALL_ID_REQUIRED/);
 assert.equal(driver.calls.length,0);
});
test('tool send correlation is Host supplied and repeated call does not resend',async t=>{
 const {bridge,ctx,driver}=await fixture(t);await bridge.core.ingest({chatId:'group',messages:[{id:'m',text:'hello'}]});const instance=ctx.instances[0],reply=instance.definitions.find(d=>d.name==='wechat_reply');
 const exec={agent:instance.agent,callId:'host-call-1',signal:new AbortController().signal};
 const first=await reply.execute({text:'hello',deliveryId:'model-forged'},exec);assert.equal(first.status,'ok');
 const again=await reply.execute({text:'hello',deliveryId:'different-forged'},exec);assert.equal(again.duplicate,true);
 assert.equal(driver.calls.length,1);assert.equal(driver.calls[0].args.idempotencyKey,'host-call-1:text');
});
test('cancelled native tool call cannot reach driver',async t=>{
 const {bridge,ctx,driver}=await fixture(t);await bridge.core.ingest({chatId:'group',messages:[{id:'m',text:'hello'}]});const instance=ctx.instances[0],reply=instance.definitions.find(d=>d.name==='wechat_reply');const controller=new AbortController();controller.abort();
 await assert.rejects(reply.execute({text:'hello'},{agent:instance.agent,callId:'cancelled',signal:controller.signal}),/TOOL_CANCELLED/);assert.equal(driver.calls.length,0);
});
test('factory requires explicit mode and live opt-in before driver startup',async()=>{
 const ctx=nativeMock();
 await assert.rejects(createBridge(ctx,{stateDir:path.join(scratch,'unused'),chats}),/MODE_REQUIRED/);
 await assert.rejects(createBridge(ctx,{stateDir:path.join(scratch,'unused'),chats,mode:'live'}),/LIVE_NOT_APPROVED/);
});
