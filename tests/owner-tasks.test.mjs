import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createBridge} from '../src/index.mjs';
import {digest} from '../src/state.mjs';
import {OWNER_TASK_TOOLS} from '../src/owner-tasks.mjs';

// Scratch state lives outside the working tree: in the enclosing .git when there is one, else the OS temp dir.
const enclosing=path.join(fileURLToPath(new URL('../../',import.meta.url)),'.git');
const scratch=path.join(fs.existsSync(enclosing)&&fs.statSync(enclosing).isDirectory()?enclosing:fs.realpathSync(os.tmpdir()),'t014-test-');
const owner={id:'owner',title:'SYNTHETIC OWNER',mode:'private',owner:true};
const group={id:'group',title:'SYNTHETIC GROUP',mode:'group',owner:false};
const binding=digest(JSON.stringify([owner.id,owner.title,owner.mode,owner.owner]));
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function settled(fn,label='condition'){for(let i=0;i<300;i++){if(fn())return;await turn();}assert.fail('did not settle: '+label);}

async function fixture(t,options={}){
 const root=fs.mkdtempSync(scratch),listeners=new Map(),agents=new Map(),runs=new Map(),calls=[],searches=[],sends=[],order=[];
 let bridge,cancelGate,starts=0,disposals=0,flushFail=false,nativeTurn=0;
 const python=process.env.XQ_TEST_PYTHON;
 assert.ok(python,'XQ_TEST_PYTHON required');
 const approvalFile=path.join(root,'synthetic-shell-approval.json');
 fs.writeFileSync(approvalFile,JSON.stringify({approved:true,ownerChatId:'owner',ownerBinding:binding,capability:'host-administrator-powershell',approvalId:'synthetic-t014'}));
 options.before?.(root);
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
 // Published contracts: reserved childId, awaited agent/created, caller delivery, and result settlement after teardown.
 const native={getProvider:()=>({prepareContinuable:async()=>({})}),async startActivation(spec){
  starts++;order.push('spawn');assert.equal(spec.provider,'spawn');assert.equal(spec.delivery,'caller');
  spec.signal.throwIfAborted();
  const h=await create({sessionId:spec.childId,meta:{parentSession:spec.request.parent.id}});
  const completion=Promise.withResolvers(),run={h,spec,prompt:spec.request.prompt[0].text,finished:false};let disposing;
  run.finish=async result=>{if(run.finished)return;run.finished=true;await h.dispose();disposals++;completion.resolve(result);};
  run.activation={childId:spec.childId,result:completion.promise,dispose(){
   return disposing??=(async()=>{if(run.finished)return;if(cancelGate)await cancelGate;await run.finish({stopReason:'aborted',output:[]});})();
  }};
  runs.set(spec.childId,run);
  return run.activation;
 }};
 async function open(){
  bridge=await createBridge(host,{stateDir:root,mode:'mock',chats:[owner,group],model:{provider:'synthetic',model:'synthetic'},autoImages:false,autoFiles:false,
   searchEnabled:true,python,ownerTasks:{enabled:options.enabled!==false,...(options.panel?{panel:options.panel}:{})},ownerIntegrations:{enabled:true},
   ownerFiles:{enabled:true,python,projects:{synthetic:root}},ownerShell:{enabled:true,python,approvalFile}},
   {driver:{call:async(op,args)=>{if(op==='send_text'){sends.push(args.text);order.push('send');return {status:'ok'};}throw Error('NO_WECHAT_UI');}},defineTool:x=>x,
    ownerServices:{worker:async(request,{signal})=>{searches.push(request);if(options.search)await options.search(signal);return {text:'SYNTHETIC SEARCH',truncated:false};},pageWorker:async()=>({text:'SYNTHETIC PAGE'})}});
  bridge.core.resume();await bridge.core.handle('owner');await bridge.core.handle('group');
  return bridge;
 }
 t.after(async()=>{await bridge?.core.close();assert.ok(path.resolve(root).startsWith(scratch));fs.rmSync(root,{recursive:true,force:true});});
 await open();
 const f={root,runs,calls,searches,sends,order,get bridge(){return bridge;},get starts(){return starts;},get disposals(){return disposals;},
  setCancel:p=>cancelGate=p,failFlush:value=>flushFail=value,
  handle:()=>bridge.core.handles.get('owner'),
  notices:()=>calls.filter(m=>m.source?.kind==='xiaoqian-owner-task-result'),
  progress:id=>bridge.ownerTasks.engine.progress(id),
  // A real owner message opens a native turn, which is what grants the reply permit used by the acknowledgement.
  async inbound(text='SYNTHETIC OWNER MESSAGE'){
   await bridge.core.ingest({chatId:'owner',messages:[{id:'m-'+randomUUID(),text}]});
   const message=calls.findLast(m=>m.source?.kind==='xiaoqian-wechat'),session=f.handle().agent.session;nativeTurn++;
   for(const fn of listeners.get('session/event')||[]){fn(session,{type:'turn/start',data:{turn:nativeTurn}});fn(session,{type:'user/message',data:{id:message.id}});}
  },
  async call(h,name,args={},extra={}){
   const exec={agent:h.agent,callId:randomUUID(),signal:new AbortController().signal,...extra};
   for(const guard of h.guards){const denial=guard({name});if(denial)throw Error(denial);}
   assert.ok(h.tools.has(name),'tool registered: '+name);return h.tools.get(name).execute(args,exec);
  },
  start:(args={title:'SYNTHETIC TASK',goal:'SYNTHETIC GOAL'},extra={})=>f.call(f.handle(),'task_start',args,extra),
  list:()=>f.call(f.handle(),'task_list'),
  cancel:id=>f.call(f.handle(),'task_cancel',{id}),
  retry:(id,stepId)=>f.call(f.handle(),'task_retry',{id,...(stepId?{stepId}:{})}),
  result:(id,stepId)=>f.call(f.handle(),'task_result',{id,...(stepId?{stepId}:{})}),
  // The unfinished child agent whose prompt mentions `match`.
  async spawned(match){let run;await settled(()=>run=[...runs.values()].find(r=>!r.finished&&r.prompt.includes(match)),'spawn of '+match);return run;},
  async complete(match,text='SYNTHETIC RESULT',stopReason='completed'){const run=await f.spawned(match);await run.finish({output:[{type:'text',text}],stopReason});return run;},
  async ended(id,status){await settled(()=>f.progress(id).status===status,'task '+id+' '+status);},
  async reopen(change){await bridge.core.close();change?.();return open();}
 };
 return f;
}

