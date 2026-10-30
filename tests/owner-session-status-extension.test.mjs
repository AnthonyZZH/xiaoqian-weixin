import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {createStatusExtension, apply, TOOL_NAME} from '../tools/owner-session-status-extension.mjs';
import {allowedTools} from '../src/policy.mjs';

const hash = c => crypto.createHash('sha256').update(JSON.stringify([c.id,c.title,c.mode,c.owner])).digest('hex');
const forbidden = () => { throw Error('FORBIDDEN_SIDE_EFFECT'); };
function fixture({disposer = true, initialNames = []} = {}) {
  const timer = {callback: null, cleared: 0};
  const scheduler = {setInterval(callback) {timer.callback = callback; return {unref() {}};}, clearInterval() {timer.cleared++;}};
  const calls = {registrations: 0, unregisters: 0};
  function makeAgent() {
    const tools = new Map(), cleanup = [];
    const ctx = {tools: {
      guard: forbidden, restrict: forbidden,
      register(definition) {
        calls.registrations++; tools.set(definition.name, definition);
        if (disposer) return () => {calls.unregisters++; if (tools.get(definition.name) === definition) tools.delete(definition.name);};
      }
    }, effect(factory) {cleanup.push(factory());}};
    return {ctx, tools, cleanup, status: 'idle', session: {seq: 0, eventAt: forbidden}, inbox: {nextTurn: [], nextStep: []}};
  }
  const owner = {id: 'owner', title: 'Synthetic owner', mode: 'private', owner: true};
  const group = {id: 'group', title: 'Synthetic group', mode: 'group', owner: false};
  const stranger = {id: 'stranger', title: 'Synthetic stranger', mode: 'private', owner: false};
  const agent = makeAgent(), groupAgent = makeAgent(), strangerAgent = makeAgent();
  const core = {
    chats: new Map([owner,group,stranger].map(c=>[c.id,c])),
    handles: new Map([['owner',{agent}],['group',{agent:groupAgent}],['stranger',{agent:strangerAgent}]]),
    capabilities: {ownerNativeTools: [...initialNames], taskManager: {jobs: {jobs: {}}, handles: new Map(), status: forbidden}},
    store: {data: {paused: false, chats: Object.fromEntries([owner,group,stranger].map(c=>[c.id,{binding:hash(c),messages:{},deliveries:{}}]))}, save: forbidden},
    closed: false, createBridge: forbidden, handle: forbidden, openHandle: forbidden, state: forbidden, status: forbidden
  };
  const start = options => createStatusExtension({core, defineTool: x=>x, scheduler, ...options});
  return {core, owner, agent, groupAgent, strangerAgent, makeAgent, calls, timer, scheduler, start};
}
const invoke = (agent, args = {}, exec = {}) => agent.tools.get(TOOL_NAME).execute(args, {agent, ...exec});

test('only current owner private handle; dynamic policy admits just this tool; no core allocation', async()=>{
  const f=fixture(), extension=f.start();
  assert.equal(f.calls.registrations,1); assert.equal(f.groupAgent.tools.size,0); assert.equal(f.strangerAgent.tools.size,0);
  assert.equal(allowedTools(f.owner,f.core.capabilities).has(TOOL_NAME),true);
  assert.equal(allowedTools(f.core.chats.get('group'),f.core.capabilities).has(TOOL_NAME),false);
  const result=await invoke(f.agent);
  assert.equal(result.readOnly,true); assert.equal(result.coverage.longTaskRootConfigured,false);
  assert.equal(result.coverage.extraRegistryConfigured,false); assert.equal(result.sessions[0].displayName,null);
  await assert.rejects(invoke(f.agent,{owner:true},{agent:f.groupAgent}),/OWNER_ONLY/);
  extension.close();
});

test('paused and changed binding deny, including direct invocation bypassing native guard', async()=>{
  const f=fixture(), extension=f.start(); f.core.store.data.paused=true;
  await assert.rejects(invoke(f.agent),/OWNER_ONLY/);
  f.core.store.data.paused=false; await invoke(f.agent);
  f.core.store.data.chats.owner.binding='wrong'; await assert.rejects(invoke(f.agent),/OWNER_ONLY/);
  extension.refresh(); assert.equal(extension.inspect().boundOwners,0); extension.close();
});

test('rotation loses authority immediately before metadata timer; timer binds only replacement handle', async()=>{
  const f=fixture(), extension=f.start(), oldTool=f.agent.tools.get(TOOL_NAME), next=f.makeAgent();
  f.core.handles.set('owner',{agent:next});
  await assert.rejects(oldTool.execute({}, {agent:f.agent}),/OWNER_ONLY/);
  f.timer.callback(); assert.equal(f.calls.registrations,2); assert.equal(f.calls.unregisters,1);
  await invoke(next); await assert.rejects(oldTool.execute({}, {agent:f.agent}),/OWNER_ONLY/);
  extension.close();
});

test('unload removes only own capability and supports returned registration disposer', async()=>{
  const f=fixture({initialNames:['existing']}), extension=f.start(), tool=f.agent.tools.get(TOOL_NAME);
  f.core.capabilities.ownerNativeTools.push('later');
  extension.close(); extension.close();
  assert.deepEqual(f.core.capabilities.ownerNativeTools,['existing','later']);
  assert.equal(f.calls.unregisters,1); assert.equal(f.timer.cleared,1);
  await assert.rejects(tool.execute({}, {agent:f.agent}),/OWNER_ONLY/);
});

