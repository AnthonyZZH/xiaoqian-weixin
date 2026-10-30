import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import crypto from 'node:crypto';import {isOwnedProviderShim} from '../src/owner-balance.mjs';
import {buildIsolatedAdapter} from '../src/isolated-provider-builder.mjs';
import {buildOfficialBalanceShim} from '../src/balance-shim-builder.mjs';
import {taskWireBudget} from '../vendor/isolated-owner/wire-budget.mjs';
const nativePackageRoot=process.env.XQ_NATIVE_PACKAGE_ROOT||'C:/xiaoqian/app/dsh/node_modules/@deepseek-ai';
test('pinned actual DeepSeek adapter final HTTP consumes task budget and preserves body/session binding',async()=>{
 const base=path.resolve('.test-scratch');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'isolated-provider-'));
 const priorFetch=globalThis.fetch;let wires=0;const captured=[];
 taskWireBudget.transportAttached=true;const ctl=new AbortController();let admits=0;
 const release=taskWireBudget.install('synthetic-native-session',{signal:ctl.signal,admit(){if(++admits>1)throw Error('TASK_REQUEST_LIMIT');}});
 try{
  const built=buildIsolatedAdapter({nativePackageRoot,outputDir:root});
  const shim=buildOfficialBalanceShim({nativePackageRoot,outputDir:root,isolatedTasks:true});
  assert.match(fs.readFileSync(shim.file,'utf8'),/xiaoqianIsolatedProvider/);
  assert.ok(fs.readFileSync(shim.file,'utf8').includes(pathToFileURL(built.file).href));
  const {DeepSeekAdapter,resolveAdapterOptions}=await import(pathToFileURL(built.file));
  const connection=resolveAdapterOptions({baseURL:'https://synthetic.invalid',models:[{id:'synthetic',contextWindow:8192}],maxTokens:64});
  const adapter=new DeepSeekAdapter({options:()=>connection,resolveAuth:async()=>({headers:{}}),resolveUserId:()=> 'synthetic',resolveFiles:()=>({}),prepareExtensions:async()=>({fields:{},accept:async()=>{}})});
  globalThis.fetch=async(url,init)=>{
   assert.equal(new URL(url).hostname,'synthetic.invalid');wires++;captured.push({url,init});
   const events=[
    ['message_start',{type:'message_start',message:{id:'synthetic-output',type:'message',role:'assistant',model:'synthetic',content:[],usage:{input_tokens:20,output_tokens:0}}}],
    ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],
    ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'SYNTHETIC'}}],
    ['content_block_stop',{type:'content_block_stop',index:0}],
    ['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}}],
    ['message_stop',{type:'message_stop'}]
   ].map(([name,data])=>'event: '+name+'\ndata: '+JSON.stringify(data)+'\n\n').join('');
   return new Response(events,{status:200,headers:{'content-type':'text/event-stream'}});
  };
  const options={provider:'deepseek',model:'synthetic',sessionId:'synthetic-native-session',system:'SYNTHETIC SYSTEM',tools:[],messages:[{id:'synthetic-input',role:'user',content:[{type:'text',text:'SYNTHETIC USER'}]}],signal:ctl.signal};
  const chunks=[];for await(const chunk of adapter.stream(options))chunks.push(chunk);
  assert.ok(chunks.some(c=>c.type==='text-delta'&&c.text==='SYNTHETIC'));assert.equal(wires,1);
  const payload=JSON.parse(captured[0].init.body);assert.equal(payload.system,'SYNTHETIC SYSTEM');assert.ok(JSON.stringify(payload.messages).includes('SYNTHETIC USER'));
  assert.equal(captured[0].init.headers['x-deepseek-harness-session-id'],'synthetic-native-session');assert.ok(captured[0].init.signal instanceof AbortSignal);
  await assert.rejects(async()=>{for await(const _ of adapter.stream(options)){};});
  assert.equal(wires,1);assert.equal(admits,2);
 }finally{release();taskWireBudget.transportAttached=false;globalThis.fetch=priorFetch;fs.rmSync(root,{recursive:true,force:true});}
});

test('provider swap recognizes only intact preceding generated shims in owned directory',()=>{
 const base=path.resolve('.test-scratch');fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'old-provider-'));
 try{const dir=path.join(root,'provider-shim');fs.mkdirSync(dir);const source='// synthetic preceding generated provider',hash=crypto.createHash('sha256').update(source).digest('hex'),file=path.join(dir,'provider-shim-'+hash.slice(0,24)+'.mjs');fs.writeFileSync(file,source);assert.equal(isOwnedProviderShim(pathToFileURL(file).href,root),true);assert.equal(isOwnedProviderShim(pathToFileURL(file).href,path.join(root,'other')),false);fs.appendFileSync(file,' tampered');assert.equal(isOwnedProviderShim(pathToFileURL(file).href,root),false);assert.equal(isOwnedProviderShim('https://synthetic.invalid/provider-shim.mjs',root),false);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
