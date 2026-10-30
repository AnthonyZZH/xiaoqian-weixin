import test from'node:test';import assert from'node:assert/strict';
import{createOwnerSessionStatus,sessionStatusDto,summarizeEvents}from'./index.mjs';import{createCoreSessionSource}from'./sources.mjs';
const now=1793332800000,actor={},exec={agent:actor};
const session=events=>({seq:events.length,eventAt:i=>events[i],append(){throw Error('READ_ONLY_MUST_NOT_APPEND')}});
function agent(status='running',events=[],queue=0){return{status,session:session(events),inbox:{nextTurn:Array(queue).fill({text:'SECRET_INPUT'}),nextStep:[]},cancel(){throw Error('MUST_NOT_CANCEL')}};}
const event=(type,data={},time=now-1000)=>({type,data,time});
function setup(rows,options={}){return createOwnerSessionStatus({clock:()=>now,isCurrentOwner:({agent,bindingId})=>agent===actor&&bindingId==='owner',getManagedSessions:()=>rows,...options}).bind({agent:actor,bindingId:'owner'});}
test('multiple managed states, approval/tool phase, operation-only unknown sends',async()=>{
 const rows=[{id:'a',chatId:'owner',sessionId:'wechat-a',kind:'chat',observedAt:now,agent:agent('running',[event('turn/start'),event('tool/call',{callId:'call1',name:'owner_command',get arguments(){throw Error('DO_NOT_READ_ARGS')}}),event('approval/asked',{id:'approval1',reason:'SECRET_REASON'})]),persisted:{deliveries:{u:{status:'unknown'},p:{status:'sending'}},pendingWake:{reason:'SECRET_WAKE'}}},
 {id:'b',observedAt:now,agent:agent('idle',[],2)}, {id:'c',observedAt:now,paused:true,agent:agent('running')}, {id:'d',observedAt:now-999999,agent:agent('running')}, {id:'e',observedAt:now,knownState:'failed',lastOutcome:'failed',lastError:{code:'TASK_FAILED'}}, {id:'f',observedAt:now,agent:agent('idle')}];
 const value=await setup(rows).execute({},exec);assert.deepEqual(value.sessions.map(s=>s.state),['running','queued','paused','unknown','failed','idle']);
 const a=value.sessions[0];assert.equal(a.phase,'approval');assert.deepEqual(a.currentTools,['owner_command']);assert.equal(a.pendingApproval,true);assert.equal(a.unknownSends,1);assert.equal(a.pendingSends,1);assert.equal(a.lastOutcome,null);assert.equal(a.blockers.find(v=>v.code==='SEND_UNKNOWN_RECONCILIATION').scope,'operation');assert.equal(value.sessions[1].queueLength,2);assert.equal(value.sessions[3].lastKnownState,'running');assert.equal(value.sessions[3].stale,true);assert.ok(!JSON.stringify(value).includes('SECRET'));
});
test('no body/parameters/error text exposure; unknown error codes redacted',()=>{
 const result=sessionStatusDto({id:'x',observedAt:now,phase:'SECRET_PHASE',knownState:'SECRET_STATE',lastOutcome:'SECRET_OUTCOME',agent:agent('idle',[event('tool/call',{callId:'c',name:'owner_file_read',get arguments(){throw Error('MUST_NOT_READ')}}),event('tool/result',{message:{callId:'c',isError:true,get content(){throw Error('MUST_NOT_READ')}},error:{code:'SECRET_RAW_ERROR',get message(){throw Error('MUST_NOT_READ')}}})]),token:'SECRET_TOKEN',command:'SECRET_SHELL'},{now});
 assert.equal(result.lastError.code,'UNCLASSIFIED_ERROR');assert.ok(!JSON.stringify(result).includes('SECRET'));assert.equal(result.currentTools.length,0);
});
test('foreign Agent/group impersonation, dynamic revocation, truthy nonboolean denied before source',async()=>{
 let reads=0,authorized=true;const api=setup([],{isCurrentOwner:()=>authorized,getManagedSessions:()=>{reads++;return[]}});
 await assert.rejects(api.execute({owner:true},{agent:{}}),/OWNER_ONLY/);assert.equal(reads,0);
 authorized={owner:false};await assert.rejects(api.execute({},exec),/OWNER_ONLY/);assert.equal(reads,0);
 authorized=true;await api.execute({},exec);api.revoke();await assert.rejects(api.execute({},exec),/OWNER_ONLY/);assert.equal(reads,1);
});
test('source failures and partial event window remain explicit, never fake idle/empty',async()=>{
 const api=setup([],{getManagedSessions:()=>{throw Error('SECRET_PATH_OR_KEY')}});await assert.rejects(api.execute({},exec),e=>e.message==='STATUS_SOURCE_UNAVAILABLE');
 const window=summarizeEvents(session(Array.from({length:2050},()=>event('step/start'))));assert.equal(window.eventWindowComplete,false);assert.equal(window.pendingApproval,null);
 const value=await setup([{id:'bad',observedAt:now,agent:{get status(){throw Error('SECRET')},session:{seq:1,eventAt(){throw Error('SECRET')}}}}]).execute({},exec);assert.equal(value.sessions[0].state,'unknown');assert.ok(value.sessions[0].blockers.some(v=>v.code==='SESSION_OBSERVATION_UNAVAILABLE'));assert.ok(!JSON.stringify(value).includes('SECRET'));
});
test('core source never allocates/resumes/cancels sessions or invokes side-effect status methods',async()=>{
 const data={paused:false,chats:{owner:{sessionId:'wechat-owned',deliveries:{x:{status:'unknown'}},messages:{}}}},before=JSON.stringify(data);
 const core={chats:new Map([['owner',{id:'owner',owner:true,title:'Secret title not emitted by default',mode:'private'}]]),store:{data,save(){throw Error('MUST_NOT_SAVE')}},handles:new Map(),state(){throw Error('MUST_NOT_CREATE_STATE')},status(){throw Error('MUST_NOT_CALL_STATUS')},capabilities:{taskManager:{jobs:{jobs:{t:{chatId:'owner',sessionId:'xiaoqian-job-t',status:'unknown',result:'SECRET_RESULT'}}},handles:new Map(),status(){throw Error('MUST_NOT_RECOVER')}}}};
 const source=createCoreSessionSource(core,{clock:()=>now});const result=await setup(source().rows).execute({},exec);assert.equal(result.total,2);assert.equal(result.sessions[1].lastOutcome,'unknown');assert.equal(JSON.stringify(data),before);assert.ok(!JSON.stringify(result).includes('SECRET_RESULT'));assert.equal(result.sessions[0].displayName,null);
});
test('pagination and unregistered filters cannot query other sessions',async()=>{
 const api=setup([{id:'one',chatId:'managed',observedAt:now},{id:'two',chatId:'managed',observedAt:now}]);assert.equal((await api.execute({limit:1},exec)).nextOffset,1);await assert.rejects(api.execute({chatId:'unrelated-codex'},exec),/SESSION_NOT_MANAGED/);await assert.rejects(api.execute({limit:101},exec),/PAGE_INVALID/);
});
