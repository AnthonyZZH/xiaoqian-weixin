import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {DurableDriverClient} from '../driver/durable-client.mjs';
import {createDownloadBroker} from '../vendor/attachment-ingress/download-broker-pdf.mjs';
import {createCurrentHostIngress} from '../vendor/attachment-ingress/current-driver-port.mjs';
const scratch=path.join(import.meta.dirname,'../.test-scratch/attachment-node');fs.mkdirSync(scratch,{recursive:true});
const targets=[{id:'owner',title:'SYNTHETIC_FILE_OWNER',mode:'private',owner:true},{id:'group',title:'SYNTHETIC_GROUP',mode:'group',owner:false},{id:'other',title:'SYNTHETIC_OTHER',mode:'private',owner:false}];
test('configured owner routing retains guards and read revision',async()=>{
 const d=new DurableDriverClient({stateDir:fs.mkdtempSync(path.join(scratch,'route-')),targets});let calls=0;
 d._ensure=async()=>{};d._request=async op=>{calls++;return {status:'ok',data:{operation:op}};};
 try{
  for(const op of ['attachment_inspect','attachment_save_as','attachment_completion'])assert.equal((await d.call(op,{targetId:'owner'})).status,'ok');
  const before=calls;for(const targetId of ['group','other'])assert.equal((await d.call('attachment_inspect',{targetId,owner:true})).code,'OWNER_ATTACHMENT_REQUIRED');assert.equal(calls,before);
  assert.equal((await d.call('attachment_inspect',{targetId:'owner',mode:'private'})).code,'DRIVER_TARGET_DENIED');
  d.paused=true;assert.equal((await d.call('attachment_inspect',{targetId:'owner'})).code,'DRIVER_PAUSED');d.paused=false;
  assert.equal(d._call.readOutcomeRevision,'read-outcomes/v1');assert.equal(d.attachmentPortsRevision,'attachment-ports/v1');
 }finally{d.close();}
});
test('actual RPC rejects unknown canonical IDs and group bypass at its boundary',async()=>{
 assert.ok(process.env.XQ_TEST_PYTHON,'XQ_TEST_PYTHON is required');
 const root=fs.mkdtempSync(path.join(scratch,'rpc-'));
 const d=new DurableDriverClient({stateDir:path.join(root,'driver'),mediaRoot:path.join(root,'media'),schedulePath:path.join(root,'schedule.sqlite3'),timeZone:'UTC',mode:'mock',targets,python:process.env.XQ_TEST_PYTHON,rpcPath:path.join(import.meta.dirname,'../compat/driver/bridge_rpc.py'),timeoutMs:10000});
 const args={targetId:'owner',card:{sourceMessageId:'f'.repeat(64),displayName:'sample.txt'},scope:{ownerBindingId:'synthetic-binding',ownerChatId:'owner',maxBytes:1024,deadline:Date.now()+10000}};
 try{
  const read=await d.call('read',{targetId:'owner'});assert.equal(read.status,'ok',JSON.stringify(read));
  for(const op of ['attachment_inspect','attachment_save_as','attachment_completion'])assert.equal((await d.call(op,args)).code,'ATTACHMENT_MESSAGE_UNKNOWN');
  assert.equal((await d.call('attachment_inspect',{...args,targetId:'group'})).code,'OWNER_ATTACHMENT_REQUIRED');
  assert.equal((await d._request('attachment_inspect',{...args,targetId:'group'})).code,'owner_attachment_required');
  assert.equal((await d._request('attachment_inspect',{...args,targetId:'other'})).code,'owner_attachment_required');
 }finally{d.close();}
});
test('ingress cannot enable native downloads with unaccepted profile',()=>{
 assert.throws(()=>createCurrentHostIngress({driver:{},acceptedProfile:{verified:true}}),/NATIVE_ACCEPTANCE_REQUIRED/);
});
test('uncertain synthetic save reservation never repeats its action',async()=>{
 const root=fs.mkdtempSync(path.join(scratch,'broker-'));let saves=0;
 const card={sourceMessageId:'a'.repeat(64),displayName:'sample.txt'},scope={ownerBindingId:'synthetic-binding',ownerChatId:'owner',maxBytes:1024};
 const uiPort={inspect:async()=>({verified:true,sourceMessageId:card.sourceMessageId,chatId:'owner',filename:'sample.txt',identityToken:'synthetic'}),saveAs:async()=>{saves++;throw Error('synthetic unknown');},completion:async()=>({completed:false})};
 const broker=createDownloadBroker({root,uiPort,profile:{verified:true,evidenceId:'synthetic'},isOwnerActive:async()=>true,timeoutMs:100,pollMs:20});
 await assert.rejects(broker.acquire(card,scope),/DOWNLOAD_ACTION_UNKNOWN/);await assert.rejects(broker.acquire(card,scope),/DOWNLOAD_COMPLETION_UNKNOWN|DOWNLOAD_DEADLINE/);assert.equal(saves,1);
});
