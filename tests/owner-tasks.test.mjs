import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createBridge} from '../src/index.mjs';
import {digest} from '../src/state.mjs';
import {OWNER_TASK_TOOLS} from '../src/owner-tasks.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));
const owner={id:'owner',title:'SYNTHETIC OWNER',mode:'private',owner:true};
const group={id:'group',title:'SYNTHETIC GROUP',mode:'group',owner:false};
const binding=digest(JSON.stringify([owner.id,owner.title,owner.mode,owner.owner]));
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function settled(fn){for(let i=0;i<50;i++){if(fn())return;await turn();}assert.fail('did not settle');}

async function fixture(t,options={}){
 const root=fs.mkdtempSync(path.join(repo,'.git','t014-test-')),listeners=new Map(),agents=new Map(),runs=new Map(),calls=[],searches=[];
 let bridge,admissionGate,cancelGate,starts=0,disposals=0,flushFail=false;
 const python=process.env.XQ_TEST_PYTHON;
 assert.ok(python,'XQ_TEST_PYTHON required');
 const approvalFile=path.join(root,'synthetic-shell-approval.json');
 fs.writeFileSync(approvalFile,JSON.stringify({approved:true,ownerChatId:'owner',ownerBinding:binding,capability:'host-administrator-powershell',approvalId:'synthetic-t014'}));
 const host={on(name,fn){const set=listeners.get(name)||new Set();listeners.set(name,set);set.add(fn);return ()=>set.delete(fn);},
  get:name=>name==='subagents'?native:undefined,sessions:{flush:async()=>!flushFail}};
 async function create(options){
  const tools=new Map(),guards=[],restrictions=[],sections=[],cleanups=[];
  const id=options.sessionId||options.resumeSessionId;
  const agent={id,status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{id,seq:0,header:{parentSession:options.meta?.parentSession},eventAt:()=>null},
   followup:m=>calls.push({agent:id,...m})};
  const ctx={tools:{register:d=>tools.set(d.name,d),restrict:r=>restrictions.push(r),guard:g=>guards.push(g)},
   systemPrompt:{section:s=>sections.push(s)},effect(fn){cleanups.push(fn());},on:host.on};
  agent.ctx=ctx;
  const handle={agent,tools,guards,restrictions,sections,async dispose(){for(const c of cleanups.splice(0))await c?.();agents.delete(id);}};
  await options.setup?.(ctx,agent);agents.set(id,handle);
  for(const fn of listeners.get('agent/created')||[])await fn({agent,source:'startup'});
  return handle;
 }
 host.agents={create,resume:create,get:id=>agents.get(id)?.agent};
 // Published contracts: reserved childId, awaited agent/created, caller delivery,
 // cancellation before publication, and result settlement after teardown.
 const native={getProvider:()=>({prepareContinuable:async()=>({})}),async startActivation(spec){
  starts++;assert.equal(spec.provider,'spawn');assert.equal(spec.delivery,'caller');
  if(admissionGate)await admissionGate;
  spec.signal.throwIfAborted();
  const h=await create({sessionId:spec.childId,meta:{parentSession:spec.request.parent.id}});
  const completion=Promise.withResolvers();let done=false,disposing;
  const finish=async result=>{if(done)return;done=true;await h.dispose();disposals++;completion.resolve(result);};
  const activation={childId:spec.childId,result:completion.promise,dispose(){
   return disposing??=(async()=>{if(done)return;if(cancelGate)await cancelGate;await finish({stopReason:'aborted',output:[]});})();
  }};
  runs.set(spec.childId,{h,spec,activation,finish});
  return activation;
 }};
 async function open(){
  bridge=await createBridge(host,{stateDir:root,mode:'mock',chats:[owner,group],model:{provider:'synthetic',model:'synthetic'},autoImages:false,autoFiles:false,
   searchEnabled:true,python,ownerTasks:{enabled:options.enabled!==false},ownerIntegrations:{enabled:true},
   ownerFiles:{enabled:true,python,projects:{synthetic:root}},ownerShell:{enabled:true,python,approvalFile},
   ...(options.legacy?{longTasks:{enabled:true,isolated:true,root:path.join(root,'legacy-tasks')}}:{})},
   {driver:{call:async()=>{throw Error('NO_WECHAT_UI');}},defineTool:x=>x,
    ownerServices:{worker:async(request,{signal})=>{searches.push(request);if(options.search)await options.search(signal);return {text:'SYNTHETIC SEARCH',truncated:false};},pageWorker:async()=>({text:'SYNTHETIC PAGE'})}});
  bridge.core.resume();await bridge.core.handle('owner');await bridge.core.handle('group');
  return bridge;
 }
 t.after(async()=>{await bridge?.core.close();assert.ok(path.resolve(root).startsWith(path.join(repo,'.git','t014-test-')));fs.rmSync(root,{recursive:true,force:true});});
 await open();
 const f={root,runs,calls,searches,get bridge(){return bridge;},get starts(){return starts;},get disposals(){return disposals;},
  setAdmission:p=>admissionGate=p,setCancel:p=>cancelGate=p,
  failFlush:value=>flushFail=value,
  handle:()=>bridge.core.handles.get('owner'),
  async call(h,name,args={},extra={}){
   const exec={agent:h.agent,callId:randomUUID(),signal:new AbortController().signal,...extra};
   for(const guard of h.guards){const denial=guard({name});if(denial)throw Error(denial);}
   assert.ok(h.tools.has(name),'tool registered: '+name);return h.tools.get(name).execute(args,exec);
  },
  start:(args={goal:'SYNTHETIC GOAL'},extra={})=>f.call(f.handle(),'task_start',args,extra),
  list:()=>f.call(f.handle(),'task_list'),
  cancel:id=>f.call(f.handle(),'task_cancel',{id}),
  async complete(id,text='SYNTHETIC RESULT',stopReason='completed'){
   await runs.get(id).finish({output:[{type:'text',text}],stopReason});
   await settled(()=>fs.existsSync(path.join(root,'owner-tasks.json'))&&JSON.parse(fs.readFileSync(path.join(root,'owner-tasks.json'))).tasks.find(r=>r.id===id)?.endedAt);
  },
  async reopen(change){await bridge.core.close();change?.();return open();}
 };
 return f;
}