test('says 收到 first, runs independent steps in parallel, feeds results downstream, merges, and reports once',async t=>{
 const f=await fixture(t);await f.inbound();
 const started=await f.start({title:'SYNTHETIC RESEARCH',ack:'收到啦，我这就去查',steps:[
  {title:'STEP-A',goal:'GOAL-A'},{title:'STEP-B',goal:'GOAL-B'},{title:'STEP-C',goal:'GOAL-C',dependsOn:['s1','s2']}]});
 assert.equal(started.ack,'sent');assert.deepEqual(f.sends,['收到啦，我这就去查']);
 assert.equal(started.status,'running');assert.deepEqual(started.steps.map(s=>s.id),['s1','s2','s3','final']);
 await f.spawned('GOAL-A');await f.spawned('GOAL-B');
 assert.equal(f.order[0],'send','the acknowledgement is sent before any child agent starts');
 assert.equal(f.starts,2,'s1 and s2 run together; s3 waits');
 f.handle().agent.followup({id:'ordinary-chat',content:[{type:'text',text:'SYNTHETIC NORMAL CHAT'}]});
 assert.equal(f.calls.at(-1).id,'ordinary-chat');
 await f.complete('GOAL-A','RESULT-A');assert.equal(f.starts,2);await f.complete('GOAL-B','RESULT-B');
 const c=await f.spawned('GOAL-C');assert.match(c.prompt,/RESULT-A/);assert.match(c.prompt,/RESULT-B/);
 assert.deepEqual(new Set(c.h.tools.keys()),new Set(['owner_powershell','owner_command','owner_file_read','owner_file_write','owner_search','owner_fetch']));
 const listed=(await f.list())[0];assert.equal(listed.done,'2/4');assert.equal(listed.steps[2].status,'running');
 await f.complete('GOAL-C','RESULT-C');
 const merge=await f.spawned('汇总成给主人的最终交付');assert.equal(merge.h.tools.size,0);assert.match(merge.prompt,/RESULT-C/);
 await merge.finish({output:[{type:'text',text:'FINAL DELIVERABLE'}],stopReason:'completed'});
 await f.ended(started.id,'succeeded');assert.equal(f.disposals,4);
 for(let i=0;i<3;i++){f.bridge.ownerTasks.drain();await f.bridge.core.drainTaskCompletions();}
 assert.equal(f.notices().length,1);assert.match(f.notices()[0].content[0].text,/FINAL DELIVERABLE/);
 assert.equal((await f.result(started.id)).text,'FINAL DELIVERABLE');assert.equal((await f.result(started.id,'s1')).text,'RESULT-A');
 // A single-step task has no merge step, and an ack without 收到 gets it prefixed.
 await f.inbound();const single=await f.start({title:'SYNTHETIC SINGLE',ack:'马上',goal:'GOAL-SINGLE'});
 assert.equal(f.sends.at(-1),'收到，马上');assert.deepEqual(single.steps.map(s=>s.id),['s1']);
 await f.complete('GOAL-SINGLE','ONLY RESULT');await f.ended(single.id,'succeeded');assert.equal((await f.result(single.id)).text,'ONLY RESULT');
});

