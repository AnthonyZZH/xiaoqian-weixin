import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createOwnerNativeManagement} from '../src/owner-native-management.mjs';

function fixture(t,{pending=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'readonly-market-')),tools=new Map(),events=[];
 const agent={},bindingId='synthetic-owner-binding';let valid=true,release;
 const cache={async search(args){events.push({kind:'search',args});if(pending)return new Promise(resolve=>release=resolve);return{ok:false,code:'CATALOG_REFRESHING',noResults:false,refreshing:true};},close(){events.push({kind:'close'});}};
 const ctx={get(){return undefined;},on(){},effect(){},plugin(){throw Error('MCP_START_NOT_EXPECTED');},systemPrompt:{section(){}},tools:{register(def){tools.set(def.name,def);}}};
 const hostCtx={inject(){}};
 const management=createOwnerNativeManagement({hostCtx,isCurrentOwner:({agent:a,bindingId:b})=>valid&&a===agent&&b===bindingId,stateDir:root,python:'synthetic-python',marketFactory:options=>{events.push({kind:'construct',options});return cache;}});
 management.register({ctx,agent,bindingId,chatId:'owner',defineTool:x=>x});
 t.after(async()=>{await management.close();fs.rmSync(root,{recursive:true,force:true});});
 return{management,agent,bindingId,tools,events,revoke(){valid=false;},release(v){release(v);},invoke:(args,who=agent)=>tools.get('owner_plugins').execute(args,{agent:who,callId:'synthetic',signal:AbortSignal.timeout(2000)})};
}

test('cache is local/lazy at construction and only configured catalog search uses it',async t=>{
 const f=fixture(t);assert.equal(f.events.length,1);assert.equal(path.basename(f.events[0].options.cacheDir),'owner-market-cache');assert.equal(f.events[0].options.python,'synthetic-python');assert.equal(f.events[0].options.canonicalGithubApi,true);
 const result=await f.invoke({action:'search',query:'synthetic package'});
 assert.equal(result.code,'CATALOG_REFRESHING');assert.equal(result.noResults,false);assert.equal(f.events[1].args.query,'synthetic package');
 const before=f.events.length;const indexes=await f.invoke({action:'indexes'});assert.equal(indexes.community.length,2);assert.equal(f.events.length,before);
 await assert.rejects(f.invoke({action:'search',installedOnly:true,query:'synthetic'}),/MANAGER_UNAVAILABLE/);
 assert.equal(f.events.length,before);
});

test('foreign/group Agent is refused before cache; revoked owner cannot receive in-flight result',async t=>{
 const f=fixture(t,{pending:true});await assert.rejects(f.invoke({action:'search',query:'synthetic'},{}),/OWNER_ONLY/);assert.equal(f.events.length,1);
 const p=f.invoke({action:'search',query:'synthetic'});await new Promise(resolve=>setImmediate(resolve));f.revoke();f.release({ok:true,items:[]});await assert.rejects(p,/OWNER_ONLY/);
});

test('approval transport remains separate from cache and cache closes with component',async t=>{
 const f=fixture(t);assert.deepEqual(f.management.available(),['owner_plugins','owner_mcp']);
 assert.equal(typeof f.management.consumeOwnerApproval,'function');
 const mcp=f.tools.get('owner_mcp');assert.ok(mcp);assert.equal(f.events.filter(x=>x.kind==='search').length,0);
 await f.management.close();assert.ok(f.events.some(x=>x.kind==='close'));
});
