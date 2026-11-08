import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createRotationLite,liteRates} from '../src/rotation-lite.mjs';

const card=JSON.parse(fs.readFileSync(new URL('../vendor/xiaoqian_schedule/price-card.json',import.meta.url)));
const calendar=JSON.parse(fs.readFileSync(new URL('../vendor/calendar-2026.json',import.meta.url)));
const rates=(iso,model='deepseek-flash',price=card)=>liteRates(price,model,Date.parse(iso),calendar);
const cases=[
 ['2026-11-09T08:59:59+08:00','offpeak'],['2026-11-09T09:00:00+08:00','peak'],
 ['2026-11-09T11:59:59+08:00','peak'],['2026-11-09T12:00:00+08:00','offpeak'],
 ['2026-11-09T13:59:59+08:00','offpeak'],['2026-11-09T14:00:00+08:00','peak'],
 ['2026-11-09T17:59:59+08:00','peak'],['2026-11-09T18:00:00+08:00','offpeak'],
 ['2026-11-08T23:59:59+08:00','offpeak'],['2026-11-09T00:00:00+08:00','offpeak'],
 ['2026-10-01T09:00:00+08:00','offpeak'],['2026-10-07T17:59:59+08:00','offpeak'],
 ['2026-10-08T09:00:00+08:00','peak'],['2026-10-10T09:00:00+08:00','offpeak'], // compensatory Saturday
 ['2026-11-08T09:00:00+08:00','offpeak'],['2026-01-01T00:00:00+08:00','offpeak'],
 ['2026-12-31T23:59:59+08:00','offpeak'],['2027-01-01T00:00:00+08:00','offpeak'],
 ['2027-01-04T09:00:00+08:00','calendar_unknown']
];

test('wake and rotation share the actual card across boundaries, holidays and both cadence ranges',()=>{
 assert.ok(process.env.XQ_TEST_PYTHON,'Set XQ_TEST_PYTHON to the installed local Python executable');
 const child=spawnSync(process.env.XQ_TEST_PYTHON,['-B',fileURLToPath(new URL('./wake_pricing.py',import.meta.url)),'--bands'],{
  input:JSON.stringify(cases.map(([iso])=>iso)),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:15000
 });
 assert.equal(child.status,0,child.error?.message||child.stderr);
 const wake=JSON.parse(child.stdout);
 cases.forEach(([iso,expected],i)=>{
  assert.equal(wake[i].band,expected,iso);
  assert.deepEqual(wake[i].bounds,expected==='offpeak'?[900,1800]:[3600,7200],iso);
  if(expected==='calendar_unknown') assert.throws(()=>rates(iso),/PRICE_CALENDAR_UNKNOWN/);
  else for(const model of Object.keys(card.models)){
   const actual=rates(iso,model);
   assert.deepEqual(actual,{...card.models[model].rates[expected],band:expected},iso+' '+model);
  }
 });
});

test('configured windows can cross midnight and honor the configured timezone',()=>{
 const custom=structuredClone(card);
 Object.assign(custom.band_policy,{timezone:'UTC',peak_intervals_local:[['22:00','02:00']],peak_weekdays:[1,2,3,4,5,6,7],exclude_cn_statutory_holidays:false});
 for(const [iso,band] of [['2026-11-09T21:59:59Z','offpeak'],['2026-11-09T22:00:00Z','peak'],
  ['2026-11-09T23:59:59Z','peak'],['2026-11-10T00:00:00Z','peak'],['2026-11-10T01:59:59Z','peak'],['2026-11-10T02:00:00Z','offpeak']]){
  assert.equal(rates(iso,'deepseek-flash',custom).band,band);
 }
});

test('flat tariff uses flat prices without requiring a holiday calendar',()=>{
 const flat=structuredClone(card);
 flat.band_policy.time_based_pricing=false;
 flat.models['deepseek-flash'].rates.flat={hit:0.02,miss:1,output:4};
 assert.deepEqual(rates('2027-01-04T09:00:00+08:00','deepseek-flash',flat),{hit:0.02,miss:1,output:4,band:'flat'});
});

test('rotation service loads the shared default card without inline price overrides',async t=>{
 const root=fs.mkdtempSync(fileURLToPath(new URL('./synthetic-pricing-',import.meta.url)));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let now=Date.parse('2026-11-09T09:00:00+08:00');
 const events=[],add=input=>events.push({type:'assistant/message',data:{usage:{inputTokens:input,outputTokens:0}}});
 add(100);add(1000);
 const session={id:'synthetic-session',get seq(){return events.length;},eventAt:i=>events[i]};
 const state={sessionId:session.id},audits=[];
 const core={model:{model:'deepseek-flash'},handles:new Map([['synthetic-owner',{agent:{session,status:'running'}}]]),state:()=>state,
  store:{data:{paused:false},audit:code=>audits.push(code)}};
 const service=createRotationLite({getCore:()=>core,clock:()=>now,config:{stateDir:root,chats:[{id:'synthetic-owner',owner:true,mode:'private'}],rotationLite:{enabled:true}}});
 t.after(()=>service.close());
 await service.tick();
 const saved=()=>JSON.parse(fs.readFileSync(root+'/rotation-lite.json','utf8'));
 assert.equal(saved().keep,0.0018);
 now=Date.parse('2026-11-09T12:00:00+08:00');add(1000);await service.tick();
 assert.ok(Math.abs(saved().keep-0.0027)<1e-12);assert.deepEqual(audits,[]);
});