test('start is idempotent per call, works without a reply permit, queues beyond three, and rejects bad plans before acknowledging',async t=>{
 const f=await fixture(t),callId='same-native-call';
 const a=await f.start(undefined,{callId});assert.equal(a.ack,'not_sent:NO_REPLY_PERMIT');assert.equal(a.status,'running');
 const again=await f.start(undefined,{callId});assert.equal(again.id,a.id);assert.equal(again.duplicate,true);
 const b=await f.start(),c=await f.start(),d=await f.start();
 await settled(()=>f.starts===3);assert.equal(d.status,'queued');
 await f.inbound();
 await assert.rejects(f.start({title:'x',ack:'收到',steps:[{title:'a',goal:'a',dependsOn:['s2']},{title:'b',goal:'b',dependsOn:['s1']}]}),/循环依赖/);
 await assert.rejects(f.start({title:'x',ack:'收到',steps:[{title:'a',goal:'a',dependsOn:['nope']}]}),/不存在的步骤/);
 await assert.rejects(f.start({title:'x',ack:'收到',goal:''}),/TASK_GOAL_INVALID/);
 assert.deepEqual(f.sends,[],'no acknowledgement for a rejected plan');
 await f.start();await f.start();await assert.rejects(f.start(),/TASK_QUEUE_FULL/);
 await (await f.spawned('SYNTHETIC GOAL')).finish({output:[{type:'text',text:'R'}],stopReason:'completed'});
 await settled(()=>f.starts===4,'queued task takes the freed slot');assert.equal(f.progress(d.id).status,'running');
 assert.ok(a.id&&b.id&&c.id);
});

