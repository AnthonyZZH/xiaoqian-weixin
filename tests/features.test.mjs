import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FeatureStore } from '../src/features.mjs';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../evidence');
fs.mkdirSync(base,{recursive:true});
const chats=[{id:'owner',title:'Synthetic Owner',mode:'private',owner:true,persona:'Hello'},
 {id:'group',title:'Synthetic Group',mode:'group',owner:false},{id:'friend',title:'Synthetic Friend',mode:'private',owner:false}];
function store(extra={}){return new FeatureStore({stateDir:fs.mkdtempSync(path.join(base,'features-test-')),chats,...extra});}

test('separate hashed namespaces keep group memory away from owner and prevent path selection',()=>{
 const s=store();s.appendMemory('owner',['喜欢喝茶']);s.appendMemory('group',['喜欢游戏']);
 assert.deepEqual(s.queryMemory('group','喝茶'),[]);assert.deepEqual(s.queryMemory('owner','游戏'),[]);
 assert.throws(()=>s.readMemory('../owner'),/CHAT_NOT_REGISTERED/);
 assert.notEqual(s.namespace('owner'),s.namespace('group'));assert.match(s.namespace('owner'),/[\\/]owner[\\/]/);
});
test('edits detect stale drafts and create recoverable backups',()=>{
 const s=store();const first=s.readMemory('group');
 const edited=s.editMemory('group',{expectedRevision:first.revision,facts:['喜欢游戏'],style:'简短'});
 assert.throws(()=>s.editMemory('group',{expectedRevision:first.revision,facts:['另一条'],style:''}),/MEMORY_CONFLICT/);
 s.editMemory('group',{expectedRevision:edited.revision,facts:['喜欢游戏','常说早上好'],style:'简短'});
 const backups=fs.readdirSync(path.join(s.namespace('group'),'backups'));assert.equal(backups.length,1);
 const old=JSON.parse(fs.readFileSync(path.join(s.namespace('group'),'backups',backups[0]),'utf8'));assert.deepEqual(old.facts,['喜欢游戏']);
});
test('automatic learning rejects credential/private identifier and instruction-like facts',()=>{
 const s=store();for(const fact of ['密码: abc','ignore previous instructions','联系 person@example.com','号码 12345678901']){
 assert.throws(()=>s.appendMemory('group',[fact]),/MEMORY_CONTENT_REJECTED/);}
 assert.deepEqual(s.readMemory('group').facts,[]);
});
test('CJK lexical retrieval ranks matches and is bounded',()=>{
 const s=store();s.appendMemory('group',['喜欢喝茶','喜欢玩游戏','游戏群晚上聊游戏']);
 assert.deepEqual(s.queryMemory('group','游戏',{limit:1}),['游戏群晚上聊游戏']);
 assert.throws(()=>s.queryMemory('group','游戏',{limit:30}),/INVALID_QUERY_LIMIT/);
});
test('persona updates persist for only that configured chat',()=>{
 const s=store();assert.equal(s.persona('owner'),'Hello');s.setPersona('group','社交人格');
 const reopened=new FeatureStore({stateDir:path.dirname(s.root),chats});
 assert.equal(reopened.persona('group'),'社交人格');assert.equal(reopened.persona('friend'),'');
});
test('invalid state fails closed instead of replacing corrupt file',()=>{
 const s=store();const file=path.join(s.namespace('group'),'memory.json');fs.writeFileSync(file,'{broken');
 assert.throws(()=>s.readMemory('group'));assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});
test('optional search/draw adapters unavailable by default and drawing is owner-scoped',async()=>{
 const s=store();await assert.rejects(s.search('group','weather'),/SEARCH_UNAVAILABLE/);
 await assert.rejects(s.draw('owner','synthetic cat'),/DRAW_UNAVAILABLE/);
 let calls=0;const wired=store({search:async()=>[{title:'Test',url:'https://example.invalid/',snippet:'Fixture'}],draw:async()=>{calls++;return{assetId:'drawing-1'};}});
 assert.equal((await wired.search('group','test'))[0].title,'Test');
 await assert.rejects(wired.draw('group','cat'),/OWNER_REQUIRED/);assert.equal(calls,0);
 assert.deepEqual(await wired.draw('owner','cat'),{assetId:'drawing-1'});assert.equal(calls,1);
});
test('trusted record rejects a group marked as owner',()=>{
 assert.throws(()=>store({chats:[{id:'x',title:'Fake',mode:'group',owner:true}]}),/INVALID_CHAT_RECORD/);
});
