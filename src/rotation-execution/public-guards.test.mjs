import test from 'node:test';import assert from 'node:assert/strict';
import {TaskWireBudget} from '../../vendor/isolated-owner/wire-budget.mjs';
import {createColdGuard,createSummaryGuard,createWireGuardRegistry} from './wire-guards.mjs';
import {createExecution} from './execution.mjs';
// These are synthetic final-provider payloads, not an SDK serializer test.
const fixture=()=>{const handoff='SYNTHETIC HANDOFF',input={content:[{type:'text',text:'SYNTHETIC KNOWN INPUT'}]};return {handoff,input,model:'synthetic-model',unitsUpper:10000,isCurrent:()=>true,wire:{init:{body:JSON.stringify({model:'synthetic-model',system:handoff,messages:[{role:'user',content:input.content}]})}}};};
test('synthetic final cold payload passes once; physical replay is denied',()=>{const f=fixture(),g=createColdGuard(f);assert.ok(g(f.wire).units>0);assert.throws(()=>g(f.wire),/PHYSICAL_ATTEMPT/);});
for(const mode of ['handoff','input','size','version'])test('synthetic cold '+mode+' fails before network dispatch',async()=>{const f=fixture(),b=JSON.parse(f.wire.init.body),budget=new TaskWireBudget();budget.transportAttached=true;let calls=0;const registry=createWireGuardRegistry(budget);
 if(mode==='handoff')b.system='OTHER';if(mode==='input')b.messages=[];
 const slot=registry.install('synthetic-session',createColdGuard({...f,unitsUpper:mode==='size'?1:f.unitsUpper,isCurrent:()=>mode!=='version'}),new AbortController().signal);
 try{await assert.rejects(async()=>budget.fetch(async()=>{calls++;},{sessionId:'synthetic-session'},'https://synthetic.invalid',{body:JSON.stringify(b)}));assert.equal(calls,0);}finally{slot.close();registry.close();}
});
test('summary guard binds exact input, guide, 1024 cap and no tools before transport',()=>{const options={model:'synthetic-model',payload:'SYNTHETIC EVIDENCE',guide:'SYNTHETIC GUIDE',unitsUpper:10000,isCurrent:()=>true};const body={model:options.model,system:options.guide,max_tokens:1024,thinking:{type:'disabled'},messages:[{role:'user',content:options.payload}]};
 assert.ok(createSummaryGuard(options)({init:{body:JSON.stringify(body)}}).units>0);
 for(const change of [{max_tokens:2048},{tools:[{name:'forbidden'}]},{messages:[]},{system:'OTHER'}])assert.throws(()=>createSummaryGuard(options)({init:{body:JSON.stringify({...body,...change})}}),/SUMMARY_WIRE/);
});
test('OFF entry never accesses snapshots, archive, summary, numeric evidence or switching',async()=>{let calls=0;const forbidden=()=>{calls++;throw Error('MUST_NOT_RUN');};const s=createExecution({autoEnabled:false,core:{},dimensions:forbidden,capture:forbidden,createPorts:forbidden,worker:forbidden});assert.deepEqual(await s.beforeInput({}),{status:'skip',reason:'AUTO_DISABLED'});assert.equal(calls,0);s.close();});
test('untrusted or nontext owner input cannot reach numeric or archive paths even if enabled',async()=>{let calls=0;const forbidden=()=>{calls++;throw Error('MUST_NOT_RUN');};const core={isPreparedOwnerInput:x=>x.trusted===true};const s=createExecution({autoEnabled:true,core,ownerId:'owner',dimensions:forbidden,capture:forbidden,createPorts:forbidden});
 for(const input of [{trusted:false},{trusted:true,chatId:'group'},{trusted:true,chatId:'owner',message:{content:[{type:'image'}]}}])assert.equal((await s.beforeInput(input)).reason,'ACTUAL_OWNER_TEXT_INPUT_REQUIRED');assert.equal(calls,0);s.close();
});
