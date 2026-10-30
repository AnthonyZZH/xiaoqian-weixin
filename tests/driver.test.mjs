import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DriverClient } from '../driver/client.mjs';

const root=resolve('.test-data'); mkdirSync(root,{recursive:true});
const targets=[{id:'owner',title:'Synthetic owner',mode:'private'},{id:'group',title:'Synthetic group',mode:'group'}];
function fixture(t, options={}) {
  const folder=mkdtempSync(join(root,'driver-'));
  const args={python:'python',targets,statePath:join(folder,'state.json'),timeoutMs:2000,...options};
  const client=new DriverClient(args); t.after(()=>client.close()); return {client,folder,args};
}

test('default is simulated and exact target binding rejects model overrides',async t=>{
  const {client}=fixture(t);
  assert.equal((await client.call('health')).mode,'mock');
  assert.equal((await client.call('read',{targetId:'stranger'})).code,'DRIVER_TARGET_DENIED');
  assert.equal((await client.call('send_text',{targetId:'owner',title:'another',text:'hello',idempotencyKey:'bound'})).code,'DRIVER_TARGET_OVERRIDE_DENIED');
  assert.throws(()=>new DriverClient({mode:'live'}),/LIVE_DRIVER_NOT_ENABLED/);
});

test('read ids survive worker recreation and keep chat identities separate',async t=>{
  const rows=[{key:'row-1',role:'user',sender:'person',text:'synthetic hello'}];
  const {client}=fixture(t,{mock:{messages:{owner:rows,group:rows}}});
  const a=await client.call('read',{targetId:'owner'});
  const g=await client.call('read',{targetId:'group'});
  assert.equal(a.messages.length,1); assert.notEqual(a.messages[0].id,g.messages[0].id);
  client.pause(); client.resume();
  const b=await client.call('read',{targetId:'owner'});
  assert.equal(a.messages[0].id,b.messages[0].id);
});

test('successful send is not repeated across process restart and changed payload conflicts',async t=>{
  const {client,args}=fixture(t);
  const request={targetId:'owner',text:'synthetic message',idempotencyKey:'send-1'};
  assert.equal((await client.call('send_text',request)).status,'ok');
  const duplicate=await client.call('send_text',request); assert.equal(duplicate.duplicate,true);
  assert.equal((await client.call('send_text',{...request,text:'changed'})).code,'DRIVER_IDEMPOTENCY_CONFLICT');
  await client.close();
  const restarted=new DriverClient(args); t.after(()=>restarted.close());
  const again=await restarted.call('send_text',request);
  assert.equal(again.duplicate,true); assert.equal(restarted.generation,0,'duplicate never starts UI worker');
});

test('hung send is unknown, worker recovers for reads, send fence persists after restart',async t=>{
  const {client,args}=fixture(t,{timeoutMs:300,mock:{hangOperations:['send_text']}});
  const request={targetId:'owner',text:'hang fixture',idempotencyKey:'hang-1'};
  const unknown=await client.call('send_text',request);
  assert.equal(unknown.status,'unknown');
  assert.equal((await client.call('health')).status,'ok');
  assert.equal(client.generation,2);
  assert.equal((await client.call('send_text',{...request,idempotencyKey:'new-key'})).code,'SEND_RECONCILIATION_REQUIRED');
  await client.close();
  const restarted=new DriverClient({...args,mock:{}}); t.after(()=>restarted.close());
  assert.equal((await restarted.call('send_text',{...request,idempotencyKey:'new-key'})).status,'unknown');
  assert.equal(restarted.generation,0);
  assert.equal((await restarted.reconcileSend('hang-1','not_sent')).status,'ok');
  assert.equal((await restarted.call('send_text',{...request,idempotencyKey:'new-key'})).status,'ok');
});

test('paused active send becomes uncertain; queued UI work does not run until resumed',async t=>{
  const {client}=fixture(t,{mock:{delayMs:150}});
  await client.call('health');
  const sending=client.call('send_text',{targetId:'owner',text:'pause fixture',idempotencyKey:'pause-1'});
  await new Promise(resolve=>setTimeout(resolve,30));
  const queued=client.call('read',{targetId:'group'}); client.pause();
  assert.equal((await sending).status,'unknown');
  assert.equal((await queued).status,'paused');
  client.resume(); assert.equal((await client.call('read',{targetId:'group'})).status,'ok');
});

test('read timeout does not fence sending and future worker starts cleanly',async t=>{
  const {client}=fixture(t,{timeoutMs:300,mock:{hangOperations:['read']}});
  assert.equal((await client.call('read',{targetId:'owner'})).code,'DRIVER_TIMEOUT');
  assert.equal((await client.call('send_text',{targetId:'owner',text:'after read failure',idempotencyKey:'after-timeout'})).status,'ok');
});

test('crashed send never gets silently replayed',async t=>{
  const {client}=fixture(t,{mock:{crashOperations:['send_text']}});
  const req={targetId:'owner',text:'crash fixture',idempotencyKey:'crash-1'};
  assert.equal((await client.call('send_text',req)).status,'unknown');
  assert.equal((await client.call('send_text',req)).duplicate,true);
  assert.equal((await client.call('health')).status,'ok');
});

test('worker validates mention mode and confined original-media path before simulated send',async t=>{
  const assets=mkdtempSync(join(root,'driver-assets-'));
  const gif=join(assets,'original.gif'); const original=Buffer.from('GIF89a-original-animation-fixture'); writeFileSync(gif,original);
  const {client}=fixture(t,{mediaRoot:assets});
  assert.equal((await client.call('send_text',{targetId:'owner',text:'hello',at:['person'],idempotencyKey:'bad-at'})).code,'DRIVER_MENTION_PRIVATE_DENIED');
  const out=join(root,'outside.gif'); writeFileSync(out,original);
  assert.equal((await client.call('send_image',{targetId:'owner',path:out,idempotencyKey:'outside'})).code,'DRIVER_MEDIA_DENIED');
  assert.equal((await client.call('send_image',{targetId:'owner',path:gif,idempotencyKey:'gif'})).status,'ok');
  assert.deepEqual(readFileSync(gif),original);
});

test('invalid persisted intent state fails closed',async t=>{
  const folder=mkdtempSync(join(root,'driver-invalid-')); const path=join(folder,'state.json'); writeFileSync(path,'{broken');
  assert.throws(()=>new DriverClient({targets,statePath:path}),/DRIVER_STATE_INVALID/);
});
