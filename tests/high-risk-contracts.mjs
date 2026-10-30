import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {WeChatCore} from '../src/core.mjs';

const review=path.dirname(fileURLToPath(import.meta.url));
const scratch=path.join(review,'test-artifacts');
const chats=[{id:'owner',title:'SYNTHETIC OWNER',mode:'private',owner:true},{id:'group',title:'SYNTHETIC GROUP',mode:'group',owner:false}];
function nativeDouble(){
  const calls=[],messages=[],scopes=[];
  async function open(method,options){
    calls.push({method,options});
    // Actual installed rc.4 AgentLoop.resumeWith reads resumeSessionId (line 1970).
    if(method==='resume')assert.equal(typeof options.resumeSessionId,'string','native resume requires resumeSessionId');
    const sid=method==='resume'?options.resumeSessionId:options.sessionId;
    const scope={};scopes.push(scope);
    const agent={session:{id:sid},followup(message){messages.push(message);},inject(){}};
    await options.setup?.({tools:{restrict(filter){scope.allow=filter.allow;},guard(fn){scope.guard=fn;},register(){}},systemPrompt:{section(){}}},agent);
    return {agent,async dispose(){}};
  }
  return {calls,messages,scopes,create:o=>open('create',o),resume:o=>open('resume',o)};
}
function fixture(t,{flush=true,unknown=false,capabilities={}}={}){
  fs.mkdirSync(scratch,{recursive:true});
  const stateDir=fs.mkdtempSync(path.join(scratch,'case-'));
  const agents=nativeDouble();
  const driver={calls:[],async call(op,args){this.calls.push({op,args});return {status:unknown?'unknown':'ok'};},pause(){},resume(){},async close(){}};
  const make=()=>new WeChatCore({stateDir,chats,agents,driver,capabilities,sessions:{async flush(){return flush;}}});
  let core=make();
  t.after(async()=>{await core.close().catch(()=>{});});
  return {stateDir,agents,driver,get core(){return core;},async restart(){await core.close();core=make();core.resume();}};
}
const incoming={id:'synthetic-message',text:'synthetic content only',role:'user'};
function validNativeUserMessage(m){
  // Actual rc.4 Session validation at dsh-session/lib/index.js:1200-1206.
  assert.equal(typeof m.id,'string','followup must have an identified message');
  assert.ok(m.id.length>0);
  assert.equal(m.role,'user','followup must have role=user');
  assert.equal(typeof m.source?.kind,'string');
  assert.ok(Array.isArray(m.content));
}
test('R01 inbound follows the actual identified native UserMessage contract',async t=>{
  const f=fixture(t);f.core.resume();
  await f.core.ingest({chatId:'group',messages:[incoming]});
  validNativeUserMessage(f.agents.messages[0]);
});
test('R02 timer wake follows the actual identified native UserMessage contract',async t=>{
  const f=fixture(t);f.core.resume();
  await f.core.wake('group',{wakeId:'synthetic-occurrence'});
  validNativeUserMessage(f.agents.messages[0]);
});
test('R03 process restart uses native resumeSessionId for the same session',async t=>{
  const f=fixture(t);f.core.resume();
  await f.core.ingest({chatId:'group',messages:[incoming]});
  const expected=f.core.status('group').sessionId;
  await f.restart();
  await f.core.ingest({chatId:'group',messages:[{...incoming,id:'second'}]});
  assert.equal(f.agents.calls.at(-1).options.resumeSessionId,expected);
});
test('R04 absent durability listener is never acknowledged as persisted acceptance',async t=>{
  const f=fixture(t,{flush:false});f.core.resume();
  await assert.rejects(f.core.ingest({chatId:'group',messages:[incoming]}),undefined,'flush=false must fail closed');
  assert.equal(f.core.status('group').unknownMessages,1);
});
test('R05 unknown send cannot be retried under a new tool-call identity in the same incoming grant',async t=>{
  const f=fixture(t,{unknown:true});f.core.resume();
  await f.core.ingest({chatId:'group',messages:[incoming]});
  const first=await f.core.invoke('group','wechat_reply',{text:'same synthetic reply',deliveryId:'call-one'});
  assert.equal(first.status,'unknown');
  try { await f.core.invoke('group','wechat_reply',{text:'same synthetic reply',deliveryId:'call-two'}); } catch {}
  assert.equal(f.driver.calls.length,1,'unknown must quarantine the semantic send, not merely its first callId');
});
test('R06 control: repeated identical delivery identity does not call the driver twice',async t=>{
  const f=fixture(t,{unknown:true});f.core.resume();
  await f.core.ingest({chatId:'group',messages:[incoming]});
  await f.core.invoke('group','wechat_reply',{text:'same synthetic reply',deliveryId:'stable-call'});
  const repeated=await f.core.invoke('group','wechat_reply',{text:'same synthetic reply',deliveryId:'stable-call'});
  assert.equal(repeated.duplicate,true);assert.equal(f.driver.calls.length,1);
});
test('R07 control: direct group escalation is denied before side effects',async t=>{
  const f=fixture(t);f.core.resume();
  await assert.rejects(f.core.invoke('group','wechat_task',{task:'synthetic task'}),/TOOL_SCOPE_DENIED/);
  assert.equal(f.driver.calls.length,0);
});

test('R08 malformed persistent chats array is rejected before mapping any session',async t=>{
  fs.mkdirSync(scratch,{recursive:true});
  const stateDir=fs.mkdtempSync(path.join(scratch,'corrupt-'));
  fs.writeFileSync(path.join(stateDir,'bridge.json'),JSON.stringify({version:1,chats:[],audit:[],paused:true}));
  let core;
  try {
    assert.throws(()=>{core=new WeChatCore({stateDir,chats,agents:nativeDouble(),driver:{async close(){}}});},undefined,'array is not a chat map; string properties disappear during JSON serialization');
  } finally {await core?.close();}
});
test('R09 host owner revocation invalidates an existing native tool guard',async t=>{
  const privateTool='fixture_private_read';
  const f=fixture(t,{capabilities:{ownerNativeTools:[privateTool]}});f.core.resume();
  await f.core.ingest({chatId:'owner',messages:[incoming]});
  const guard=f.agents.scopes[0].guard;
  assert.equal(guard({name:privateTool}),undefined,'fixture starts authorized');
  // Host-side revocation only; no model can mutate this map. Current code has no formal revoke API.
  f.core.chats.set('owner',Object.freeze({...f.core.chat('owner'),owner:false}));
  assert.notEqual(guard({name:privateTool}),undefined,'existing session must consult current policy, not its captured allow set');
});
