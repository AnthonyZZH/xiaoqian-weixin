import test from 'node:test';import assert from 'node:assert/strict';
import {apply,POLICY_SLOT} from './retrieval-runtime.mjs';
import {checkRotationHandoff} from './retrieval-budget.mjs';
test('scoped actual execute/render bounded, shared search budget, complete archive unchanged, reversible',async()=>{
 const source={ok:true,data:{title:'fixture',file_path:'fixture.md',content:'needle '.repeat(10000)}};const original=async()=>structuredClone(source);
 const read={execute:original,parameters:{type:'object',properties:{identifier:{type:'string'}}},description:'fixture',output:{render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]}};
 const search={execute:async()=>({ok:true,data:{results:[{title:'fixture',file_path:'fixture.md'}]}}),output:{render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]}};
 const agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{id:'fixture-session',deriveMessages:()=>[{id:'u',role:'user',source:{kind:'xiaoqian-wechat'},content:[{type:'text',text:'prefix\n'+JSON.stringify({text:'needle'})}]}]},ctx:{tools:{get:n=>n.endsWith('_read')?read:search}}};
 let creates=0;const core={chats:new Map([['owner',{id:'owner',owner:true,mode:'private'}]]),handles:new Map([['owner',{agent}]]),store:{data:{chats:{owner:{binding:'b'}}}},openHandle:async()=>{creates++;return {agent};}};const originalOpen=core.openHandle,bridge={core};const disposers=[];apply({xiaoqianBridge:bridge,effect:f=>disposers.push(f())});
 let chars=0;const sr=await search.execute({query:'needle'},{agent});chars+=search.output.render({},sr).reduce((n,b)=>n+b.text.length,0);
 for(let i=0;i<3;i++){const r=await read.execute({identifier:'fixture.md'},{agent});chars+=read.output.render({},r).reduce((n,b)=>n+b.text.length,0);}assert.ok(chars<=12000);assert.equal(source.data.content.length,70000);
 await assert.rejects(read.execute({identifier:'fixture.md'},{agent:{}}));assert.equal(bridge[POLICY_SLOT].status().readWrapped,true);
 const bad=JSON.stringify({schema:'xq.rotation.handoff/v1',summary:{text:'x'.repeat(4097),evidence_ids:[]}});await assert.rejects(core.openHandle('owner',{handoff:bad}));assert.equal(creates,0);
 disposers.reverse().forEach(f=>f());assert.equal(read.execute,original);assert.equal(core.openHandle,originalOpen);assert.equal(bridge[POLICY_SLOT],undefined);
});
test('guard preserves complete fixed handoff and citations or refuses before create, never truncates',()=>{const h={schema:'xq.rotation.handoff/v1',unfinished_tasks:['complete task'],summary:{text:'full summary',evidence_ids:['a:1']}};const text=JSON.stringify(h);assert.ok(checkRotationHandoff(text));assert.equal(JSON.stringify(h),text);assert.throws(()=>checkRotationHandoff(JSON.stringify({...h,unfinished_tasks:['x'.repeat(60001)]})),/FIXED_HANDOFF_LIMIT/);assert.throws(()=>checkRotationHandoff(JSON.stringify({...h,summary:{text:'ok',evidence_ids:['x'.repeat(9000)]}})),/SUMMARY_INJECTION_LIMIT/);});
