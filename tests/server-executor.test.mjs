import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createServerExecutor} from '../vendor/server-executor/index.mjs';
const python=process.env.XQ_TEST_PYTHON||'python';
const base=fs.mkdtempSync(path.join(os.tmpdir(),'xq-server-executor-'));
const root=path.join(base,'work-data');fs.mkdirSync(root);
const outside=path.join(base,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'outside.txt'),'SYNTHETIC OUTSIDE');
let owner=true,id=0;const agent={},exec=()=>({agent,callId:`test-${++id}`});
const kit=createServerExecutor({python,projects:{work:root},isCurrentOwner:({agent:a,bindingId})=>owner&&a===agent&&bindingId==='owner'});
const bound=kit.bind({agent,bindingId:'owner'});
const call=(name,args,e=exec())=>bound.execute(name,{projectId:'work',...args},e);
const rejects=(p,code)=>assert.rejects(p,e=>e.code===code);
test('real Windows work-data roundtrip, atomic backup, structured commands',async()=>{
  assert.equal((await call('owner_file_write',{path:'hello.txt',text:'first'})).writtenBytes,5);
  const second=await call('owner_file_write',{path:'hello.txt',text:'second'});
  assert.equal(fs.readFileSync(path.join(root,second.backup),'utf8'),'first');
  assert.equal((await call('owner_file_read',{path:'hello.txt'})).text,'second');
  assert.equal((await call('owner_command',{command:JSON.stringify({operation:'stat',path:'hello.txt'})})).bytes,6);
  assert.equal((await call('owner_command',{command:JSON.stringify({operation:'sha256',path:'hello.txt'})})).sha256.length,64);
  assert.ok((await call('owner_command',{command:'{"operation":"list"}'})).entries.some(e=>e.name==='hello.txt'));
});
test('no shell and no model supplied identity/root override',async()=>{
  await rejects(call('owner_command',{command:'powershell Get-Content C:\\secret'}),'STRUCTURED_COMMAND_REQUIRED');
  await rejects(call('owner_command',{command:'{"operation":"read","path":"hello.txt"}'}),'COMMAND_UNSUPPORTED');
  await rejects(call('owner_command',{command:'{"operation":"list","root":"C:/"}'}),'COMMAND_ARGUMENT_INVALID');
  await rejects(call('owner_file_read',{path:'hello.txt'}, {agent:{},callId:'fake'}),'OWNER_AGENT_MISMATCH');
  await rejects(call('owner_file_read',{projectId:'other',path:'hello.txt'}),'PROJECT_NOT_AUTHORIZED');
  assert.equal((await kit.verifyIsolation()).verified,false);
});
test('path/device/ADS/credential paths denied',async()=>{
  for(const p of ['../outside/outside.txt','C:/outside.txt','hello.txt:ads','a\\b.txt','.ssh/key.txt','private/x.txt','NUL.txt','x./a.txt'])await rejects(call('owner_file_read',{path:p}),'PATH_INVALID');
});
test('actual hardlink and directory symlink escape denied; originals preserved',async()=>{
  fs.linkSync(path.join(outside,'outside.txt'),path.join(root,'linked.txt'));
  await rejects(call('owner_file_read',{path:'linked.txt'}),'HARDLINK_DENIED');
  await rejects(call('owner_file_write',{path:'linked.txt',text:'bad'}),'HARDLINK_DENIED');
  fs.symlinkSync(outside,path.join(root,'junction'),'junction');
  await rejects(call('owner_file_read',{path:'junction/outside.txt'}),'REPARSE_DENIED');
  await rejects(call('owner_file_write',{path:'junction/new.txt',text:'bad'}),'REPARSE_DENIED');
  assert.equal(fs.readFileSync(path.join(outside,'outside.txt'),'utf8'),'SYNTHETIC OUTSIDE');
  assert.equal(fs.existsSync(path.join(outside,'new.txt')),false);
});
test('bounded output, binary denial, replay rejection, dynamic owner revocation',async()=>{
  fs.writeFileSync(path.join(root,'large.txt'),'\u0001'.repeat(60000));
  const output=await call('owner_file_read',{path:'large.txt'});assert.equal(output.truncated,true);assert.ok(Buffer.byteLength(JSON.stringify(output))<=65536);
  fs.writeFileSync(path.join(root,'binary.txt'),Buffer.from([0,1,2]));
  await rejects(call('owner_file_read',{path:'binary.txt'}),'BINARY_DENIED');
  const e=exec();await call('owner_file_read',{path:'hello.txt'},e);await rejects(call('owner_file_read',{path:'hello.txt'},e),'OPERATION_ALREADY_CONSUMED');
  owner=false;await rejects(call('owner_file_read',{path:'hello.txt'}),'OWNER_AUTHORITY_REVOKED');owner=true;
  bound.revoke();await rejects(call('owner_file_read',{path:'hello.txt'}),'OWNER_AGENT_MISMATCH');
});
test('synthetic artifacts remain for inspection',()=>{console.log('SYNTHETIC_EVIDENCE='+base);});
test('abort, queued revocation, linked root and oversized data fail closed',async()=>{
  const a={},fresh=createServerExecutor({python,projects:{work:root},isCurrentOwner:()=>true});
  const b=fresh.bind({agent:a,bindingId:'owner'}),controller=new AbortController();controller.abort();
  await rejects(b.execute('owner_file_read',{projectId:'work',path:'hello.txt'},{agent:a,callId:'abort',signal:controller.signal}),'TOOL_CANCELLED');
  const pending=b.execute('owner_file_write',{projectId:'work',path:'cancelled.txt',text:'never commit'},{agent:a,callId:'cancel-before-start'});b.revoke();
  await assert.rejects(pending);assert.equal(fs.existsSync(path.join(root,'cancelled.txt')),false);
  const linkRoot=path.join(base,'linked-root');fs.symlinkSync(root,linkRoot,'junction');
  const linked=createServerExecutor({python,projects:{work:linkRoot},isCurrentOwner:()=>true}).bind({agent:a,bindingId:'owner'});
  await rejects(linked.execute('owner_file_read',{projectId:'work',path:'hello.txt'},{agent:a,callId:'linked-root'}),'REPARSE_DENIED');
  const c=fresh.bind({agent:a,bindingId:'owner'});
  await rejects(c.execute('owner_file_write',{projectId:'work',path:'too-large.txt',text:'x'.repeat(65537)},{agent:a,callId:'large'}),'FILE_LIMIT');
});
