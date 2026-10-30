import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {pathToFileURL} from 'node:url';
import {buildIsolatedAdapter} from '../src/isolated-provider-builder.mjs';
import {buildOfficialBalanceShim} from '../src/balance-shim-builder.mjs';
import {taskWireBudget} from '../vendor/isolated-owner/wire-budget.mjs';
import {createBillingCollector} from '../src/billing/collector.mjs';
import {bindOwnerBilling} from '../src/billing/owner-binding.mjs';import {digest} from '../src/state.mjs';
const nativePackageRoot=process.env.XQ_NATIVE_PACKAGE_ROOT||'C:/xiaoqian/app/dsh/node_modules/@deepseek-ai';
test('actual pinned SDK composes physical budget before final billing capture and retains balance shim',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xq-isolated-composed-')),metadata=path.join(root,'metadata');
 const collector=createBillingCollector({root:metadata}),prior=globalThis.fetch;
 collector.register({sessionId:'synthetic-composed',active:()=>true,policy:()=>({owner:true,version:1})});
 taskWireBudget.transportAttached=true;let admitted=0,wires=0;
 const ctl=new AbortController(),release=taskWireBudget.install('synthetic-composed',{signal:ctl.signal,admit(){if(++admitted>1)throw Error('TASK_REQUEST_LIMIT');}});
 try{
  const built=buildIsolatedAdapter({nativePackageRoot,outputDir:root,billingCollector:true});
  const shim=buildOfficialBalanceShim({nativePackageRoot,outputDir:root,isolatedTasks:true,billingCollector:true});
  const source=fs.readFileSync(shim.file,'utf8');assert.ok(source.includes(pathToFileURL(built.file).href));assert.match(source,/attachOfficialBalance/);assert.match(source,/xiaoqianIsolatedProvider/);
  const {DeepSeekAdapter,resolveAdapterOptions}=await import(pathToFileURL(built.file));
  const connection=resolveAdapterOptions({baseURL:'https://api.deepseek.com/anthropic',models:[{id:'deepseek-flash',contextWindow:8192}],maxTokens:32});
  const adapter=new DeepSeekAdapter({options:()=>connection,resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic',resolveFiles:()=>({}),prepareExtensions:async()=>({fields:{},accept:async()=>{}})});
  globalThis.fetch=async url=>{assert.match(new URL(url).pathname,/^\/anthropic\/(v1\/)?messages$/);wires++;return new Response([
   {type:'message_start',message:{id:'synthetic',type:'message',role:'assistant',model:'deepseek-flash',content:[],usage:{input_tokens:20,cache_read_input_tokens:80,cache_creation_input_tokens:0,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
   {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'SYNTHETIC'}},
   {type:'content_block_stop',index:0},
   {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}},{type:'message_stop'}
  ].map(x=>'data: '+JSON.stringify(x)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});};
  const options={provider:'deepseek-official',model:'deepseek-flash',sessionId:'synthetic-composed',system:'SYNTHETIC',tools:[],messages:[{id:'synthetic',role:'user',content:[{type:'text',text:'SYNTHETIC'}]}],signal:ctl.signal};
  for await(const _ of adapter.stream(options)){}
  const rows=fs.readdirSync(metadata).filter(x=>x.endsWith('.json')).map(x=>JSON.parse(fs.readFileSync(path.join(metadata,x))));
  assert.equal(rows.length,1);assert.equal(rows[0].complete,true);assert.equal(wires,1);
  await assert.rejects(async()=>{for await(const _ of adapter.stream(options)){};});assert.equal(wires,1);assert.equal(admitted,2);
  assert.equal(fs.readdirSync(metadata).filter(x=>x.endsWith('.json')).length,1);
 }finally{release();taskWireBudget.transportAttached=false;collector.close();globalThis.fetch=prior;assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true});}
});
test('task-result reply grant is not natural-user calibration; real host input remains eligible',()=>{
 const agent={session:{id:'synthetic'}},chat={id:'owner',title:'Synthetic',mode:'private',owner:true};
 const state={binding:digest(JSON.stringify([chat.id,chat.title,chat.mode,chat.owner])),messages:{},replyPermits:{g:{status:'open',kind:'incoming',nativeMessageId:'task-result-synthetic'}}};
 const core={closed:false,store:{data:{paused:false}},handles:new Map([[chat.id,{agent}]]),chats:new Map([[chat.id,chat]]),state:()=>state};
 const listeners=new Map();let registration;const ctx={on(n,f){listeners.set(n,f);return ()=>listeners.delete(n);},effect(){}};
 bindOwnerBilling({collector:{register(x){registration=x;return ()=>{};}},getCore:()=>core,agentCtx:ctx,agent,chat});
 function turn(n,id){const emit=(type,data)=>listeners.get('session/event')(agent.session,{type,seq:n,data});emit('turn/start',{turn:n});emit('step/start',{step:1});emit('user/message',{id});listeners.get('agent/assistant-stream')({agent,frame:{type:'start',turn:n,step:1,attemptId:'synthetic-'+n}});}
 turn(1,'task-result-synthetic');assert.equal(registration.origin(),null);
 state.replyPermits.g.nativeMessageId='message-synthetic';state.messages.m={nativeMessageId:'message-synthetic'};
 turn(2,'message-synthetic');assert.equal(registration.origin().trigger_type,'natural_user');
});
