import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRotationLite,liteUsage,liteRates} from '../src/rotation-lite.mjs';
import {createRotationSession} from '../src/rotation-session.mjs';
import {createRotationLibrary} from '../src/rotation-library.mjs';
import {atomicWrite} from '../src/state.mjs';

const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const SUMMARY='主人的偏好和事实\n喜欢简洁。\n未完成事项\n完成离线测试。\n最近话题\n轮换。\n关系和语气\n自然、直接。';
const PRICE={peak:{hit:0.1,miss:1,output:0},offpeak:{hit:0.05,miss:0.5,output:0}};
function fixture(t,options={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xq-t010-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const clock={now:Date.parse('2026-11-09T01:00:00Z')},audit=[],calls=[],notes=new Map(),writes=[],events=[];
 let messages=[{role:'user',content:[{type:'text',text:'SYNTHETIC hello'}]},
  {role:'assistant',content:[{type:'text',text:'SYNTHETIC reply'},{type:'tool-call',text:'TOOL_SECRET'}]},
  {role:'tool',content:[{type:'text',text:'TOOL_SECRET'}]}];
 const chat={id:'owner',title:'SYNTHETIC',owner:true,mode:'private'};
 const state={sessionId:'old-session',binding:'b'.repeat(64),created:true,bootstrapped:true,messages:{},deliveries:{}};
 const store={file:path.join(root,'bridge.json'),data:{chats:{owner:state},paused:false},save(){atomicWrite(this.file,this.data);},audit(code,id,extra){audit.push({code,id,...extra});}};
 store.save();
 const oldFile=path.join(root,'old-session.synthetic.json');fs.writeFileSync(oldFile,'SYNTHETIC OLD SESSION');const oldHash=hash(fs.readFileSync(oldFile));
 const makeHandle=(id,handoff)=>{
  const ownEvents=id==='old-session'?events:[];
  const session={id,get seq(){return ownEvents.length;},eventAt:i=>ownEvents[i],deriveMessages:()=>id==='old-session'?messages:[]};
  const assembly=()=>({tools:[{name:'safe_tool'}],sections:[{name:'xiaoqian-persona',text:'SYNTHETIC PERSONA'},...(handoff?[{name:'xiaoqian-rotation-handoff',text:handoff}]:[])]});
  const agent={id,session,status:'idle',inbox:{nextTurn:[],nextStep:[]},ctx:{systemPrompt:{assemble:async()=>assembly()}}};
  return {agent,disposed:false,async dispose(){this.disposed=true;}};
 };
 const old=makeHandle('old-session');let chain=Promise.resolve();
 const core={store,closed:false,model:{provider:'synthetic',model:'synthetic'},capabilities:{ownerNativeTools:['safe_tool']},features:{persona:()=> 'SYNTHETIC PERSONA'},
  handles:new Map([['owner',old]]),state:()=>store.data.chats.owner,
  serial(fn){const job=chain.then(fn);chain=job.catch(()=>{});return job;},
  async openHandle(_id,{sessionId,handoff}){if(options.createFails)throw Error('CANDIDATE_FAILED');return makeHandle(sessionId,handoff);}};
 const library={async write(kind,key,payload){writes.push({kind,key,payload});if(options.writeFails)throw Error('ARCHIVE_WRITE_FAILED');const id='note-'+writes.length;notes.set(id,payload);return id;},
  async read(id){return options.badHash?notes.get(id)+'corrupted':notes.get(id);}};
 const timers={callbacks:new Map(),next:0,setTimeout(fn){const id=++this.next;this.callbacks.set(id,fn);if(options.timeout)queueMicrotask(fn);return id;},clearTimeout(id){this.callbacks.delete(id);}};
 const config={stateDir:root,chats:[chat],model:core.model,rotationLite:{enabled:true,baseline:100,maxSummaryInputTokens:60000,prices:PRICE,...options.cfg}};
 const hostCtx={sessions:{flush:async()=>true}};
 const args={getCore:()=>core,hostCtx,config,library,clock:()=>clock.now,timers,
  model:async(input,signal)=>{calls.push({input,signal,coreModel:core.model});if(options.timeout)return new Promise(()=>{});if(options.summary)return options.summary;return SUMMARY;}};
 if(options.sessionFactory)args.sessionFactory=options.sessionFactory;
 let service=createRotationLite(args),listener;
 const observe=()=>{old.agent.ctx.on=(_name,fn)=>{listener=fn;return ()=>{listener=null;};};old.agent.ctx.effect=()=>{};service.register({agent:old.agent,chat});};
 if(options.observe)observe();
 t.after(()=>service.close());
 const usage=(input,hit=0,write=0)=>{const e={seq:events.length,type:'assistant/message',data:{usage:{inputTokens:input,cacheReadTokens:hit,cacheWriteTokens:write,outputTokens:10}}};events.push(e);listener?.(old.agent.session,e);};
 const readState=()=>JSON.parse(fs.readFileSync(path.join(root,'rotation-lite.json'),'utf8'));
 return {root,clock,audit,calls,notes,writes,events,old,oldFile,oldHash,core,config,timers,usage,readState,
  get service(){return service;},observe,async restart(){await service.close();service=createRotationLite(args);if(options.observe)observe();},
  async tick(){await service.tick();},manual(){fs.writeFileSync(path.join(root,'rotation-request.json'),'{}');},
  setMessages(value){messages=value;}};
}
async function calibrated(t,options={}){const f=fixture(t,options);f.usage(100);await f.tick();assert.equal(f.readState().baseline,100);return f;}
function oldRetained(f){assert.equal(f.core.state().sessionId,'old-session');assert.equal(f.old.disposed,false);assert.equal(hash(fs.readFileSync(f.oldFile)),f.oldHash);}

test('usage normalizes native uncached/cache buckets and canonical total',()=>{
 assert.deepEqual(liteUsage({inputTokens:30,cacheReadTokens:60,cacheWriteTokens:10,outputTokens:5}),{hit:60,miss:40,total:100,output:5});
 assert.deepEqual(liteUsage({input:100,cache_hit:60,cache_miss:40,output:5}),{hit:60,miss:40,total:100,output:5});
 assert.equal(liteUsage({input:101,cache_hit:60,cache_miss:40,output:5}),null);
 assert.equal(liteUsage({inputTokens:-1,outputTokens:0}),null);
});

test('default disabled does not read state, create directories or invoke ports',async()=>{
 const service=createRotationLite({config:{},getCore:()=>{throw Error('UNEXPECTED_CORE_ACCESS');}});
 await service.tick();await service.close();
});

test('default baseline is 30000 until the first measured fresh request',async t=>{
 const f=fixture(t,{cfg:{baseline:undefined}});await f.tick();assert.equal(f.readState().baseline,30000);
 f.usage(32000,1000);await f.tick();assert.equal(f.readState().baseline,33000);assert.equal(f.readState().keep,0);
});

test('manual rotation without a price card still runs all safety checks',async t=>{
 const f=fixture(t,{cfg:{prices:undefined}});f.manual();await f.tick();
 assert.equal(f.calls.length,1);assert.notEqual(f.core.state().sessionId,'old-session');assert.equal(f.readState().keep,0);
});

test('native usage observer prices each completed call before the next tick changes bands',async t=>{
 const f=fixture(t,{observe:true});f.old.agent.status='running';f.usage(100);f.usage(1000);
 assert.ok(Math.abs(f.readState().keep-0.0009)<1e-12);
 f.clock.now=Date.parse('2026-11-09T04:00:00Z');f.usage(1000);assert.ok(Math.abs(f.readState().keep-0.00135)<1e-12);
 await f.tick();assert.ok(Math.abs(f.readState().keep-0.00135)<1e-12);await f.restart();await f.tick();assert.ok(Math.abs(f.readState().keep-0.00135)<1e-12);
});

test('activation learns historical cold baseline without charging past usage at current rates',async t=>{
 const f=fixture(t);f.usage(100);f.usage(1000000);f.observe();
 assert.equal(f.readState().baseline,100);assert.equal(f.readState().keep,0);assert.equal(f.readState().cursor,2);
 f.old.agent.status='running';f.usage(1000);await f.tick();assert.ok(Math.abs(f.readState().keep-0.0009)<1e-12);
});

test('accumulated redundant input triggers, deduplicates usage and persists across restart',async t=>{
 const f=await calibrated(t);f.usage(1000);await f.tick();const first=f.readState().keep;
 assert.ok(Math.abs(first-0.0009)<1e-12);assert.equal(f.calls.length,0);await f.tick();assert.equal(f.readState().keep,first);
 await f.restart();await f.tick();assert.equal(f.readState().keep,first);
 f.usage(1000);await f.tick();assert.equal(f.calls.length,1);assert.equal(f.readState().keep,0);assert.notEqual(f.core.state().sessionId,'old-session');
});

test('cached and uncached redundant costs use separate rates and proportional baseline',async t=>{
 const f=await calibrated(t);f.old.agent.status='running';f.usage(40,160);await f.tick();
 assert.ok(Math.abs(f.readState().keep-0.000028)<1e-12);oldRetained(f);
});

test('terminal unknown ledger entries do not block a manual rotation',async t=>{
 const f=await calibrated(t);f.manual();const s=f.core.state();
 s.messages.m={status:'unknown'};s.deliveries.d={status:'unknown'};
 await f.tick();
 assert.equal(f.calls.length,1);assert.notEqual(f.core.state().sessionId,'old-session');
});

for(const reason of ['running','nextTurn','nextStep','accepting','sending','pendingWake','fence','uncertain','completion','paused']){
 test('idle gate blocks '+reason+' even for manual request',async t=>{
  const f=await calibrated(t);f.manual();const s=f.core.state();
  if(reason==='running')f.old.agent.status='running';
  if(['nextTurn','nextStep'].includes(reason))f.old.agent.inbox[reason].push({});
  if(reason==='accepting'||reason==='unknownInbound')s.messages.m={status:reason==='accepting'?'accepting':'unknown'};
  if(reason==='sending'||reason==='unknownSend')s.deliveries.d={status:reason==='sending'?'sending':'unknown'};
  if(reason==='pendingWake')s.pendingWake={wakeId:'synthetic'};
  if(reason==='fence')s.rotationFence={operation:'other'};
  if(reason==='uncertain')s.rotationUncertain={operation:'other'};
  if(reason==='completion')s.taskCompletions={c:{status:'pending'}};
  if(reason==='paused')f.core.store.data.paused=true;
  await f.tick();assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);oldRetained(f);assert.ok(fs.existsSync(path.join(f.root,'rotation-request.json')));
 });
}