test('native tasks admit three immediately, keep foreground usable, and deduplicate start calls',async t=>{
 const f=await fixture(t,{legacy:true}),callId='same-native-call';
 const a=await f.start(undefined,{callId}),b=await f.start(),c=await f.start();
 assert.equal(f.starts,3);assert.equal((await f.start(undefined,{callId})).id,a.id);
 await assert.rejects(f.start(),/TASK_CONCURRENCY_LIMIT/);
 assert.deepEqual(new Set(f.runs.get(a.id).h.tools.keys()),new Set(['owner_powershell','owner_command','owner_file_read','owner_file_write','owner_search','owner_fetch']));
 assert.equal(f.handle().tools.has('owner_long_task'),false);assert.equal(f.handle().tools.has('wechat_task'),false);assert.equal(f.bridge.taskManager,null);
 f.handle().agent.followup({id:'ordinary-chat',content:[{type:'text',text:'SYNTHETIC NORMAL CHAT'}]});
 assert.equal(f.calls.at(-1).id,'ordinary-chat');assert.equal(f.starts,3);
 await Promise.all([a,b,c].map(r=>f.complete(r.id)));
 assert.equal(f.disposals,3);assert.ok((await f.list()).every(r=>r.status==='completed'));
 const data=JSON.parse(fs.readFileSync(path.join(f.root,'owner-tasks.json')));
 assert.ok(data.tasks.every(r=>r.startedAt&&r.endedAt&&r.summary==='SYNTHETIC RESULT'));
 assert.equal(JSON.stringify(data).includes('SYNTHETIC GOAL'),false);
});

