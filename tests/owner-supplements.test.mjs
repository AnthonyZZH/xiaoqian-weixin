import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createBridge} from '../src/index.mjs';
import {allowedTools} from '../src/policy.mjs';

async function fixture(t,{services={},searchEnabled=true}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xq-owner-core-')),registries=new Map();
 const chats=[{id:'owner',title:'SYNTHETIC OWNER',mode:'private',owner:true},{id:'group',title:'SYNTHETIC GROUP',mode:'group'}];
 const agents={async create(options){
  const tools=new Map(),agent={session:{id:options.sessionId},inbox:{nextTurn:[]},followup(){}};
  const context={on(){},effect(){},systemPrompt:{section(){}},tools:{restrict(){},guard(fn){context.guard=fn;},register(spec){tools.set(spec.name,spec);}}};
  await options.setup(context,agent);registries.set(agent,{tools,context});return{agent,async dispose(){}};
 }};agents.resume=agents.create;
 const driver={resume(){},pause(){},async close(){},async call(){throw new Error('NO_REAL_SEND');}};
 const bridge=await createBridge({agents,sessions:{async flush(){return true}}},{stateDir:root,mode:'mock',searchEnabled,chats},{driver,defineTool:x=>x,ownerServices:services});
 bridge.core.resume();const owner=(await bridge.core.handle('owner')).agent,group=(await bridge.core.handle('group')).agent;
 t.after(async()=>{await bridge.core.close();fs.rmSync(root,{recursive:true,force:true});});
 const invoke=(name,args,agent=owner)=>registries.get(owner).tools.get(name).execute(args,{agent,callId:'synthetic-call-'+Math.random(),signal:new AbortController().signal});
 return{bridge,core:bridge.core,owner,group,registries,invoke};
}
test('search registers only for owner and sends exact query to independent worker',async t=>{
 const calls=[],f=await fixture(t,{services:{worker:async(request)=>{calls.push(request);return{results:[{title:'synthetic',url:'https://example.com/'}]}}}});
 assert.ok(f.registries.get(f.owner).tools.has('owner_search'));assert.ok(!f.registries.get(f.group).tools.has('owner_search'));
 assert.equal(f.registries.get(f.group).context.guard({name:'owner_search'}),'WECHAT_TOOL_SCOPE_DENIED');
 const result=await f.invoke('owner_search',{query:'public synthetic'});assert.equal(result.results.length,1);
 assert.deepEqual(calls,[{operation:'search',query:'public synthetic'}]);
 assert.equal(f.core.store.data.audit.at(-1).code,'OWNER_TOOL_OK');
 await assert.rejects(f.invoke('owner_search',{query:'foreign'},f.group),/OWNER_AGENT_MISMATCH/);assert.equal(calls.length,1);
});
test('unconfigured balance, drawing, vision, shell and attachments are absent from owner schema',async t=>{
 const f=await fixture(t,{searchEnabled:false});const names=[...f.registries.get(f.owner).tools.keys()];
 for(const name of ['owner_search','owner_balance','owner_command','owner_file_read','owner_attachment_read','wechat_draw','wechat_describe_image','wechat_search'])assert.ok(!names.includes(name),name);
 assert.deepEqual(f.core.status('owner').availableTools,[...allowedTools(f.core.chat('owner'),f.core.capabilities)]);
});
test('owner revocation denies in-flight search result and later access',async t=>{
 let release;const gate=new Promise(r=>release=r);let entered;const enteredGate=new Promise(r=>entered=r);
 const f=await fixture(t,{services:{worker:async()=>{entered();await gate;return{results:[]}}}});
 const pending=f.invoke('owner_search',{query:'public'});await enteredGate;
 f.core.chats.set('owner',Object.freeze({...f.core.chat('owner'),owner:false}));release();
 await assert.rejects(pending,/OWNER_AUTHORITY_REVOKED/);
 await assert.rejects(f.invoke('owner_search',{query:'public'}),/OWNER_AUTHORITY_REVOKED/);
});
test('pause aborts active owner call; resume rebinds same registered Agent tools',async t=>{
 let started;const startedGate=new Promise(r=>started=r);let calls=0;
 const f=await fixture(t,{services:{worker:async(_request,{signal})=>{if(++calls===1){started();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{code:'TOOL_CANCELLED'})),{once:true}));}return{results:[]};}}});
 const pending=f.invoke('owner_search',{query:'public'});await startedGate;f.core.pause();await assert.rejects(pending,/TOOL_CANCELLED/);
 await assert.rejects(f.invoke('owner_search',{query:'public'}),/OWNER_AUTHORITY_REVOKED/);
 f.core.resume();assert.deepEqual(await f.invoke('owner_search',{query:'public'}),{results:[]});assert.equal(calls,2);
});
test('balance is injected official transport only; changing provider fails before another request',async t=>{
 let calls=0,provider={kind:'deepseek-official',baseURL:'https://api.deepseek.com',async requestOfficialBalance(args){calls++;assert.equal(args.path,'/user/balance');return{is_available:true,balance_infos:[{currency:'CNY',total_balance:'1.25',granted_balance:'0',topped_up_balance:'1.25'}]};}};
 const f=await fixture(t,{services:{getProvider:()=>provider}});
 const balance=await f.invoke('owner_balance',{});assert.equal(balance.balance_infos[0].total_balance,'1.25');assert.ok(Number.isFinite(Date.parse(balance.queriedAt)));
 provider={...provider,kind:'reseller',baseURL:'https://example.com'};await assert.rejects(f.invoke('owner_balance',{}),/OFFICIAL_PROVIDER_REQUIRED/);assert.equal(calls,1);
});