test('manual request bypasses economic gate and is consumed exactly once',async t=>{
 const f=await calibrated(t);assert.equal(f.readState().keep,0);f.manual();await f.tick();
 assert.equal(f.calls.length,1);assert.equal(fs.existsSync(path.join(f.root,'rotation-request.json')),false);await f.tick();assert.equal(f.calls.length,1);
 const s=f.core.state(),handoff=JSON.parse(s.rotationHandoff);
 assert.equal(handoff.summary.text,SUMMARY);assert.ok(handoff.summary_id);assert.ok(handoff.archive_manifest_id);
 assert.equal(f.readState().keep,0);assert.equal(f.readState().awaitBaseline,true);
 const current=f.core.handles.get('owner');let newEvents=[{seq:0,type:'assistant/message',data:{usage:{inputTokens:300,cacheReadTokens:0,outputTokens:5}}}];
 current.agent.session={seq:1,eventAt:i=>newEvents[i],deriveMessages:()=>[]};await f.tick();
 assert.equal(f.readState().baseline,300);assert.equal(f.readState().awaitBaseline,false);assert.equal(f.readState().keep,0);
 assert.ok(f.old.disposed);assert.equal(hash(fs.readFileSync(f.oldFile)),f.oldHash);
 assert.deepEqual(s.messages,{});assert.deepEqual(s.deliveries,{});
});