test('completion receipts accept once even if task queue marker was not saved before restart',async t=>{
 const f=await fixture(t),row=await f.start();await f.complete(row.id);
 for(let i=0;i<4;i++){f.bridge.ownerTasks.drain();await f.bridge.core.drainTaskCompletions();}
 const notices=()=>f.calls.filter(m=>m.source?.kind==='xiaoqian-owner-task-result');
 assert.equal(notices().length,1);assert.equal(notices()[0].agent,f.handle().agent.id);
 await f.reopen(()=>{
  const file=path.join(f.root,'owner-tasks.json'),data=JSON.parse(fs.readFileSync(file));data.tasks[0].queued=false;fs.writeFileSync(file,JSON.stringify(data));
 });
 await f.bridge.core.drainTaskCompletions();assert.equal(notices().length,1);assert.equal(f.starts,1);
});

test('cancel holds capacity until teardown and cancels an in-flight delegated tool',async t=>{
 const searching=Promise.withResolvers();let toolAborted=false;
 const f=await fixture(t,{search:signal=>new Promise((resolve,reject)=>{searching.resolve();signal.addEventListener('abort',()=>{toolAborted=true;reject(Error('CANCELLED'));},{once:true});})});
 const [a,b,c]=await Promise.all([f.start(),f.start(),f.start()]);
 const tool=f.call(f.runs.get(a.id).h,'owner_search',{query:'synthetic'});const checked=assert.rejects(tool,/OWNER_TOOL_FAILED/);await searching.promise;
 const gate=Promise.withResolvers();f.setCancel(gate.promise);const cancel=f.cancel(a.id);
 await settled(()=>toolAborted);await assert.rejects(f.start(),/TASK_CONCURRENCY_LIMIT/);
 gate.resolve();await cancel;await checked;assert.equal((await f.list()).find(r=>r.id===a.id).status,'cancelled');
 f.setCancel(null);const d=await f.start();await f.complete(b.id);await f.complete(c.id);await f.complete(d.id);
 assert.equal((await f.cancel(a.id)).status,'cancelled');
});

test('ambiguous notification flush is not replayed after host restart',async t=>{
 const f=await fixture(t),row=await f.start();f.failFlush(true);await f.complete(row.id);
 await f.bridge.core.drainTaskCompletions();
 assert.equal(Object.values(f.bridge.core.state('owner').taskCompletions)[0].status,'unknown');
 f.failFlush(false);await f.reopen();f.bridge.ownerTasks.drain();await f.bridge.core.drainTaskCompletions();
 assert.equal(f.calls.filter(m=>m.source?.kind==='xiaoqian-owner-task-result').length,1);
});

test('cancel during native admission aborts before creating a child',async t=>{
 const f=await fixture(t),gate=Promise.withResolvers();f.setAdmission(gate.promise);
 const start=f.start(),checked=assert.rejects(start,/TASK_START_FAILED/);
 await settled(()=>f.starts===1);const [row]=await f.list(),cancel=f.cancel(row.id);gate.resolve();
 await checked;await cancel;assert.equal((await f.list())[0].status,'cancelled');assert.equal(f.runs.size,0);
});

test('shutdown and crash recovery interrupt tasks once, with no resume or replay',async t=>{
 const f=await fixture(t),row=await f.start();
 await f.reopen(()=>{
  const file=path.join(f.root,'owner-tasks.json'),data=JSON.parse(fs.readFileSync(file));
  // Synthetic crash snapshot: host died before writing a terminal state.
  data.tasks[0].status='running';data.tasks[0].endedAt=null;fs.writeFileSync(file,JSON.stringify(data));
 });
 const [result]=await f.list();assert.equal(result.id,row.id);assert.equal(result.status,'interrupted');assert.ok(result.endedAt);
 await f.bridge.core.drainTaskCompletions();assert.equal(f.starts,1);
 assert.equal(f.calls.filter(m=>m.source?.kind==='xiaoqian-owner-task-result').length,1);
 await f.reopen();await f.bridge.core.drainTaskCompletions();assert.equal(f.starts,1);
 assert.equal(f.calls.filter(m=>m.source?.kind==='xiaoqian-owner-task-result').length,1);
});