test('a failed step blocks only its dependents; retry reruns just the failed part; every completion is reported once',async t=>{
 const f=await fixture(t);
 const task=await f.start({title:'SYNTHETIC FAILURE',ack:'收到',steps:[{title:'A',goal:'GOAL-A'},{title:'B',goal:'GOAL-B'},{title:'C',goal:'GOAL-C',dependsOn:['s1']}]});
 await f.complete('GOAL-A','PARTIAL','max-tokens');await f.complete('GOAL-B','RESULT-B');
 await f.ended(task.id,'failed');
 const p=f.progress(task.id);assert.deepEqual(p.steps.map(s=>s.status),['failed','succeeded','blocked','blocked']);
 assert.match(p.steps[0].error,/SUBAGENT_STOPPED_MAX_TOKENS/);assert.equal(f.starts,2);
 await f.bridge.core.drainTaskCompletions();assert.equal(f.notices().length,1);assert.match(f.notices()[0].content[0].text,/task_retry/);
 assert.deepEqual((await f.result(task.id)).finishedSteps,[{id:'s2',title:'B'}]);
 const retried=await f.retry(task.id);assert.deepEqual(retried.retried,['s1']);
 await f.complete('GOAL-A','RESULT-A');await f.complete('GOAL-C','RESULT-C');
 assert.equal(f.starts,4,'B is not run again');
 await f.complete('汇总成给主人的最终交付','FINAL');await f.ended(task.id,'succeeded');
 assert.equal(f.progress(task.id).steps[1].attempt,1);assert.equal(f.progress(task.id).steps[0].attempt,2);
 for(let i=0;i<3;i++){f.bridge.ownerTasks.drain();await f.bridge.core.drainTaskCompletions();}
 assert.equal(f.notices().length,2);await assert.rejects(f.retry(task.id),/只有失败或已取消/);
});

test('cancel aborts an in-flight delegated tool and returns only after the child is torn down',async t=>{
 const searching=Promise.withResolvers();let toolAborted=false;
 const f=await fixture(t,{search:signal=>new Promise((resolve,reject)=>{searching.resolve();signal.addEventListener('abort',()=>{toolAborted=true;reject(Error('CANCELLED'));},{once:true});})});
 const task=await f.start({title:'SYNTHETIC CANCEL',ack:'收到',steps:[{title:'A',goal:'GOAL-A'},{title:'B',goal:'GOAL-B',dependsOn:['s1']}]});
 const child=await f.spawned('GOAL-A'),tool=f.call(child.h,'owner_search',{query:'synthetic'}),checked=assert.rejects(tool,/OWNER_TOOL_FAILED/);await searching.promise;
 const gate=Promise.withResolvers();f.setCancel(gate.promise);let returned=false;const cancel=f.cancel(task.id).then(v=>{returned=true;return v;});
 await settled(()=>toolAborted);assert.equal(f.progress(task.id).status,'cancelled');assert.equal(returned,false);
 gate.resolve();const after=await cancel;await checked;f.setCancel(null);
 assert.deepEqual(after.steps.map(s=>s.status),['cancelled','cancelled','cancelled']);assert.equal(f.disposals,1);assert.equal(f.starts,1);
 assert.equal((await f.cancel(task.id)).status,'cancelled');
 f.bridge.ownerTasks.drain();await f.bridge.core.drainTaskCompletions();assert.equal(f.notices().length,0,'the owner cancelled it; nothing to report');
 const retried=await f.retry(task.id);assert.deepEqual(retried.retried,['s1','s2','final']);
 await f.complete('GOAL-A');await f.complete('GOAL-B');await f.complete('汇总成给主人的最终交付');await f.ended(task.id,'succeeded');
});

