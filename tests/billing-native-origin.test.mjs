import test from 'node:test';import assert from 'node:assert/strict';
import {createNativeOrigin} from '../src/billing/native-origin.mjs';
const agent={session:{}};
function f(){const grants=new Map([['host-user',{kind:'incoming'}],['host-wake',{kind:'proactive'}]]);const t=createNativeOrigin({agent,lookupReceipt:id=>grants.get(id)});const event=(type,data,seq=1)=>t.sessionEvent(agent.session,{type,data,seq});const start=()=>t.assistantStream({agent,frame:{type:'start',turn:1,step:1,attemptId:'synthetic:1'}});return {t,event,start};}
test('host receipts classify wake and user; a model source label cannot invent receipt',()=>{
 for(const [id,expected] of [['host-user','natural_user'],['host-wake','wake'],['forged',null]]){
 const {t,event,start}=f();event('turn/start',{turn:1},0);event('step/start',{step:1});event('user/message',{id,source:{kind:'xiaoqian-wechat'},get content(){throw Error('BODY_READ_FORBIDDEN');}});start();assert.equal(t.snapshot()?.trigger_type??null,expected);t.close();}
});
test('mixed receipts, foreign input, wrong Agent and mismatched native turn fail closed',()=>{
 const {t,event,start}=f();event('turn/start',{turn:1});event('step/start',{step:1});event('user/message',{id:'host-user'});event('user/message',{id:'host-wake'});start();assert.equal(t.snapshot().trigger_type,'mixed');
 event('user/message',{id:'foreign'});assert.equal(t.snapshot(),null);event('turn/end',{turn:1});assert.equal(t.snapshot(),null);
});
test('wrong Agent, native turn/step mismatch and missing event sequence never produce a link',()=>{
 const {t,event}=f();event('turn/start',{turn:1});event('step/start',{step:1});event('user/message',{id:'host-user'});
 t.assistantStream({agent:{},frame:{type:'start',turn:1,step:1,attemptId:'forged'}});assert.equal(t.snapshot(),null);
 t.assistantStream({agent,frame:{type:'start',turn:2,step:1,attemptId:'wrong-turn'}});assert.equal(t.snapshot(),null);
 t.assistantStream({agent,frame:{type:'start',turn:1,step:2,attemptId:'wrong-step'}});assert.equal(t.snapshot(),null);
 t.close();
});
test('native frame end/disposal clears state and different lifecycle avoids attempt collisions',()=>{
 const a=f(),b=f();for(const x of [a,b]){x.event('turn/start',{turn:1});x.event('step/start',{step:1});x.event('user/message',{id:'host-user'});x.start();}
 assert.notEqual(a.t.snapshot().native_attempt_hash,b.t.snapshot().native_attempt_hash);
 a.t.assistantStream({agent,frame:{type:'end'}});assert.equal(a.t.snapshot(),null);b.t.close();assert.equal(b.t.snapshot(),null);
});
test('installed native loop correlates host user/wake to real turns and one-to-many physical attempts offline',async()=>{
 const {spawnSync}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
 const p=spawnSync(process.execPath,[fileURLToPath(new URL('./helpers/billing-origin-native-child.mjs',import.meta.url))],{encoding:'utf8',timeout:15000,env:Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]))});
 assert.equal(p.status,0,p.stderr||p.stdout||String(p.error));const v=JSON.parse(p.stdout.trim().split(/\r?\n/).at(-1));assert.equal(v.native,true);assert.deepEqual(v.origins,['natural_user','natural_user','wake']);assert.equal(v.physicalAttempts,3);assert.equal(v.nativeAttempts,2);assert.equal(v.sends,0);
});