test('archive uses one <=200KB UTF-8 artifact per fragment, exceeds 8MiB total, excludes tools',async t=>{
 const f=await calibrated(t);const large='中文🙂abc'.repeat(750000);
 f.setMessages([{role:'user',content:[{type:'text',text:large}]},{role:'assistant',content:[{type:'text',text:'SYNTHETIC reply'},{type:'tool-call',text:'TOOL_SECRET'}]},{role:'tool',content:[{type:'text',text:'TOOL_SECRET'}]}]);
 f.manual();await f.tick();const parts=f.writes.filter(v=>v.kind==='archive');assert.ok(parts.length>40);
 for(const part of parts){assert.ok(Buffer.byteLength(part.payload)<=200000);assert.ok(!part.payload.includes('\uFFFD'));}
 const manifest=JSON.parse(f.writes.find(v=>v.kind==='manifest').payload),joined=parts.map(v=>v.payload).join('');
 assert.ok(manifest.bytes>8*1024*1024);assert.equal(Buffer.byteLength(joined),manifest.bytes);assert.equal(hash(joined),manifest.sha256);
 assert.ok(!joined.includes('TOOL_SECRET'));assert.deepEqual(JSON.parse(joined.split('\n')[0]),{role:'user',text:large});
 assert.equal(manifest.parts.length,parts.length);
 for(let i=0;i<parts.length;i++){assert.equal(manifest.parts[i].sha256,hash(parts[i].payload));assert.equal(f.notes.get(manifest.parts[i].id),parts[i].payload);}
 assert.ok(Buffer.byteLength(f.calls[0].input)+Buffer.byteLength('只总结')<60000);
});

