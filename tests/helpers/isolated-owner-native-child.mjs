import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';import {setTimeout as wait} from 'node:timers/promises';
const project=path.resolve(process.argv[2]),scratch=path.resolve(process.argv[3]);
assert.equal(path.dirname(scratch),path.join(project,'.test-scratch'));
const root=process.env.XQ_NATIVE_PACKAGE_ROOT||'C:/xiaoqian/app/dsh/node_modules/@deepseek-ai/';
const load=async n=>import(pathToFileURL(path.join(root,n,'lib/index.js')).href);
const {Context}=await load('cordis'),{LlmAdapter}=await load('dsh-llm'),{defineTool}=await load('dsh-tools');
const {TaskWireBudget}=await import(pathToFileURL(path.join(project,'vendor/isolated-owner/wire-budget.mjs')));
const {createBridge}=await import(pathToFileURL(path.join(project,'src/index.mjs')));
const ctx=new Context(),fibers=[],errors=[],created=[],requests=[],gates=new Map(),definitions=new Map();
const budget=new TaskWireBudget();budget.transportAttached=true;
let bridge,statusExtension,networkAttempts=0,physical=0,sends=0;
globalThis.fetch=async()=>{networkAttempts++;throw Error('OFFLINE_NETWORK_DENIED');};
ctx.provide('xiaoqianIsolatedProvider',{provider:'offline',budget});
ctx.on('agent/error',x=>errors.push(String(x?.error?.message||x?.message||'agent-error')));
ctx.on('agent/created',({agent,source})=>created.push({id:agent.id,source}));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function until(fn,label,ms=12000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await wait(10);}throw Error('NATIVE_TIMEOUT: '+label);}
class Offline extends LlmAdapter{
 async *stream(options){
  const sid=String(options.sessionId);requests.push({sessionId:sid,provider:options.provider,messages:JSON.stringify(options.messages),tools:(options.tools||[]).map(x=>x.name)});
  const isolated=sid.startsWith('xq-isolated-');
  if(isolated){
   await budget.fetch(async(_url,init)=>{assert.ok(init.signal);physical++;return{};},{sessionId:sid},'offline://synthetic',{});
   const gate=deferred();gates.set(sid,gate);
   const cancel=()=>gate.resolve();options.signal?.addEventListener('abort',cancel,{once:true});
   try{await gate.promise;options.signal?.throwIfAborted();}finally{options.signal?.removeEventListener('abort',cancel);}
  }
  const text=isolated?JSON.stringify({text:'SYNTHETIC UPDATED PERSONA'}):'Synthetic foreground completed';
  yield{type:'block-start',index:0,blockType:'text'};
  yield{type:'text-delta',index:0,text};
  yield{type:'block-end',index:0,block:{type:'text',text}};
  yield{type:'finish',reason:{kind:'stop'}};
 }
}
try{
 for(const n of ['dsh-system-prompt','dsh-session','dsh-agent','dsh-llm','dsh-tools','dsh-session-projection','dsh-agent-loop'])fibers.push(ctx.plugin((await load(n)).default,{}));
 fibers.push(ctx.plugin(await load('dsh-session-persistence-jsonl'),{root:path.join(scratch,'sessions'),compression:'none'}));
 fibers.push(ctx.plugin((await load('dsh-session-query')).default,{}));
 fibers.push(ctx.plugin({inject:['llm'],apply(c){c.llm.registerAdapter(['offline'],new Offline());}},{}));
 for(const f of fibers)await f.await();
 const driver={maxChars:1000,resume(){},pause(){},async close(){},async call(){sends++;throw Error('OFFLINE_WECHAT_FORBIDDEN');}};
 bridge=await createBridge(ctx,{stateDir:path.join(scratch,'bridge'),mode:'mock',nativePackageRoot:root,
  model:{provider:'offline',model:'offline',maxTokens:2048},ownerIntegrations:{enabled:true},
  longTasks:{enabled:true,isolated:true,root:path.join(scratch,'tasks')},
  chats:[{id:'owner',title:'SYNTHETIC OWNER',mode:'private',owner:true,persona:'SYNTHETIC BASE'},
   {id:'group',title:'SYNTHETIC GROUP',mode:'group',owner:false}]},
  {driver,defineTool:spec=>{if(spec.name.startsWith('owner_long_task'))definitions.set(spec.name,spec);return defineTool(spec);}});
 bridge.core.resume();
 const owner=(await bridge.core.handle('owner')).agent,group=(await bridge.core.handle('group')).agent;
 const submit=definitions.get('owner_long_task'),status=definitions.get('owner_long_task_status'),cancel=definitions.get('owner_long_task_cancel');
 assert.ok(submit&&status&&cancel,'real createBridge must register isolated task tools');
 const invoke=(spec,args,agent=owner,id='synthetic-call')=>spec.execute(args,{agent,callId:id,signal:new AbortController().signal});
 await assert.rejects(async()=>invoke(submit,{kind:'persona-edit',task:'SYNTHETIC revise persona'},group,'group-denied'),/OWNER|SCOPE/);
 const queued=await Promise.race([Promise.resolve(invoke(submit,{kind:'persona-edit',task:'SYNTHETIC revise persona'},owner,'persona-call')),wait(2000).then(()=>{throw Error('SUBMISSION_BLOCKED_FOREGROUND');})]);
 assert.ok(queued.task_id);assert.equal(queued.status,'queued');
 const sid='xq-isolated-'+queued.task_id;
 await until(()=>gates.has(sid),'isolated native stream');
 assert.ok(ctx.agents.get(sid),'actual independent native Agent must be registered');
  const statusSource=bridge.core.capabilities.isolatedTaskStatusRows;assert.equal(typeof statusSource,'function');
 const originalRead=fs.readFileSync,originalList=fs.readdirSync;let metadata;
 try{fs.readFileSync=()=>{throw Error('STATUS_FILE_READ_FORBIDDEN');};fs.readdirSync=()=>{throw Error('STATUS_FILE_SCAN_FORBIDDEN');};metadata=statusSource();}finally{fs.readFileSync=originalRead;fs.readdirSync=originalList;}
 const taskMetadata=metadata.find(r=>r.id===queued.task_id);assert.equal(taskMetadata.loaded,true);assert.equal(taskMetadata.sessionId,sid);assert.ok(!Object.hasOwn(taskMetadata,'agent'));assert.ok(!Object.hasOwn(taskMetadata,'result'));assert.ok(!JSON.stringify(metadata).includes('SYNTHETIC BASE'));
 const {createStatusExtension}=await import(pathToFileURL(path.join(project,'tools/owner-session-status-extension.mjs')));
 statusExtension=createStatusExtension({core:bridge.core,defineTool:spec=>{definitions.set(spec.name,spec);return defineTool(spec);},scheduler:{setInterval(){return{unref(){}};},clearInterval(){}}});
 assert.equal(statusExtension.inspect().longTaskCoverage,true);
 const statusTool=definitions.get('owner_sessions_status');assert.ok(statusTool);
 const safeStatus=await invoke(statusTool,{});assert.equal(safeStatus.coverage.isolatedTaskRegistry,true);
 const visible=safeStatus.sessions.find(r=>r.id===queued.task_id);assert.equal(visible.loaded,true);assert.equal(visible.state,'running');assert.equal(visible.queueLength,0);
 assert.ok(!JSON.stringify(safeStatus).includes('SYNTHETIC BASE'));assert.ok(!JSON.stringify(safeStatus).includes('SYNTHETIC revise persona'));
 await assert.rejects(()=>invoke(statusTool,{},group,'group-status-denied'),/OWNER_ONLY/);
 const assembly=await owner.ctx.systemPrompt.assemble({scope:owner,agent:owner});assert.ok(assembly.tools.some(t=>t.name==='owner_sessions_status'));
 assert.notEqual(sid,owner.id);assert.equal(bridge.features.persona('owner'),'SYNTHETIC BASE');
 const childRequest=requests.find(r=>r.sessionId===sid);assert.deepEqual(childRequest.tools,[]);
 assert.ok(childRequest.messages.includes('SYNTHETIC BASE'));assert.ok(!childRequest.messages.includes('SYNTHETIC FOREGROUND PRIVATE MARKER'));
 await bridge.core.ingest({chatId:'owner',messages:[{id:'foreground',text:'SYNTHETIC FOREGROUND PRIVATE MARKER'}]});
 await owner.whenIdle();assert.ok(gates.has(sid));assert.equal(bridge.features.persona('owner'),'SYNTHETIC BASE');
 assert.ok(requests.some(r=>r.sessionId===owner.id),'foreground model must progress while child is gated');
 gates.get(sid).resolve();
 const completed=await until(async()=>{const r=await invoke(status,{task_id:queued.task_id});return ['completed','failed','cancelled','unknown'].includes(r.status)&&r;},'task terminal');
 assert.equal(completed.status,'completed',JSON.stringify(completed));assert.equal(completed.result.applied,true);
 assert.equal(bridge.features.persona('owner'),'SYNTHETIC UPDATED PERSONA');
 assert.equal(ctx.agents.get(sid),undefined,'child native handle must be disposed before persona commit');
 if(typeof bridge.core.drainTaskCompletions==='function')await bridge.core.drainTaskCompletions('owner');
 await until(()=>owner.session.deriveMessages().some(m=>JSON.stringify(m.content).includes(queued.task_id)),'completion reached original owner Agent');
 await owner.whenIdle();assert.equal(await ctx.sessions.flush(owner.session),true);
 const query=ctx.get('sessionQuery');assert.ok(query?.readSession);
 const persisted=await query.readSession(sid);
 assert.ok(persisted.events.some(e=>e.type==='assistant/message'),'native JSONL must retain child result');
 const duplicate=await invoke(submit,{kind:'persona-edit',task:'SYNTHETIC revise persona'},owner,'persona-call');
 assert.equal(duplicate.task_id,queued.task_id);assert.equal(created.filter(x=>x.id===sid).length,1);
 const second=await invoke(submit,{kind:'reasoning',task:'SYNTHETIC cancellable task'},owner,'cancel-call'),secondSid='xq-isolated-'+second.task_id;
 await until(()=>gates.has(secondSid),'cancellable native stream');await invoke(cancel,{task_id:second.task_id},owner,'cancel-op');
 const cancelled=await until(async()=>{const r=await invoke(status,{task_id:second.task_id});return ['completed','failed','cancelled','unknown'].includes(r.status)&&r;},'native cancellation');
 assert.equal(cancelled.status,'cancelled',JSON.stringify(cancelled));
 assert.equal(bridge.features.persona('owner'),'SYNTHETIC UPDATED PERSONA');
 assert.equal(networkAttempts,0);assert.equal(sends,0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,nativeVersion:'0.2.1-rc.4',nativeLifecycle:true,offlineProvider:true,taskIDImmediate:true,independentAgent:true,foregroundProgress:true,personaCAS:true,completionInOriginalSession:true,queryReadback:true,nativeCancellation:true,noDuplicate:true,physicalFakeRequests:physical,networkAttempts,wechatSends:sends,paidCalls:0,errors}));
}finally{
 for(const gate of gates.values())gate.resolve();
 statusExtension?.close();await bridge?.core.close();
 for(const fiber of fibers.reverse())await fiber.dispose();
}
