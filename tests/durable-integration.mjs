import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createBridge} from '../src/index.mjs';

const chat={id:'fake_group',title:'Synthetic Group',mode:'group',owner:false};
const owner={id:'fake_owner',title:'Synthetic Owner',mode:'private',owner:true};
const chatKey=createHash('sha256').update(JSON.stringify({mode:chat.mode,name:chat.title})).digest('hex');
fs.mkdirSync(path.resolve('.test-scratch'),{recursive:true});
function agentHost(records){
  return {
    async create(o){return open(o);},async resume(o){return open(o);}
  };
  async function open(o){
    const sessionId=o.sessionId||o.resumeSessionId;
    const agent={session:{id:sessionId},followup(m){records.push(m);},async whenIdle(){}};
    await o.setup?.({tools:{restrict(){},guard(){},register(){}},systemPrompt:{section(){}}},agent);
    return {agent,async dispose(){}};
  }
}
async function fixture(dir,records,{flush=true,faults={},mediaImportRoots=[],initiative={},snapshots,images={},transcripts={}}={}){
  const config={chats:[owner,chat],stateDir:dir,mode:'mock',startPaused:true,
    autoImages:false,python:process.env.XQ_TEST_PYTHON||'python',
    mediaImportRoots,initiative,timeZone:'UTC',
    mock:{snapshots:snapshots||{[chatKey]:[{key:'synthetic-1',text:'hello',role:'user'}]},faults,images,transcripts}};
  const bridge=await createBridge({agents:agentHost(records),sessions:{async flush(){return flush;}}},config,{defineTool:x=>x});
  bridge.core.resume();return bridge;
}