test('a restart records in-flight steps as failed, reports once, and never re-runs them without an explicit retry',async t=>{
 const f=await fixture(t);
 const task=await f.start({title:'SYNTHETIC RESTART',ack:'收到',steps:[{title:'A',goal:'GOAL-A'},{title:'B',goal:'GOAL-B',dependsOn:['s1']}]});
 await f.spawned('GOAL-A');
 await f.reopen();
 const p=f.progress(task.id);assert.equal(p.status,'failed');assert.match(p.steps[0].error,/INTERRUPTED/);assert.equal(p.steps[1].status,'pending');
 await f.bridge.core.drainTaskCompletions();assert.equal(f.starts,1);assert.equal(f.notices().length,1);
 await f.reopen();f.bridge.ownerTasks.drain();await f.bridge.core.drainTaskCompletions();assert.equal(f.starts,1);assert.equal(f.notices().length,1);
 await f.retry(task.id);await f.complete('GOAL-A','RESULT-A');const b=await f.complete('GOAL-B','RESULT-B');assert.match(b.prompt,/RESULT-A/);
 await f.complete('汇总成给主人的最终交付','FINAL');await f.ended(task.id,'succeeded');assert.equal(f.progress(task.id).steps[0].attempt,2);
});

test('ambiguous notification flush is not replayed after host restart',async t=>{
 const f=await fixture(t),task=await f.start();f.failFlush(true);await f.complete('SYNTHETIC GOAL');await f.ended(task.id,'succeeded');
 await f.bridge.core.drainTaskCompletions();
 assert.equal(Object.values(f.bridge.core.state('owner').taskCompletions)[0].status,'unknown');
 f.failFlush(false);await f.reopen();f.bridge.ownerTasks.drain();await f.bridge.core.drainTaskCompletions();
 assert.equal(f.notices().length,1);
});

test('delegated Shell, file read/write, and search execute through existing owner bindings',async t=>{
 const f=await fixture(t);await f.start();const child=(await f.spawned('SYNTHETIC GOAL')).h;
 const shell=await f.call(child,'owner_powershell',{script:'[Console]::WriteLine("SYNTHETIC TASK SHELL")',cwd:f.root,timeoutMs:10000});
 assert.equal(shell.exitCode,0);assert.equal(shell.jobExitConfirmed,true);assert.match(shell.output,/SYNTHETIC TASK SHELL/);
 await f.call(child,'owner_file_write',{projectId:'synthetic',path:'synthetic.txt',text:'SYNTHETIC FILE'});
 const read=await f.call(child,'owner_file_read',{projectId:'synthetic',path:'synthetic.txt'});assert.match(read.text,/SYNTHETIC FILE/);
 const search=await f.call(child,'owner_search',{query:'SYNTHETIC QUERY'});assert.match(search.text,/SYNTHETIC SEARCH/);
 const page=await f.call(child,'owner_fetch',{url:'https://example.invalid/synthetic'});assert.match(page.text,/SYNTHETIC PAGE/);
 await assert.rejects(f.call(f.handle(),'owner_powershell',{script:'Get-Date',cwd:f.root}),/OWNER_ORIGIN_REQUIRED/);
 assert.equal(f.bridge.ownerTasks.shellOrigin({agent:child.agent,bindingId:binding,callId:'forged',commandHash:'forged'}),null);
 await f.complete('SYNTHETIC GOAL');
});

