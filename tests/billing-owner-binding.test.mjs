import test from 'node:test';import assert from 'node:assert/strict';
import {bindOwnerBilling} from '../src/billing/owner-binding.mjs';import {digest} from '../src/state.mjs';
test('binding uses current host owner identity, handle, pause and disposal; group never registers',()=>{
 const agent={session:{id:'synthetic'}},chat={id:'owner',title:'Synthetic',mode:'private',owner:true},binding=digest(JSON.stringify([chat.id,chat.title,chat.mode,chat.owner]));
 let registered,disposed=0,cleanup;const collector={register(v){registered=v;return ()=>disposed++;}};
 const core={closed:false,store:{data:{paused:false}},handles:new Map([[chat.id,{agent}]]),chats:new Map([[chat.id,chat]]),state:()=>({binding})};
 const args={collector,getCore:()=>core,agentCtx:{effect(fn){cleanup=fn();}},agent,chat};
 bindOwnerBilling(args);assert.equal(registered.sessionId,'synthetic');assert.equal(registered.active(),true);
 core.store.data.paused=true;assert.equal(registered.active(),false);core.store.data.paused=false;
 core.handles.set(chat.id,{agent:{}});assert.equal(registered.active(),false);core.handles.set(chat.id,{agent});
 chat.title='CHANGED';assert.equal(registered.active(),false);chat.title='Synthetic';
 core.closed=true;assert.equal(registered.active(),false);cleanup();assert.equal(disposed,1);
 registered=null;bindOwnerBilling({...args,chat:{...chat,mode:'group'}});assert.equal(registered,null);
});
