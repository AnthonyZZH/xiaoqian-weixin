import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createBridge} from '../src/index.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const chat={id:'owner',title:'SYNTHETIC UPGRADE',mode:'private',owner:true};
const chatKey=hash(JSON.stringify({mode:'private',name:chat.title}));
const mid=key=>hash(JSON.stringify([chatKey,key]));
const complete=(key,text,extra={})=>({key,text,role:'user',text_complete:true,text_source:'synthetic_full',text_reason:'',...extra});
async function open(root,rows,records,rpcPath){
 const agents={async create(o){const agent={session:{id:o.sessionId||o.resumeSessionId},inbox:{nextTurn:[]},followup:m=>records.push(m)};await o.setup({tools:{restrict(){},guard(){},register(){}},systemPrompt:{section(){}},on(){}},agent);return{agent,async dispose(){}}}};agents.resume=agents.create;
 const b=await createBridge({agents,sessions:{async flush(){return true}}},{stateDir:root,mode:'mock',driverRpcPath:rpcPath,python:process.env.XQ_TEST_PYTHON||'python',chats:[chat],mock:{snapshots:{[chatKey]:rows}}},{defineTool:x=>x});b.core.resume();return b;
}
test('real Python bridge maps old consumed alias, accepts only new trailing row, ACKs across restart',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xq-upgrade-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const records=[];
 const old=hash('old-source'),rows=[complete('v2-old','old text',{legacy_keys:[old]}),complete('v2-new','fresh')];
 let b=await open(root,rows,records);b.core.state('owner').bootstrapped=true;b.core.state('owner').messages[hash(mid(old))]={status:'accepted'};b.core.store.save();
 try{const r=await b.core.poll('owner');assert.equal(r.accepted,1);assert.equal(records.length,1);assert.match(JSON.stringify(records),/fresh/);assert.equal(b.core.status('owner').identityHeldMessages,0);
 assert.equal((await b.driver.call('read',{targetId:'owner'})).messages.length,0);
 await b.core.close();b=await open(root,rows,records);assert.equal((await b.core.poll('owner')).accepted,0);assert.equal(records.length,1);
 }finally{await b.core.close();}
});
test('incomplete body is persisted not ACKed; same ID upgrades to full body after restart',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xq-deferred-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const records=[];
 let b=await open(root,[complete('partial','preview',{text_complete:false,text_reason:'collapsed'})],records);
 b.core.state('owner').bootstrapped=true;b.core.state('owner').identityVersion='uia-row-v2';b.core.store.save();
 try{assert.equal((await b.core.poll('owner')).accepted,0);assert.equal(records.length,0);assert.equal(b.core.status('owner').deferredMessages.count,1);
 const r=await b.driver.call('read',{targetId:'owner'});assert.equal(r.messages.length,0);assert.equal(r.deferred.length,1);
 await b.core.close();b=await open(root,[complete('partial','preview'+'x'.repeat(6000))],records);assert.equal((await b.core.poll('owner')).accepted,1);assert.equal(records.length,1);assert.match(JSON.stringify(records),new RegExp('x{6000}'));assert.equal((await b.driver.call('read',{targetId:'owner'})).deferred.length,0);
 }finally{await b.core.close();}
});
test('unmatched upgrade snapshot is retained without replay; later independent new row still proceeds',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'xq-identity-hold-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const records=[];
 let b=await open(root,[complete('ambiguous-old','do not replay')],records);const s=b.core.state('owner');s.bootstrapped=true;s.messages[hash('prior-id')]={status:'baseline'};b.core.store.save();
 try{assert.equal((await b.core.poll('owner')).accepted,0);assert.equal(b.core.status('owner').identityHeldMessages,1);assert.equal((await b.driver.call('read',{targetId:'owner'})).messages.length,1);
 await b.core.close();b=await open(root,[complete('ambiguous-old','do not replay'),complete('fresh-later','new request')],records);assert.equal((await b.core.poll('owner')).accepted,1);assert.equal(records.length,1);assert.match(JSON.stringify(records),/new request/);assert.doesNotMatch(JSON.stringify(records),/do not replay/);
 }finally{await b.core.close();}
});

test('explicit pinned legacy RPC preserves unknown input and handles independent new message once',{skip:!process.env.XQ_COMPAT_RPC_PATH},async t=>{const rpc=process.env.XQ_COMPAT_RPC_PATH;assert.ok(rpc,'set explicit trusted previous RPC source for cutover acceptance');const root=fs.mkdtempSync(path.join(os.tmpdir(),'xq-legacy-cutover-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const records=[];const rows=[complete('old-unknown','SYNTHETIC OLD UNKNOWN'),complete('fresh','SYNTHETIC FRESH')];const b=await open(root,rows,records,rpc);try{const s=b.core.state('owner');s.bootstrapped=true;s.messages[hash(mid('old-unknown'))]={status:'unknown'};b.core.store.save();const first=await b.core.poll('owner');assert.equal(first.accepted,1);assert.equal(records.length,1);assert.match(JSON.stringify(records),/SYNTHETIC FRESH/);assert.doesNotMatch(JSON.stringify(records),/SYNTHETIC OLD UNKNOWN/);assert.equal(s.messages[hash(mid('old-unknown'))].status,'unknown');await b.core.poll('owner');assert.equal(records.length,1);assert.equal(s.identityVersion,undefined);}finally{await b.core.close();}});
