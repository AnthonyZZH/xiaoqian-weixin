import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {install} from '../tools/refresh-empty-legacy-task.mjs';
test('real rc4 recreates only idle owner scope and preserves persisted session',async()=>{
 const base=process.env.XQ_NATIVE_PACKAGE_ROOT;if(!base)throw Error('XQ_NATIVE_PACKAGE_ROOT_REQUIRED');const load=n=>import(pathToFileURL(path.join(base,n,'lib/index.js')).href);
 const {Context}=await load('cordis'),ctx=new Context(),fibers=[],root=fs.mkdtempSync(path.join(os.tmpdir(),'xq-task-refresh-'));let bridge,extension;
 try{
  for(const n of ['dsh-system-prompt','dsh-session','dsh-agent','dsh-llm','dsh-tools','dsh-session-projection','dsh-agent-loop'])fibers.push(ctx.plugin((await load(n)).default,{}));
  fibers.push(ctx.plugin(await load('dsh-session-persistence-jsonl'),{root:path.join(root,'sessions'),compression:'none'}));for(const f of fibers)await f.await();
  const {createBridge}=await import('../src/index.mjs'),{defineTool}=await load('dsh-tools');
  bridge=await createBridge(ctx,{mode:'mock',stateDir:path.join(root,'state'),ownerTaskTools:['synthetic_executor'],chats:[{id:'owner',title:'SYNTHETIC OWNER',mode:'private',owner:true},{id:'group',title:'SYNTHETIC GROUP',mode:'group',owner:false}]},{defineTool,driver:{pause(){},resume(){},close(){},async call(){throw Error('UI_CALL_FORBIDDEN');}}});
  bridge.core.resume();const h=await bridge.core.handle('owner'),g=await bridge.core.handle('group');
  const before=(await h.agent.ctx.tools.schemas(h.agent)).map(t=>t.name);assert.ok(before.includes('wechat_task'));
  const session=h.agent.session.id;bridge.core.capabilities.taskManager.tools=[];extension=install(bridge.core);const proof=await extension.refresh();
  assert.equal(proof.legacySubmit,false);assert.equal(proof.legacyStatus,true);assert.equal(proof.sameSession,true);assert.equal(bridge.core.handles.get('owner').agent.session.id,session);assert.equal(bridge.core.handles.get('group'),g);
  assert.equal(install(bridge.core),extension);console.log(JSON.stringify({sameOwnerSession:true,groupHandleUnchanged:true,legacySubmit:false,legacyStatus:true,paidCalls:0,wechatSends:0}));
 }finally{extension?.close();await bridge?.core.close();for(const f of fibers.reverse())await f.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
