import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {createLiveProjection} from './live-projection-r3.mjs';import {createNumericSampler} from './numeric-sampler-r2.mjs';import {adviseDimensions} from './live-advisor.mjs';
import {fileURLToPath} from 'node:url';import path from 'node:path';
import fs from 'node:fs';import {apply as applyShadow} from './numeric-shadow-r3.mjs';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
function fixture(){
 const messages=[{id:'system',role:'system',content:[{type:'text',text:'SYNTHETIC POLICY'}]},{id:'user',role:'user',content:[{type:'text',text:'SYNTHETIC PRIVATE BODY NEVER EXPORTED'}]}];
 const session={id:'synthetic-session',seq:2,surface:{contentGeneration:1,nodes:[0,1]},deriveMessages:()=>messages,eventAt:i=>messages[i],deriveEventMessage:e=>e,requestHeader:()=>({tools:[],config:{maxTokens:1024}}),toolHistory:()=>({tools:[],updates:[]})};
 const state={binding:'synthetic-binding'},agent={session},core={chats:new Map([['owner',{id:'owner',mode:'private',owner:true}]]),handles:new Map([['owner',{agent}]]),store:{data:{chats:{owner:state}}},model:{provider:'synthetic-provider',model:'synthetic-model'}};
 const bridge={core};bridge[Symbol.for('xiaoqian.retrieval-budget.v1')]={status:()=>({enforced:true,rotationGuardInstalled:true}),rotationLimits:{fixedHandoffChars:60000,summaryChars:8192},policy:{maxChars:12000}};
 const pair={request_hash:sha('synthetic-request'),session_hash:sha(session.id),model:core.model.model,route_id:'synthetic-provider/synthetic-model',complete:true,meter_input:100,usage:{hit:20,miss:30,write:0,output:2}};
 return {bridge,session,state,pair};
}
test('canonical active projection exports numeric sizes and caches; no ledger read or body export',async()=>{const f=fixture();const p=createLiveProjection({...f,pairs:[f.pair],caps:{bounds:{archive_bytes_upper:1024}},ownerChatId:'owner'});
 const a=await p.measure();assert.equal(a.canonical_records,1);assert.equal(JSON.stringify(a).includes('PRIVATE BODY'),false);assert.equal(await p.measure(),a);assert.equal(p.status().activeSurfaceScans,1);assert.equal(p.status().cacheHits,1);f.state.binding='changed';await assert.rejects(p.measure(),/BINDING_CHANGED/);p.close();
});
test('missing calibration or owner scope refuses projection instead of inventing numbers',async()=>{const f=fixture();assert.throws(()=>createLiveProjection({...f}),/EXPLICIT_OWNER/);const p=createLiveProjection({...f,pairs:[],caps:{bounds:{archive_bytes_upper:1024}},ownerChatId:'owner'});await assert.rejects(p.measure(),/NO_EXISTING_SAME_MODEL/);p.close();});
test('metadata sampler does not derive messages or access message content and remains OFF',()=>{const events=[{type:'assistant/message',seq:0,time:1,data:{usage:{inputTokens:10,cacheReadTokens:20,cacheWriteTokens:0,outputTokens:1},message:{source:{provider:'synthetic',model:'synthetic'}}}},{type:'turn/end',seq:1,data:{reason:{kind:'completed'}}}];Object.defineProperty(events[0].data.message,'content',{get(){throw Error('BODY_READ');}});
 const f=fixture();f.session.eventAt=i=>events[i];f.session.deriveMessages=()=>{throw Error('BODY_DERIVE');};const s=createNumericSampler({bridge:f.bridge,sourceCaps:{},libraryPolicy:{}}).sample();assert.equal(s.autoEnabled,false);assert.equal(s.effects.modelCalls,0);assert.equal(s.effects.sessionSwitches,0);assert.equal(s.cached_numeric_usage.length,1);assert.equal(s.completed_turns_observed,1);
});
test('internal maximum unreviewed window fails closed, independent of official expiry; no network call',async()=>{const result=await adviseDimensions({root:path.dirname(fileURLToPath(import.meta.url)),python:process.env.XQ_TEST_PYTHON,at:'2026-11-09T04:56:39Z',dimensions:{model:'deepseek-flash'}});assert.equal(result.automatic_permission,false);assert.equal(result.reason,'QUOTE_LOCAL_REVIEW_OVERDUE');});
test('public shadow startup requires explicit OFF and verified host parameters, starts empty and disposes',async()=>{
 assert.throws(()=>applyShadow({},{}),/AUTO_FALSE/);
 const parent=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../.test-scratch');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'numeric-runtime-'));
 const f=fixture(),disposers=[],tool={execute:async()=>({ok:true,data:{content:'SYNTHETIC DOCUMENT'}}),parameters:{type:'object',properties:{}},description:'synthetic',output:{render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]}},original=tool.execute;
 const agent=f.bridge.core.handles.get('owner').agent;agent.status='idle';agent.inbox={nextTurn:[],nextStep:[]};agent.ctx={tools:{get:n=>n.endsWith('_read')?tool:undefined}};
 delete f.bridge[Symbol.for('xiaoqian.retrieval-budget.v1')];f.bridge.core.openHandle=async()=>({agent});f.session.seq=0;f.session.surface.nodes=[];f.session.deriveMessages=()=>[];
 try{assert.throws(()=>applyShadow({xiaoqianBridge:f.bridge},{autoEnabled:false,stateRoot:root}),/SOURCE_CAPS_REQUIRED/);
  applyShadow({xiaoqianBridge:f.bridge,effect:fn=>disposers.push(fn())},{autoEnabled:false,stateRoot:root,sourceCaps:{bounds:{archive_bytes_upper:1024}},libraryPolicy:{expected_incremental_external_api_fee:'0',not_execution_permission:true},python:process.env.XQ_TEST_PYTHON});
  await new Promise(resolve=>setImmediate(resolve));const status=JSON.parse(fs.readFileSync(path.join(root,'shadow-numeric.json'),'utf8'));
  assert.equal(status.autoEnabled,false);assert.equal(status.automatic_permission,false);assert.equal(status.decision.reason,'NO_EXISTING_SAME_MODEL_SIZE_USAGE_PAIR');assert.equal(status.effects.modelCalls,0);assert.equal(status.effects.sessionSwitches,0);assert.notEqual(tool.execute,original);
 }finally{disposers.reverse().forEach(fn=>fn());assert.equal(tool.execute,original);assert.equal(path.dirname(root),parent);fs.rmSync(root,{recursive:true,force:true});}
});