test('reused library ports round-trip separate artifacts above the aggregate 8MiB limit',async t=>{
 const f=fixture(t),notes=new Map();
 const adapter={async call(_chat,method,args){
  if(method==='write'){const id='notes/n'+notes.size;notes.set(id,args.content);return {data:{permalink:id}};}
  if(method==='read')return {data:{content:notes.get(args.identifier)}};
  if(method==='search')return {data:{results:[{}]}};
  throw Error('UNEXPECTED_METHOD');
 }};
 const lib=createRotationLibrary({adapter,chatId:'owner',root:path.join(f.root,'library'),namespace:'synthetic'});
 const payload='中文🙂'.repeat(18000);let total=0;
 for(let i=0;i<48;i++){const id=await lib.write('archive','synthetic/'+i,payload);assert.equal(await lib.read(id),payload);total+=Buffer.byteLength(payload);}
 assert.ok(total>8*1024*1024);assert.ok([...notes.values()].every(v=>Buffer.byteLength(v)<200000));
});

for(const fault of ['writeFails','badHash','timeout','createFails']){
 test(fault+' retains old route, keep, audit and six-hour cooldown',async t=>{
  const f=await calibrated(t,{[fault]:true});f.usage(1000);await f.tick();const keep=f.readState().keep;
  f.manual();await f.tick();oldRetained(f);assert.equal(f.readState().keep,keep);assert.equal(f.readState().retryAt,f.clock.now+6*3600000);
  assert.equal(fs.existsSync(path.join(f.root,'rotation-request.json')),false);assert.ok(f.audit.some(v=>v.code==='ROTATION_LITE_FAILED'));
  if(fault==='timeout')assert.equal(f.calls[0].signal.aborted,true);
  // Cooldown blocks automatic retries (even across restart); an explicit manual request bypasses it.
  const count=f.writes.length;f.clock.now+=6*3600000-1;await f.tick();assert.equal(f.writes.length,count);oldRetained(f);
  await f.restart();await f.tick();assert.equal(f.writes.length,count);assert.equal(f.readState().keep,keep);
  f.manual();await f.tick();assert.ok(f.writes.length>count);
 });
}

test('summary rejects oversized or incomplete result without switching',async t=>{
 const f=await calibrated(t,{summary:SUMMARY+'x'.repeat(4001)});f.manual();await f.tick();oldRetained(f);
 assert.ok(f.audit.some(v=>v.reason==='SUMMARY_CONTRACT_INVALID'));
});

test('prior summary and most recent messages fit configured summary input budget',async t=>{
 const f=await calibrated(t,{cfg:{maxSummaryInputTokens:3000}});
 f.core.state().rotationHandoff=JSON.stringify({summary:{text:'旧摘要'.repeat(1000)}});
 f.setMessages(Array.from({length:200},(_,i)=>({role:i%2?'assistant':'user',content:[{type:'text',text:'消息'+i+'中文'.repeat(100)}]})));
 f.manual();await f.tick();assert.equal(f.calls.length,1);const input=JSON.parse(f.calls[0].input);
 assert.ok(input.previous.startsWith('旧摘要'));assert.ok(input.messages.at(-1).text.includes('199'));assert.ok(Buffer.byteLength(f.calls[0].input)<=3000-1024);assert.ok(!f.calls[0].input.includes('\uFFFD'));
});

