import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {pathToFileURL} from 'node:url';
import {createBillingCollector,billingProviderFetch} from '../src/billing/collector.mjs';
import {buildBillingAdapter} from '../src/billing/adapter-builder.mjs';
import {buildOfficialBalanceShim} from '../src/balance-shim-builder.mjs';
const native='C:/xiaoqian/app/dsh/node_modules/@deepseek-ai';
const load=n=>import(pathToFileURL(path.join(native,n,'lib/index.js')).href);
const body={model:'deepseek-flash',max_tokens:32,system:'SYNTHETIC_PERSONA_DO_NOT_PERSIST',tools:[{name:'synthetic_tool',description:'SYNTHETIC_TOOL_DESC',input_schema:{type:'object'}}],messages:[{role:'user',content:[{type:'text',text:'SYNTHETIC_CHAT_DO_NOT_PERSIST'}]}]};
const context={sessionId:'SYNTHETIC_SESSION',provider:'deepseek-official',model:'deepseek-flash'};
function stream({missing=false,stop=true}={}){
 const usage={input_tokens:20,cache_read_input_tokens:80,cache_creation_input_tokens:0,output_tokens:0};if(missing)delete usage.cache_creation_input_tokens;
 return [{type:'message_start',message:{id:'synthetic',type:'message',role:'assistant',model:'deepseek-flash',content:[],usage}},
 {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
 {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'SYNTHETIC'}},
 {type:'content_block_stop',index:0},
 {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}},
 ...(stop?[{type:'message_stop'}]:[])].map(v=>'data: '+JSON.stringify(v)+'\n\n').join('');
}
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xq-billing-synthetic-')),c=createBillingCollector({root});t.after(()=>{c.close();fs.rmSync(root,{force:true,recursive:true});});
 const dispose=c.register({sessionId:context.sessionId,active:()=>true,policy:()=>({owner:true,version:1})});
 return {root,c,dispose,rows:()=>fs.readdirSync(root).filter(v=>v.endsWith('.json')).map(v=>JSON.parse(fs.readFileSync(path.join(root,v),'utf8')))};
}
test('metadata-only complete physical attempts pair exact hash and disjoint cache usage',async t=>{
 const {rows}=fixture(t);let calls=0;
 for(let i=0;i<3;i++){const init={method:'POST',body:JSON.stringify({...body,messages:[...body.messages,{role:'assistant',content:[{type:'text',text:'SYNTHETIC '+i}]}]}),headers:{Authorization:'SYNTHETIC_SECRET_MUST_NOT_PERSIST'}};
 const response=await billingProviderFetch(async(_u,received)=>{calls++;assert.equal(received,init);return new Response(stream());},context,'https://api.deepseek.com/anthropic/messages',init);await response.text();
 const row=rows().find(r=>r.request_hash===crypto.createHash('sha256').update(init.body).digest('hex'));assert.ok(row?.complete);}
 assert.equal(calls,3);const r=rows();assert.equal(new Set(r.map(v=>v.family)).size,1);assert.equal(new Set(r.map(v=>v.attempt_id)).size,3);assert.deepEqual(r[0].usage,{hit:80,miss:20,write:0,output:5});
 const text=JSON.stringify(r);for(const forbidden of ['SYNTHETIC_PERSONA','SYNTHETIC_CHAT','SYNTHETIC_TOOL_DESC','SYNTHETIC_SECRET','SYNTHETIC_SESSION'])assert.equal(text.includes(forbidden),false);
});
test('missing raw cache field remains unavailable rather than default zero',async t=>{
 const {rows}=fixture(t);await(await billingProviderFetch(async()=>new Response(stream({missing:true})),context,'https://api.deepseek.com/anthropic/messages',{body:JSON.stringify(body)})).text();
 assert.equal(rows()[0].complete,false);assert.equal(rows()[0].usage.write,null);assert.equal(rows()[0].field_presence.write,false);
});
test('stream cancellation and transport failure do not manufacture complete usage',async t=>{
 const {rows}=fixture(t);const response=await billingProviderFetch(async()=>new Response(stream({stop:false})),context,'https://api.deepseek.com/anthropic/messages',{body:JSON.stringify(body)});
 await response.body.cancel();await assert.rejects(billingProviderFetch(async()=>{throw Error('SYNTHETIC_SECRET_ERROR');},context,'https://api.deepseek.com/anthropic/messages',{body:JSON.stringify(body)}));
 assert.equal(rows().length,2);assert.ok(rows().every(r=>!r.complete));assert.equal(JSON.stringify(rows()).includes('SYNTHETIC_SECRET_ERROR'),false);
});
test('registration uniqueness, toggles, revoke, unrelated origins and closed collectors bypass',async t=>{
 const {root,c,dispose,rows}=fixture(t);assert.throws(()=>createBillingCollector({root}),/ALREADY_REGISTERED/);
 assert.throws(()=>c.register({sessionId:context.sessionId,active:()=>true,policy:()=>({})}),/ALREADY_REGISTERED/);
 const send=async(url='https://api.deepseek.com/anthropic/messages')=>(await billingProviderFetch(async()=>new Response(stream()),context,url,{body:JSON.stringify(body)})).text();
 c.setEnabled(false);await send();c.setEnabled(true);await send('https://example.invalid/anthropic/messages');assert.equal(rows().length,0);
 await send();assert.equal(rows().length,1);dispose();dispose();await send();assert.equal(rows().length,1);c.close();const next=createBillingCollector({root});next.close();
});
test('strict family changes for system, tools and host ACL',async t=>{
 const {rows}=fixture(t);for(const b of [body,{...body,system:'OTHER_SYNTHETIC'},{...body,tools:[]}]){
 await(await billingProviderFetch(async()=>new Response(stream()),context,'https://api.deepseek.com/anthropic/messages',{body:JSON.stringify(b)})).text();}
 assert.equal(new Set(rows().map(v=>v.family)).size,3);
});
test('installed SDK final serializer, extensions, provider mount/unmount, duplicates and balance shim composition',async t=>{
 const {root,rows}=fixture(t);const oldFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async(url,init)=>{calls++;assert.equal(url,'https://api.deepseek.com/anthropic/v1/messages');assert.equal(JSON.parse(init.body).dsh_synthetic_extension,1);return new Response(stream(),{headers:{'content-type':'text/event-stream'}});};
 t.after(()=>{globalThis.fetch=oldFetch;});
 const built=buildBillingAdapter({nativePackageRoot:native,outputDir:path.join(root,'shim')});
 assert.equal(buildBillingAdapter({nativePackageRoot:native,outputDir:path.join(root,'shim')}).sha256,built.sha256);
 const shim=buildOfficialBalanceShim({nativePackageRoot:native,outputDir:path.join(root,'shim'),billingCollector:true});
 const shimText=fs.readFileSync(shim.file,'utf8');assert.ok(shimText.includes('attachOfficialBalance'));assert.ok(shimText.includes('billing-adapter-'));
 const {DeepSeekAdapter}=await import(pathToFileURL(built.file).href);
 const connection={baseURL:'https://api.deepseek.com/anthropic',models:[{id:'deepseek-flash'}],maxTokens:32,defaults:{thinking:'disabled'},streamIdleTimeoutMs:2000};
 const adapter=new DeepSeekAdapter({options:()=>connection,resolveAuth:async()=>({headers:{Authorization:'SYNTHETIC_ONLY'}}),resolveUserId:()=> 'SYNTHETIC',prepareExtensions:async()=>({fields:{dsh_synthetic_extension:1},accept:async()=>{}})});
 const {Context}=await load('cordis');const {default:LlmRuntime}=await load('dsh-llm');const ctx=new Context(),f=ctx.plugin(LlmRuntime,{});await f.await();
 const holder=ctx.plugin({inject:['llm'],apply(c){c.llm.registerAdapter(['deepseek-official'],adapter);}},{});await holder.await();
 assert.throws(()=>ctx.llm.registerAdapter(['deepseek-official'],adapter),e=>e.code==='DUPLICATE_ADAPTER');
 try{
  const chunks=[];for await(const chunk of adapter.stream({...context,system:body.system,messages:[{id:'synthetic-user',role:'user',content:[{type:'text',text:'SYNTHETIC_CHAT_DO_NOT_PERSIST'}]}],tools:[],maxTokens:32,reasoningEffort:'off',signal:new AbortController().signal}))chunks.push(chunk);
  assert.equal(calls,1);assert.ok(chunks.some(v=>v.type==='finish'));assert.equal(rows().length,1);assert.equal(rows()[0].complete,true);assert.ok(rows()[0].meter_input>0);
 }finally{await holder.dispose();}
 const registration=ctx.llm.registerAdapter(['deepseek-official'],adapter);registration();assert.throws(()=>registration.replace(['deepseek-official']),e=>e.code==='REGISTRATION_DISPOSED');
 const again=ctx.llm.registerAdapter(['deepseek-official'],adapter);again();await f.dispose();
});