test('real Python subprocess ACKs only durable native and bridge receipts across restart',async t=>{
  const dir=fs.mkdtempSync(path.join(path.resolve('.test-scratch'),'python-ack-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const records=[];let b=await fixture(dir,records);
  try{
    const result=await b.core.poll(chat.id,{baseline:false});
    assert.equal(result.accepted,1);assert.equal(result.ackable.length,1);
    assert.equal(b.evidenceMemory.load(chat.id).turns.length,1);
    assert.equal((await b.driver.call('read',{targetId:chat.id})).messages.length,0);
    await b.core.close();b=await fixture(dir,records);
    assert.equal((await b.core.poll(chat.id,{baseline:false})).accepted,0);
    assert.equal(records.length,1);
    assert.equal(b.evidenceMemory.load(chat.id).turns.length,1);
  }finally{await b.core.close();}
});

test('group voice is transcribed and group image pixels stay outside the model and media store',async t=>{
  const dir=fs.mkdtempSync(path.join(path.resolve('.test-scratch'),'python-perception-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
  const snapshots={[chatKey]:[
    {key:'voice-1',text:'[语音]',role:'user',voice_available:true},
    {key:'image-1',text:'[图片]',role:'user',image_available:true}]};
  const records=[];const b=await fixture(dir,records,{snapshots,images:{'image-1':png},
    transcripts:{'voice-1':'synthetic voice words'}});
  try{
    const result=await b.core.poll(chat.id,{baseline:false});
    assert.equal(result.accepted,2);assert.equal(result.ackable.length,2);
    assert.equal((await b.driver.call('read',{targetId:chat.id})).messages.length,0);
    assert.match(JSON.stringify(records),/synthetic voice words/);
    const pending=await b.media.catalog({scope:chat.id,includePending:true});
    assert.equal(pending.length,0);
    assert.match(records[1].content[0].text,/"pixelsDelivered":false/);
    assert.ok(records[1].content.every(block=>block.type!=='image'));
    assert.ok(!JSON.stringify(records).includes(png));
  }finally{await b.core.close();}
});

test('durable initiative claims, model wake and one send survive restart without replay',async t=>{
  const dir=fs.mkdtempSync(path.join(path.resolve('.test-scratch'),'python-schedule-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const records=[];
  const initiative={initiative_group_minutes:[0.02,0.02],initiative_group_idle_minutes:0,
    initiative_quiet_hours:{group:'',private:''},send_quiet_hours:'',cooldown_seconds:0};
  let b=await fixture(dir,records,{initiative});
  try{
    assert.deepEqual(await b.initiative.tick(e=>b.core.wake(e.chatId,e)),[]);
    const clock=new DatabaseSync(path.join(dir,'schedule','schedule.sqlite3'));
    try {
      const due=clock.prepare('UPDATE chats SET next_at=0 WHERE key IN (SELECT chat_key FROM owner_wake_state)').run();
      assert.equal(due.changes,1);
    } finally { clock.close(); }
    const first=await b.initiative.tick(e=>b.core.wake(e.chatId,e));
    assert.equal(first.length,1);assert.equal(records.length,1);
    assert.equal(first[0].chatId,owner.id);
    const sent=await b.core.reply(owner.id,{text:'synthetic opening',deliveryId:'opening-1'},{});
    assert.equal(sent.status,'ok');
    await b.core.close();b=await fixture(dir,records,{initiative});
    assert.equal((await b.initiative.tick(e=>b.core.wake(e.chatId,e))).length,0);
    const audit=fs.readFileSync(path.join(dir,'driver','fake-events.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(audit.filter(x=>x.command==='send').length,1);
  }finally{await b.core.close();}
});

test('reviewed original two-frame GIF remains byte-identical through fake file send',async t=>{
  const dir=fs.mkdtempSync(path.join(path.resolve('.test-scratch'),'python-media-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const imports=path.join(dir,'imports');fs.mkdirSync(imports);
  const header=Buffer.from('47494638396101000100800000000000ffffff','hex');
  const frame=Buffer.from('21f90400080000002c0000000001000100000202440100','hex');
  const original=Buffer.concat([header,frame,frame,Buffer.from('3b','hex')]);
  const file=path.join(imports,'synthetic.gif');fs.writeFileSync(file,original);
  const b=await fixture(dir,[],{mediaImportRoots:[imports]});
  try{
    const candidate=await b.media.importOriginal(chat.id,file,{description:'two frame wave'});
    assert.equal(candidate.status,'pending');
    assert.deepEqual(await b.core.invoke(chat.id,'wechat_sticker_search',{query:'wave'}),[]);
    await b.media.approve(candidate.media_id,{scope:chat.id});
    const rows=await b.core.invoke(chat.id,'wechat_sticker_search',{query:'wave'});
    assert.equal(rows.length,1);assert.equal(rows[0].info.animated,true);
    const sent=await b.core.send(chat.id,{stickerId:candidate.media_id,deliveryId:'gif-original'});
    assert.equal(sent.status,'ok');
    const audit=fs.readFileSync(path.join(dir,'driver','fake-events.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(audit.filter(x=>x.command==='send_file').length,1);
    assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'),candidate.sha256);
  }finally{await b.core.close();}
});

test('native flush failure leaves Python inbox pending and unknown receipt unacked',async t=>{
  const dir=fs.mkdtempSync(path.join(path.resolve('.test-scratch'),'python-unknown-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const records=[];let b=await fixture(dir,records,{flush:false});
  try{
    await assert.rejects(b.core.poll(chat.id,{baseline:false}),/PERSISTENCE_NOT_CONFIRMED/);
    assert.equal((await b.driver.call('read',{targetId:chat.id})).messages.length,1);
    await b.core.close();b=await fixture(dir,records);
    const result=await b.core.poll(chat.id,{baseline:false});
    assert.equal(result.accepted,0);assert.equal(result.quarantined.length,1);
    assert.equal((await b.driver.call('read',{targetId:chat.id})).messages.length,1);
    assert.equal(records.length,1);
  }finally{await b.core.close();}
});

test('uncertain delivery is never replayed across restart and an independent delivery can proceed',async t=>{
  const dir=fs.mkdtempSync(path.join(path.resolve('.test-scratch'),'python-send-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const records=[];let b=await fixture(dir,records,{faults:{send:{action:'unknown'}}});
  try{
    const result=await b.core.send(chat.id,{text:'synthetic only',deliveryId:'first'});
    assert.equal(result.status,'unknown');
    assert.equal((await b.core.send(chat.id,{text:'synthetic only',deliveryId:'first'})).duplicate,true);
    await b.core.close();b=await fixture(dir,records);
    const receipt=await b.core.send(chat.id,{text:'synthetic only',deliveryId:'first'});
    assert.equal(receipt.status,'unknown');assert.equal(receipt.duplicate,true);
    assert.equal((await b.core.send(chat.id,{text:'different',deliveryId:'second'})).status,'ok');
    const audit=fs.readFileSync(path.join(dir,'driver','fake-events.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(audit.filter(x=>x.command==='send').length,2);
  }finally{await b.core.close();}
});

test('long reply uses bounded UI sends and never repeats a partially confirmed batch',async t=>{
  const dir=fs.mkdtempSync(path.join(path.resolve('.test-scratch'),'python-long-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const b=await fixture(dir,[],{faults:{send:{action:'unknown',calls:[2]}}});
  try{
    const result=await b.core.send(chat.id,{text:'x'.repeat(1300),deliveryId:'long'});
    assert.equal(result.status,'unknown');
    const replay=await b.core.send(chat.id,{text:'x'.repeat(1300),deliveryId:'long'});
    assert.equal(replay.status,'unknown');assert.equal(replay.duplicate,true);
    const audit=fs.readFileSync(path.join(dir,'driver','fake-events.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(audit.filter(x=>x.command==='send').length,2);
  }finally{await b.core.close();}
});

test('definitively unsent first part is rejected without an unknown-send fence',async t=>{
  const dir=fs.mkdtempSync(path.join(path.resolve('.test-scratch'),'python-reject-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const b=await fixture(dir,[],{faults:{send:{action:'failed',calls:[1]}}});
  try{
    assert.equal((await b.core.send(chat.id,{text:'first',deliveryId:'reject'})).status,'rejected');
    assert.equal(b.core.status(chat.id).sendQuarantined,false);
    assert.equal((await b.core.send(chat.id,{text:'second',deliveryId:'new'})).status,'ok');
  }finally{await b.core.close();}
});
