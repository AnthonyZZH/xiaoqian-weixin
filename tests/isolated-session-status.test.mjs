import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {selectOfficialProviderEntries} from '../src/owner-balance.mjs';
import {digest} from '../src/state.mjs';import {projectIsolatedTaskStatus,createOwnerIsolatedTasks} from '../src/owner-isolated-runtime.mjs';
import {createCoreSessionSource} from '../vendor/owner-tools/session-status/sources.mjs';import {sessionStatusDto} from '../vendor/owner-tools/session-status/index.mjs';
const no=()=>{throw Error('FORBIDDEN_PRIVATE_OR_SIDE_EFFECT');},id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function fixture(){
 const chat={id:'owner',title:'SYNTHETIC PRIVATE TITLE',mode:'private',owner:true},principal=digest(JSON.stringify([chat.id,chat.title,chat.mode,chat.owner])),owner={};
 const core={chats:new Map([[chat.id,chat]]),handles:new Map([[chat.id,{agent:owner}]]),capabilities:{},store:{data:{paused:false,chats:{owner:{binding:principal,messages:{},deliveries:{}}}}},state:no,status:no,handle:no,openHandle:no};
 const j={task_id:id,chatId:'owner',principal,status:'running',createdAt:100,updatedAt:200,error:'Bearer SECRET ERROR'};
 for(const key of ['task','result','instruction','request','personaBase','text'])Object.defineProperty(j,key,{get:no,enumerable:true});
 const child={status:'running',inbox:{nextTurn:[{}],nextStep:[]},get session(){return no();}};
 const args={core,jobs:{[id]:j},handles:new Map([['xq-isolated-'+id,{agent:child}]]),ownerEntries:new Map([[owner,{agent:owner,chatId:'owner',bindingId:principal}]]),clock:()=>1000};
 return{args,core,j,chat,principal,owner};
}
test('projection reads only metadata, no private task/result/native files or agent session',()=>{
 const f=fixture(),read=fs.readFileSync,list=fs.readdirSync;let rows;
 try{fs.readFileSync=no;fs.readdirSync=no;rows=projectIsolatedTaskStatus(f.args);}finally{fs.readFileSync=read;fs.readdirSync=list;}
 assert.equal(rows.length,1);assert.equal(rows[0].queueLength,1);assert.equal(rows[0].loaded,true);assert.equal(rows[0].engineState,'running');
 const encoded=JSON.stringify(rows);for(const s of ['SECRET','SYNTHETIC PRIVATE TITLE','instruction','personaBase','result','task":','agent":'])assert.ok(!encoded.includes(s),s);
 assert.equal(rows[0].lastError,null);
});
test('projection filters changed owner binding, foreign root handle and group owner claim',()=>{
 const f=fixture();f.core.store.data.chats.owner.binding='changed';assert.deepEqual(projectIsolatedTaskStatus(f.args),[]);
 f.core.store.data.chats.owner.binding=f.principal;f.core.handles.set('owner',{agent:{}});assert.deepEqual(projectIsolatedTaskStatus(f.args),[]);
 f.core.handles.set('owner',{agent:f.owner});f.core.chats.set('owner',{...f.chat,mode:'group'});assert.deepEqual(projectIsolatedTaskStatus(f.args),[]);
});
test('isolated source suppresses legacy schema disk scan and DTO supports metadata-only loaded queue',()=>{
 const f=fixture();f.core.capabilities.isolatedTaskStatusRows=()=>projectIsolatedTaskStatus(f.args);
 const read=fs.readFileSync,list=fs.readdirSync;let view;
 try{fs.readFileSync=no;fs.readdirSync=no;view=createCoreSessionSource(f.core,{clock:()=>1000,longTaskRoot:'C:/synthetic-must-not-read'})();}finally{fs.readFileSync=read;fs.readdirSync=list;}
 assert.equal(view.coverage.isolatedTaskRegistry,true);assert.equal(view.coverage.longTaskFileScanSuppressed,true);assert.equal(view.rows.filter(r=>r.kind==='long-task').length,1);
 const dto=sessionStatusDto(view.rows.find(r=>r.kind==='long-task'),{now:1000});assert.equal(dto.loaded,true);assert.equal(dto.queueLength,1);assert.equal(dto.engineState,'running');assert.equal(dto.eventWindowComplete,false);assert.ok(!dto.blockers.some(b=>b.code==='SESSION_NOT_LOADED'));
});
test('factory status API is present and does not initialize execution or require provider',async()=>{
 const f=fixture(),runtime=createOwnerIsolatedTasks({hostCtx:{get:no,agents:{create:no,resume:no,get:no},sessions:{}},getCore:()=>f.core,isCurrentOwner:no,root:'C:/synthetic-not-created',model:{provider:'absent'}});
 assert.deepEqual(runtime.sessionStatusRows(),[]);await runtime.close();assert.deepEqual(runtime.sessionStatusRows(),[]);
});
test('provider selection never enables disabled official row or switches to account route',()=>{
 const active={id:'llm-deepseek',options:{name:'@deepseek-ai/dsh-llm-deepseek-api-key',disabled:false,get config(){return no();}}};
 const disabled={id:'old-official',options:{name:'@deepseek-ai/dsh-llm-deepseek-api-key',disabled:true,get config(){return no();}}};
 const account={id:'llm-deepseek-account',options:{name:'@deepseek-ai/dsh-llm-deepseek-account',disabled:false,get config(){return no();}}};
 const options={shimFile:'C:/synthetic/provider-shim.mjs',stateDir:'C:/synthetic/absent'};
 assert.deepEqual(selectOfficialProviderEntries([disabled,account],options),[]);
 assert.deepEqual(selectOfficialProviderEntries([active,disabled,account],options),[active]);
});