test('pre-existing capability remains on unload and current replacement array preserves other names',()=>{
  const f=fixture({initialNames:[TOOL_NAME,'existing']}), extension=f.start();
  extension.close(); assert.deepEqual(f.core.capabilities.ownerNativeTools,[TOOL_NAME,'existing']);
  const g=fixture(), second=g.start();
  g.core.capabilities.ownerNativeTools=[...g.core.capabilities.ownerNativeTools,'concurrent'];
  second.close(); assert.deepEqual(g.core.capabilities.ownerNativeTools,['concurrent']);
});

test('undefined unregister remains explicitly logical-only; stale scope is not rebound',async()=>{
  const f=fixture({disposer:false}), extension=f.start(), tool=f.agent.tools.get(TOOL_NAME);
  assert.equal(extension.inspect().logicalRevocationOnly,true);
  f.agent.cleanup[0](); extension.refresh();
  assert.equal(f.calls.registrations,1); assert.equal(extension.inspect().boundOwners,0);
  await assert.rejects(tool.execute({}, {agent:f.agent}),/OWNER_ONLY/);
  extension.close();
});

test('no file reads, private bodies, tool arguments, results or raw error access',async()=>{
  const f=fixture();
  const denied=()=>{throw Error('PRIVATE_FIELD_READ');};
  f.agent.session={seq:3,eventAt:i=>[
    {type:'user/message',data:{get content(){return denied();},get text(){return denied();}}},
    {type:'tool/call',data:{name:'synthetic_tool',callId:'c',get arguments(){return denied();}}},
    {type:'tool/result',data:{message:{callId:'c',isError:true,get content(){return denied();}},error:{code:'TASK_FAILED',get message(){return denied();}}}}
  ][i]};
  Object.defineProperty(f.core.store.data.chats.owner.messages,'m',{enumerable:true,value:{status:'accepted',get content(){return denied();}}});
  const read=fs.readFileSync, list=fs.readdirSync;
  let extension;
  try {
    fs.readFileSync=denied; fs.readdirSync=denied;
    extension=createStatusExtension({core:f.core,defineTool:x=>x,scheduler:f.scheduler,get longTaskRoot(){return denied();},get extraManagedSessions(){return denied();}});
    const result=await invoke(f.agent); assert.equal(result.coverage.longTaskRootConfigured,false);
    assert.equal(result.sessions[0].lastError.code,'TASK_FAILED');
  } finally {extension?.close();fs.readFileSync=read;fs.readdirSync=list;}
});

test('mid-read owner revocation is checked before output',async()=>{
  const f=fixture(), extension=f.start();
  f.agent.session={seq:1,eventAt(){f.core.handles.delete('owner');return {type:'step/start',data:{}};}};
  await assert.rejects(invoke(f.agent),/OWNER_ONLY/); extension.close();
});

test('owner removal, closed core and capability removal all fail closed',async()=>{
  const f=fixture(), extension=f.start(), tool=f.agent.tools.get(TOOL_NAME);
  f.core.capabilities.ownerNativeTools=[]; await assert.rejects(invoke(f.agent),/OWNER_ONLY/);
  f.core.capabilities.ownerNativeTools=[TOOL_NAME]; f.core.chats.set('owner',{...f.owner,owner:false});
  await assert.rejects(tool.execute({}, {agent:f.agent}),/OWNER_ONLY/);
  f.core.closed=true; extension.refresh(); assert.equal(extension.inspect().closed,true);
});

test('missing handle is never opened; later existing handle is picked up; duplicate extension refused',()=>{
  const f=fixture(); f.core.handles.delete('owner'); const extension=f.start();
  assert.equal(f.calls.registrations,0);
  assert.throws(()=>f.start(),/STATUS_EXTENSION_ALREADY_ATTACHED/);
  f.core.handles.set('owner',{agent:f.agent}); f.timer.callback(); assert.equal(f.calls.registrations,1);
  extension.close();
});

test('native apply defaults off, requires existing bridge, and lifecycle disposes',async()=>{
  assert.equal(await apply({get:forbidden,effect:forbidden}),undefined);
  await assert.rejects(apply({get:()=>null,effect:()=>{}},{enabled:true}),/EXISTING_BRIDGE_SERVICE_REQUIRED/);
  const f=fixture(), cleanup=[];
  const extension=await apply({get:key=>key==='xiaoqianBridge'?{core:f.core}:null,effect:factory=>cleanup.push(factory())},
    {enabled:true},{defineTool:x=>x,scheduler:f.scheduler});
  assert.equal(extension,undefined); // Native Cordis apply returns no API/effect object.
  assert.equal(f.calls.registrations,1); assert.equal(f.agent.tools.has(TOOL_NAME),true);
  assert.equal((await invoke(f.agent)).readOnly,true);
  cleanup[0]();
  assert.equal(f.agent.tools.has(TOOL_NAME),false); assert.equal(f.calls.unregisters,1);
});

test('registration failure revokes partially exposed tool and does not retry same scope',async()=>{
  const f=fixture(), register=f.agent.ctx.tools.register;
  f.agent.ctx.tools.register=definition=>{register(definition);throw Error('PRIVATE_RUNTIME_FAILURE');};
  const extension=f.start(), tool=f.agent.tools.get(TOOL_NAME);
  assert.equal(extension.inspect().lastError,'STATUS_REGISTRATION_FAILED');
  await assert.rejects(tool.execute({}, {agent:f.agent}),/OWNER_ONLY/);
  extension.refresh(); assert.equal(f.calls.registrations,1); extension.close();
});