test('price card uses current model and weekday/holiday peak boundaries, config fallback',async t=>{
 const calendar={verified_years:[2026],holiday_ranges:[['2026-10-01','2026-10-07']]};
 const card={models:{synthetic:{rates:PRICE}}};
 const rate=iso=>liteRates(card,'synthetic',Date.parse(iso),calendar);
 assert.equal(rate('2026-11-09T00:59:59Z').band,'offpeak');assert.equal(rate('2026-11-09T01:00:00Z').band,'peak');
 assert.equal(rate('2026-11-09T04:00:00Z').band,'offpeak');assert.equal(rate('2026-11-09T06:00:00Z').band,'peak');
 assert.equal(rate('2026-11-09T10:00:00Z').band,'offpeak');assert.equal(rate('2026-11-08T01:00:00Z').band,'offpeak');
 assert.equal(rate('2026-10-01T01:00:00Z').band,'offpeak');assert.throws(()=>liteRates(card,'missing',Date.parse('2026-11-09T01:00:00Z'),calendar),/PRICE_MODEL_MISSING/);
 const f=await calibrated(t);f.old.agent.status='running';f.usage(1000);await f.tick();const peak=f.readState().keep;
 f.clock.now=Date.parse('2026-11-09T04:00:00Z');f.usage(1000);await f.tick();assert.ok(Math.abs(f.readState().keep-peak*1.5)<1e-12);
 const cardFile=path.join(f.root,'prices.json');fs.writeFileSync(cardFile,JSON.stringify(card));f.config.rotationLite.priceCard=cardFile;
 await f.restart();f.usage(1000);await f.tick();assert.ok(Math.abs(f.readState().keep-peak*2)<1e-12);
});

test('concurrent ticks perform one summary and one atomic switch',async t=>{
 const f=await calibrated(t);f.manual();await Promise.all([f.service.tick(),f.service.tick(),f.service.tick()]);
 assert.equal(f.calls.length,1);assert.equal(Object.keys(f.core.state().rotationCommits).length,1);
});

test('commit exception after durable switch reconciles receipt without replay',async t=>{
 const f=await calibrated(t,{sessionFactory:args=>{const binding=createRotationSession(args),commit=binding.ports.commit_rotation;binding.ports.commit_rotation=async(...v)=>{await commit(...v);throw Object.assign(Error('POSTCOMMIT_IO'),{uncertain:true});};return binding;}});
 f.manual();await f.tick();assert.notEqual(f.core.state().sessionId,'old-session');assert.equal(f.readState().keep,0);assert.equal(f.calls.length,1);
 assert.ok(f.audit.some(v=>v.code==='ROTATION_LITE_COMMITTED'));assert.ok(!f.core.state().rotationUncertain);
});

test('snapshot changing while assembling prompt is archived at the new revision',async t=>{
 const f=await calibrated(t),assemble=f.old.agent.ctx.systemPrompt.assemble;let injected=false;
 f.old.agent.ctx.systemPrompt.assemble=async()=>{if(!injected){injected=true;f.events.push({seq:f.events.length,type:'user/message',data:{}});f.setMessages([{role:'user',content:[{type:'text',text:'LATEST SYNTHETIC'}]}]);}return assemble();};
 f.manual();await f.tick();const archive=f.writes.filter(v=>v.kind==='archive').map(v=>v.payload).join('');assert.ok(archive.includes('LATEST SYNTHETIC'));
});

test('production summary adapter uses core model, thinking off, no tools and one call',async t=>{
 const f=await calibrated(t);await f.service.close();let options,followups=0,disposed=0;
 const tools={allow:null,guard:null},summaryAgent={session:{deriveMessages:()=>[{role:'assistant',content:[{type:'text',text:SUMMARY}]}]},
  followup(){followups++;},async whenIdle(){},cancel(){}};
 const hostCtx={sessions:{flush:async()=>true},agents:{async create(value){options=value;await value.setup({tools:{restrict:v=>tools.allow=v.allow,guard:v=>tools.guard=v},systemPrompt:{section(){}}});return {agent:summaryAgent,async dispose(){disposed++;}};}}};
 const service=createRotationLite({getCore:()=>f.core,hostCtx,config:f.config,library:{write:async(kind,key,payload)=>{f.notes.set(key,payload);return key;},read:async id=>f.notes.get(id)},clock:()=>f.clock.now});
 t.after(()=>service.close());f.manual();await service.tick();assert.equal(options.agentOptions.provider,f.core.model.provider);assert.equal(options.agentOptions.model,f.core.model.model);
 assert.equal(options.agentOptions.reasoningEffort,'off');assert.deepEqual(tools.allow,[]);assert.equal(tools.guard(),'SUMMARY_NO_TOOLS');assert.equal(followups,1);assert.equal(disposed,1);
});
