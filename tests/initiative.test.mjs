import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InitiativeStore } from '../src/initiative.mjs';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../evidence');
fs.mkdirSync(base,{recursive:true});
const chats=[{id:'owner',title:'Synthetic Owner',mode:'private',owner:true},
{id:'group',title:'Synthetic Group',mode:'group',owner:false},{id:'friend',title:'Synthetic Friend',mode:'private',owner:false}];
function setup({at='2026-10-29T02:00:00Z',config={}}={}){
 let now=Date.parse(at);const stateDir=fs.mkdtempSync(path.join(base,'initiative-test-'));
 const options={stateDir,chats,clock:()=>now,rng:()=>0,config:{initiative_quiet_hours:{},...config}};
 return {s:new InitiativeStore(options),options,advance:ms=>now+=ms,set:value=>now=Date.parse(value)};
}
test('owner peak and offpeak rules use explicit Asia/Shanghai wall time',()=>{
 const {s,set}=setup();s.heard('owner');assert.equal(s.describe('owner').nextAt-Date.parse('2026-10-29T02:00:00Z'),15*60000);
 set('2026-10-29T12:00:00Z');s.heard('owner');assert.equal(s.describe('owner').nextAt-Date.parse('2026-10-29T12:00:00Z'),5*60000);
});
test('group idle and random delay survive restart; unknown chat cannot wake',()=>{
 const {s,options,advance}=setup({config:{initiative_group_minutes:[2,2],initiative_group_idle_minutes:1}});
 s.heard('group');advance(179000);assert.deepEqual(s.due(),[]);advance(1000);
 const restored=new InitiativeStore(options);assert.ok(restored.due().includes('group'));assert.throws(()=>restored.heard('unlisted'),/CHAT_NOT_REGISTERED/);
});
test('owner sleep persists; following real owner message wakes; group content cannot invoke owner sleep',()=>{
 const {s,options,advance}=setup();s.heard('group',{text:'晚安'});assert.equal(s.ownerAsleep(),false);
 s.heard('owner',{text:'我睡了，晚安'});advance(600000);
 assert.equal(new InitiativeStore(options).ownerAsleep(),true);assert.ok(!s.due().includes('owner'));
 s.heard('owner',{text:'我回来了'});assert.equal(s.ownerAsleep(),false);
});
test('unanswered opening limit stops further openings and hearing resets it',()=>{
 const {s,advance}=setup({config:{initiative_group_minutes:[1,1],initiative_group_idle_minutes:0,initiative_max_unanswered:{group:1,private:2}}});
 s.heard('group');advance(60000);assert.ok(s.due().includes('group'));s.spoke('group',{opening:true});advance(60000);
 assert.ok(!s.due().includes('group'));s.heard('group');advance(60000);assert.ok(s.due().includes('group'));
});
test('quiet hours defer in configured zone including crossing midnight',()=>{
 const {s,advance}=setup({at:'2026-10-28T18:00:00Z',config:{initiative_group_minutes:[0,0],initiative_group_idle_minutes:0,
 initiative_quiet_hours:{group:'23-8'}}});
 s.heard('group');assert.ok(!s.due().includes('group'));
 assert.equal(s.describe('group').nextAt,Date.parse('2026-10-29T00:00:00Z'));
 advance(6*3600000);assert.ok(s.due().includes('group'));
});
test('short owner followup is one wake, bounded by incoming window',async()=>{
 const {s,advance}=setup({config:{proactive_after_seconds:[10,10]}});
 s.heard('owner');advance(10000);const events=[];await s.tick(e=>events.push(e));
 assert.equal(events.length,1);assert.equal(events[0].reason,'followup');await s.tick(()=>assert.fail('duplicate'));
});
test('persistent claims avoid blind repeat after callback uncertainty and restart',async()=>{
 const {s,advance,options}=setup({config:{proactive_after_seconds:[10,10]}});
 s.heard('owner');advance(10000);const result=await s.tick(async()=>{throw new Error('unknown delivery');});
 assert.equal(result[0].status,'uncertain');const restored=new InitiativeStore(options);
 assert.ok(restored.describe('owner').claim);assert.ok(!restored.due().includes('owner'));
 restored.resolveWake('owner',result[0].wakeId,{delivered:true});assert.equal(restored.describe('owner').claim,null);
});
test('pause persists and stops wake and send; no new loop or UI side effect',async()=>{
 const {s,advance,options}=setup({config:{proactive_after_seconds:[10,10]}});s.heard('owner');advance(10000);s.pause();
 const reopened=new InitiativeStore(options);assert.deepEqual(await reopened.tick(()=>assert.fail('paused')),[]);
 assert.equal(reopened.reserveSend('group').allowed,false);reopened.resume();assert.ok(reopened.due().includes('owner'));
});
test('send budget reserves before send, keeps uncertain send and owner bypass',()=>{
 const {s,advance}=setup({config:{cooldown_seconds:180,hourly_limit:1}});
 assert.equal(s.reserveSend('group').allowed,true);assert.equal(s.reserveSend('group').allowed,false);
 advance(181000);assert.equal(s.reserveSend('group').reason,'hourly_limit');
 assert.equal(s.reserveSend('owner').allowed,true);assert.equal(s.reserveSend('owner').allowed,true);
});
test('ordinary private contacts never receive unprompted openings by default',()=>{
 const {s,advance}=setup({config:{initiative_private_minutes:[0,0]}});s.heard('friend');advance(3600000);assert.ok(!s.due().includes('friend'));
});
test('corrupt scheduling state fails closed without overwriting it',()=>{
 const {s,options}=setup();fs.writeFileSync(s.file,'{"version":1,"paused":false,"chats":{"owner":{"nextAt":"bad"}}}');
 assert.throws(()=>new InitiativeStore(options),/INVALID_INITIATIVE_STATE/);
});
