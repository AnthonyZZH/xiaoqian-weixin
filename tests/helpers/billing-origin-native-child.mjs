import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
import {createBillingCollector,billingProviderFetch} from '../../src/billing/collector.mjs';import {bindOwnerBilling} from '../../src/billing/owner-binding.mjs';import {WeChatCore} from '../../src/core.mjs';
const root='C:/xiaoqian/app/dsh/node_modules/@deepseek-ai/',load=n=>import(pathToFileURL(root+n+'/lib/index.js').href),sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const {Context}=await load('cordis'),{LlmAdapter}=await load('dsh-llm'),ctx=new Context(),fibers=[],errors=[],nativeFrames=[];
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'xq-origin-native-')),billing=createBillingCollector({root:path.join(scratch,'metadata')});let core,request=0,sends=0;
ctx.on('agent/error',x=>errors.push(String(x?.error?.code||'error')));
ctx.on('agent/assistant-stream',x=>{if(x.frame?.type==='start')nativeFrames.push({turn:x.frame.turn,step:x.frame.step,id:x.frame.attemptId});});
const text=[{type:'message_start',message:{usage:{input_tokens:10,cache_read_input_tokens:90,cache_creation_input_tokens:0,output_tokens:0}}},{type:'message_delta',usage:{output_tokens:5}},{type:'message_stop'}].map(v=>'data: '+JSON.stringify(v)+'\n\n').join('');
class Offline extends LlmAdapter{
 async *stream(options){
  request++;
  const init={body:JSON.stringify({model:options.model,max_tokens:32,system:'SYNTHETIC_ONLY',tools:[],messages:[{role:'user',content:[{type:'text',text:'SYNTHETIC_PAYLOAD'}]}]})};
  if(request===1){const failed=await billingProviderFetch(async()=>new Response('',{status:503}),options,'https://api.deepseek.com/anthropic/v1/messages',init);await failed.text();}
  await(await billingProviderFetch(async()=>new Response(text),options,'https://api.deepseek.com/anthropic/v1/messages',init)).text();
  yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'SYNTHETIC_DONE'};yield {type:'block-end',index:0,block:{type:'text',text:'SYNTHETIC_DONE'}};yield {type:'finish',reason:{kind:'stop'}};
 }
}
try{
 for(const n of ['dsh-system-prompt','dsh-session','dsh-agent','dsh-llm','dsh-tools','dsh-session-projection','dsh-agent-loop'])fibers.push(ctx.plugin((await load(n)).default,{}));
 fibers.push(ctx.plugin(await load('dsh-session-persistence-jsonl'),{root:path.join(scratch,'sessions'),compression:'none'}));
 fibers.push(ctx.plugin({inject:['llm'],apply(c){c.llm.registerAdapter(['deepseek-official'],new Offline());}},{}));
 for(const f of fibers)await f.await();
 core=new WeChatCore({stateDir:path.join(scratch,'bridge'),chats:[{id:'owner',title:'SYNTHETIC',mode:'private',owner:true}],agents:ctx.agents,sessions:ctx.sessions,
 driver:{resume(){},pause(){},close(){},async call(){sends++;throw Error('NO_MESSAGE_DISPATCH');}},
 initiative:{resume(){},pause(){},close(){},async heard(){},async completed(){return true;}},model:{provider:'deepseek-official',model:'deepseek-flash'},
 registerAgent:async(agentCtx,agent,chat)=>bindOwnerBilling({collector:billing,getCore:()=>core,agentCtx,agent,chat})});
 core.resume();await core.ingest({chatId:'owner',messages:[{id:'SYNTHETIC_INPUT',text:'SYNTHETIC_USER'}]});
 const agent=core.handles.get('owner').agent;await agent.whenIdle();await core.serial(()=>{});
 await core.wake('owner',{wakeId:'SYNTHETIC_WAKE',reason:'opening'});await agent.whenIdle();await core.serial(()=>{});
 assert.deepEqual(errors,[]);assert.equal(request,2);
 const rows=fs.readdirSync(path.join(scratch,'metadata')).map(n=>JSON.parse(fs.readFileSync(path.join(scratch,'metadata',n),'utf8'))).sort((a,b)=>a.started_at.localeCompare(b.started_at)||a.complete-b.complete);
 assert.equal(rows.length,3);assert.ok(rows.every(v=>v.origin?.link_status==='host_receipt_and_native_attempt'),JSON.stringify(rows.map(v=>v.origin)));
 for(const row of rows){
  const o=row.origin,f=nativeFrames.find(f=>f.turn===o.native_turn&&f.step===o.native_step);assert.ok(f);
  assert.equal(o.native_attempt_hash,sha(o.agent_lifecycle+'\0'+f.id));
  assert.ok(Object.values(core.state('owner').replyPermits).some(g=>g.turn===o.native_turn&&o.source_receipt_hashes.includes(sha(g.nativeMessageId))));
  assert.equal(o.target_category,'owner_private');
 }
 assert.equal(rows[0].origin.native_attempt_hash,rows[1].origin.native_attempt_hash);assert.notEqual(rows[1].origin.native_attempt_hash,rows[2].origin.native_attempt_hash);
 const serialized=JSON.stringify(rows);assert.equal(serialized.includes('SYNTHETIC_INPUT'),false);assert.equal(serialized.includes('SYNTHETIC_USER'),false);assert.equal(serialized.includes('SYNTHETIC_WAKE'),false);assert.equal(serialized.includes('SYNTHETIC_PAYLOAD'),false);
 console.log(JSON.stringify({native:true,origins:rows.map(v=>v.origin.trigger_type),physicalAttempts:rows.length,nativeAttempts:nativeFrames.length,sends}));
}finally{await core?.close();billing.close();for(const f of fibers.reverse())await f.dispose();fs.rmSync(scratch,{recursive:true,force:true});}
