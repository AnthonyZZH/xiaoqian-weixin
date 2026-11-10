import test from 'node:test';
import assert from 'node:assert/strict';
import {validateChats} from '../src/policy.mjs';

const base=[{id:'owner',title:'主人',mode:'private',owner:true}];
test('wechatName is optional and keeps title as identity',()=>{
  const m=validateChats([...base,{id:'g',title:'老群名',wechatName:'新群名',mode:'group'}]);
  assert.equal(m.get('g').title,'老群名');assert.equal(m.get('g').wechatName,'新群名');
  assert.equal(validateChats([...base,{id:'g',title:'老群名',mode:'group'}]).get('g').wechatName,undefined);
});
test('wechatName must be a non-empty string',()=>{
  for(const wechatName of ['',' ',3,'x'.repeat(201)])
    assert.throws(()=>validateChats([...base,{id:'g',title:'老群名',wechatName,mode:'group'}]),/CHAT_WECHAT_NAME_INVALID/);
});
test('shown names cannot collide with another chat',()=>{
  assert.throws(()=>validateChats([...base,{id:'a',title:'甲',mode:'group'},{id:'b',title:'乙',wechatName:'甲',mode:'group'}]),/CHAT_AMBIGUOUS/);
  assert.throws(()=>validateChats([...base,{id:'a',title:'甲',wechatName:'丙',mode:'group'},{id:'b',title:'丙',mode:'group'}]),/CHAT_AMBIGUOUS/);
});

import {createReachWatch,isFailedPoll} from '../src/chat-reach.mjs';
const chats=[{id:'owner',title:'主人',mode:'private',owner:true},{id:'g',title:'老群名',mode:'group'}];
function rig(){let t=0;const audits=[],wakes=[],reports=[];
  const w=createReachWatch({chats,audit:(c,id,x)=>audits.push([c,id,x]),wake:async(id,ctx)=>wakes.push([id,ctx]),report:c=>reports.push(c),ms:180000,minFailures:20,now:()=>t});
  return {w,audits,wakes,reports,tick:ms=>{t+=ms;}};}
const flush=()=>new Promise(r=>setImmediate(r));
test('ingest receipts and rotation/paused never count as failures',()=>{
  for(const r of [{accepted:0,duplicate:3,rejected:0,ackable:[]},{status:'ok',baseline:2,ackable:[]},{status:'rotation_queued'},{status:'paused'},undefined])assert.equal(isFailedPoll(r),false);
  for(const r of [{status:'error',code:'backend_error'},{status:'rejected',code:'DRIVER_TARGET_DENIED'},{status:'unknown'}])assert.equal(isFailedPoll(r),true);
});
test('a healthy chat polled for an hour never alerts',async()=>{
  const x=rig();for(let i=0;i<1800;i++){x.w.watch(chats[0],{accepted:0,duplicate:1,ackable:[]});x.w.watch(chats[1],{accepted:1,ackable:['a']});x.tick(2000);}
  await flush();assert.deepEqual([x.wakes.length,x.reports.length],[0,0]);
});
test('occasional failures between successes never alert',async()=>{
  const x=rig();for(let i=0;i<600;i++){x.w.watch(chats[1],i%5?{ackable:[]}:{status:'error',code:'backend_error'});x.tick(2000);}
  await flush();assert.equal(x.wakes.length,0);
});
test('failures need both duration and count',async()=>{
  const x=rig();x.w.watch(chats[1],{status:'error',code:'e'});x.tick(600000);x.w.watch(chats[1],{status:'error',code:'e'});
  await flush();assert.equal(x.wakes.length,0);
});
test('a group unreadable for 3 minutes wakes the owner once, then recovers',async()=>{
  const x=rig();for(let i=0;i<200;i++){x.w.watch(chats[1],{status:'error',code:'backend_error'});x.tick(2000);}
  await flush();assert.equal(x.wakes.length,1);assert.equal(x.wakes[0][0],'owner');assert.match(x.wakes[0][1].note,/老群名/);
  assert.equal(x.audits.filter(a=>a[0]==='CHAT_UNREACHABLE').length,1);assert.equal(x.w.down().length,1);
  x.w.watch(chats[1],{ackable:[]});assert.equal(x.w.down().length,0);assert.equal(x.audits.at(-1)[0],'CHAT_REACHABLE');
});
test('owner chat failing is logged but never wakes itself',async()=>{
  const x=rig();for(let i=0;i<200;i++){x.w.watch(chats[0],{status:'error',code:'e'});x.tick(2000);}
  await flush();assert.equal(x.wakes.length,0);assert.equal(x.reports.length,1);
});

import {renameRetry} from '../src/state.mjs';
import fs from 'node:fs';
test('renameRetry retries transient EPERM then succeeds, and rethrows other errors',()=>{
  const orig=fs.renameSync;let calls=0;
  try{
    fs.renameSync=()=>{calls++;if(calls<3){const e=new Error('busy');e.code='EPERM';throw e;}};
    renameRetry('a','b',{sleep:()=>{}});assert.equal(calls,3);
    calls=0;fs.renameSync=()=>{calls++;const e=new Error('nope');e.code='ENOENT';throw e;};
    assert.throws(()=>renameRetry('a','b',{sleep:()=>{}}),/nope/);assert.equal(calls,1);
    calls=0;fs.renameSync=()=>{calls++;const e=new Error('stuck');e.code='EPERM';throw e;};
    assert.throws(()=>renameRetry('a','b',{tries:4,sleep:()=>{}}),/stuck/);assert.equal(calls,4);
  }finally{fs.renameSync=orig;}
});