test('group, forged agents, unapproved tools, and revoked owners cannot use task authority',async t=>{
 const f=await fixture(t),groupHandle=f.bridge.core.handles.get('group');
 for(const name of OWNER_TASK_TOOLS){assert.equal(groupHandle.tools.has(name),false);await assert.rejects(f.call(groupHandle,name),/WECHAT_TOOL_SCOPE_DENIED/);}
 for(const name of OWNER_TASK_TOOLS)assert.ok(f.handle().tools.has(name));
 assert.equal(f.handle().tools.has('owner_long_task'),false);assert.equal(f.handle().tools.has('wechat_task'),false);assert.equal(f.bridge.taskManager,null);
 await assert.rejects(f.call(f.handle(),'task_start',{title:'x',goal:'synthetic'},{agent:groupHandle.agent}),/OWNER_ONLY/);
 for(const name of ['wechat_reply','task_start','owner_plugins','owner_attachment_read','powershell']){
  await assert.rejects(f.start({title:'x',goal:'synthetic',tools:[name]}),/TASK_TOOL_DENIED/);
  await assert.rejects(f.start({title:'x',steps:[{title:'a',goal:'synthetic',tools:[name]}]}),/TASK_TOOL_DENIED/);
 }
 await f.start({title:'x',steps:[{title:'a',goal:'GOAL-SCOPED',tools:['owner_search']},{title:'b',goal:'GOAL-BARE',tools:[]}]});
 const child=(await f.spawned('GOAL-SCOPED')).h;
 assert.deepEqual([...child.tools.keys()],['owner_search']);assert.deepEqual(child.restrictions,[{allow:[]}]);
 assert.equal((await f.spawned('GOAL-BARE')).h.tools.size,0);
 assert.equal(child.guards[0]({name:'wechat_reply'}),'TASK_TOOL_DENIED');
 assert.equal(child.guards[0]({name:'task_start'}),'TASK_TOOL_DENIED');
 f.bridge.core.pause();await assert.rejects(f.call(child,'owner_search',{query:'synthetic'}),/OWNER_TASK_REVOKED/);
 f.bridge.core.resume();f.bridge.core.state('owner').rotationFence=true;
 await assert.rejects(f.call(child,'owner_search',{query:'synthetic'}),/OWNER_TASK_REVOKED/);
 delete f.bridge.core.state('owner').rotationFence;
 await f.complete('GOAL-SCOPED');await f.complete('GOAL-BARE');
});

test('phone panel is read-only and reachable only with the token',async t=>{
 const f=await fixture(t,{panel:{enabled:true,host:'127.0.0.1',port:0,publicUrl:'http://panel.invalid:8790/'}});
 const {panel,panelUrl}=f.bridge.ownerTasks;if(!panel.server.listening)await once(panel.server,'listening');
 const token=fs.readFileSync(path.join(f.root,'owner-tasks','panel-token'),'utf8');
 assert.equal(panelUrl,'http://panel.invalid:8790/'+token+'/');assert.ok(token.length>=32);
 const base='http://127.0.0.1:'+panel.server.address().port+'/';
 const task=await f.start({title:'SYNTHETIC PANEL',goal:'GOAL-PANEL'});await f.complete('GOAL-PANEL','PANEL ARTIFACT');await f.ended(task.id,'succeeded');
 const page=await fetch(base+token+'/');assert.equal(page.status,200);assert.match(await page.text(),/任务面板/);
 const state=await (await fetch(base+token+'/api/state')).json();
 assert.equal(state.tasks[0].title,'SYNTHETIC PANEL');assert.equal(state.tasks[0].status,'succeeded');assert.equal('request' in state.tasks[0],false);
 assert.equal(await (await fetch(base+token+'/api/artifact/'+task.id+'/s1')).text(),'PANEL ARTIFACT');
 for(const url of [base,base+'api/state',base+'x'.repeat(token.length)+'/api/state',base+token+'/api/artifact/'+task.id+'/nope',base+token+'/api/artifact/999/s1'])assert.equal((await fetch(url)).status,404,url.replace(token,'<token>'));
 assert.equal((await fetch(base+token+'/api/state',{method:'POST'})).status,404);
 const guide=f.handle().sections.find(s=>s.name==='owner-tasks-guide').text();assert.ok(guide.includes(panelUrl));assert.match(guide,/收到/);
});

test('disabled flag stays explicit, and a broken task store disables tasks without stopping the bridge',async t=>{
 const disabled=await fixture(t,{enabled:false});assert.equal(disabled.bridge.ownerTasks,null);
 for(const name of OWNER_TASK_TOOLS)assert.equal(disabled.handle().tools.has(name),false);
 const broken=await fixture(t,{before:root=>fs.writeFileSync(path.join(root,'owner-tasks'),'not a directory')});
 assert.equal(broken.bridge.ownerTasks,null);assert.ok(broken.handle().tools.has('wechat_reply'));
 assert.match(fs.readFileSync(path.join(broken.root,'loop-errors.log'),'utf8'),/OWNER_TASKS_DISABLED/);
});