test('delegated Shell, file read/write, and search execute through existing owner bindings',async t=>{
 const f=await fixture(t),row=await f.start(),child=f.runs.get(row.id).h;
 const shell=await f.call(child,'owner_powershell',{script:'[Console]::WriteLine("SYNTHETIC TASK SHELL")',cwd:f.root,timeoutMs:10000});
 assert.equal(shell.exitCode,0);assert.equal(shell.jobExitConfirmed,true);assert.match(shell.output,/SYNTHETIC TASK SHELL/);
 await f.call(child,'owner_file_write',{projectId:'synthetic',path:'synthetic.txt',text:'SYNTHETIC FILE'});
 const read=await f.call(child,'owner_file_read',{projectId:'synthetic',path:'synthetic.txt'});assert.match(read.text,/SYNTHETIC FILE/);
 const search=await f.call(child,'owner_search',{query:'SYNTHETIC QUERY'});assert.match(search.text,/SYNTHETIC SEARCH/);
 const page=await f.call(child,'owner_fetch',{url:'https://example.invalid/synthetic'});assert.match(page.text,/SYNTHETIC PAGE/);
 await assert.rejects(f.call(f.handle(),'owner_powershell',{script:'Get-Date',cwd:f.root}),/OWNER_ORIGIN_REQUIRED/);
 assert.equal(f.bridge.ownerTasks.shellOrigin({agent:child.agent,bindingId:binding,callId:'forged',commandHash:'forged'}),null);
 await f.complete(row.id);
});

test('group, forged agents, unapproved tools, and revoked owners cannot use task authority',async t=>{
 const f=await fixture(t),groupHandle=f.bridge.core.handles.get('group');
 for(const name of OWNER_TASK_TOOLS){assert.equal(groupHandle.tools.has(name),false);await assert.rejects(f.call(groupHandle,name),/WECHAT_TOOL_SCOPE_DENIED/);}
 await assert.rejects(f.call(f.handle(),'task_start',{goal:'synthetic'},{agent:groupHandle.agent}),/OWNER_ONLY/);
 for(const name of ['wechat_reply','task_start','owner_plugins','owner_attachment_read','powershell'])await assert.rejects(f.start({goal:'synthetic',tools:[name]}),/TASK_TOOL_DENIED/);
 const row=await f.start({goal:'synthetic',tools:['owner_search']}),child=f.runs.get(row.id).h;
 assert.deepEqual([...child.tools.keys()],['owner_search']);assert.deepEqual(child.restrictions,[{allow:[]}]);
 assert.equal(child.guards[0]({name:'wechat_reply'}),'TASK_TOOL_DENIED');
 assert.equal(child.guards[0]({name:'task_start'}),'TASK_TOOL_DENIED');
 f.bridge.core.pause();await assert.rejects(f.call(child,'owner_search',{query:'synthetic'}),/OWNER_TASK_REVOKED/);
 f.bridge.core.resume();f.bridge.core.state('owner').rotationFence=true;
 await assert.rejects(f.call(child,'owner_search',{query:'synthetic'}),/OWNER_TASK_REVOKED/);
 delete f.bridge.core.state('owner').rotationFence;
 await f.complete(row.id);
});

test('empty tool subset, native failures, start cancellation, and disabled flag remain explicit',async t=>{
 const f=await fixture(t),row=await f.start({goal:'synthetic',tools:[]});
 assert.equal(f.runs.get(row.id).h.tools.size,0);await f.complete(row.id,'SYNTHETIC PARTIAL','max-tokens');
 assert.equal((await f.list())[0].status,'failed');
 const signal=AbortSignal.abort();await assert.rejects(f.start(undefined,{signal}),/TOOL_CANCELLED/);
 const disabled=await fixture(t,{enabled:false});assert.equal(disabled.bridge.ownerTasks,null);
 for(const name of OWNER_TASK_TOOLS)assert.equal(disabled.handle().tools.has(name),false);
});
