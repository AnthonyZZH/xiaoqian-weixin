import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createBridge} from '../src/index.mjs';

const packageRoot=process.env.DSH_PACKAGE_ROOT||'C:/xiaoqian/app/dsh/node_modules/@deepseek-ai';
test('server installed rc.4 defineTool validates real plugin tool contracts without model or UI',{skip:!fs.existsSync(path.join(packageRoot,'dsh-tools/lib/index.js'))},async()=>{
  const pkg=JSON.parse(fs.readFileSync(path.join(packageRoot,'dsh/package.json'),'utf8'));
  assert.equal(pkg.version,'0.2.1-rc.4');
  const {defineTool}=await import(pathToFileURL(path.join(packageRoot,'dsh-tools/lib/index.js')).href);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xq-native-contract-'));const definitions=[];
  let actualAgent;
  const ctx={
    agents:{async create(options){
      const agent={session:{id:options.sessionId},followup(){},inject(){}};actualAgent=agent;
      await options.setup({tools:{restrict(){},guard(){},register(t){definitions.push(t);}},systemPrompt:{section(){}}},agent);
      return {agent,async dispose(){}};
    }},
    sessions:{async flush(){return true;}}
  };
  const driver={resume(){},pause(){},close(){},async call(){return {status:'ok'};}};
  const b=await createBridge(ctx,{stateDir:dir,mode:'mock',chats:[{id:'synthetic-group',title:'Synthetic Group',mode:'group'}]},{defineTool,driver});
  try{
    b.core.resume();await b.core.ingest({chatId:'synthetic-group',messages:[{id:'mock-1',text:'Synthetic test only'}]});
    const reply=definitions.find(t=>t.name==='wechat_reply');assert.ok(reply);
    assert.ok(!definitions.some(t=>t.name==='wechat_task'));
    const out=await reply.execute({text:'synthetic response'},{agent:actualAgent,callId:'synthetic-native-call',signal:new AbortController().signal});
    assert.equal(out.status,'ok');
  }finally{await b.core.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('cancelled while waiting in core queue never reaches driver',async()=>{
 const {WeChatCore}=await import('../src/core.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xq-cancel-'));let release;const gate=new Promise(r=>release=r);let sent=0;
 const driver={resume(){},pause(){},close(){},async call(){sent++;return {status:'ok'};}};
 const c=new WeChatCore({stateDir:dir,chats:[{id:'owner',title:'Synthetic Owner',mode:'private',owner:true}],driver,agents:{}});
 try{
   c.resume();const waiting=c.serial(()=>gate);
   const controller=new AbortController();const pending=c.send('owner',{text:'must never send',deliveryId:'cancelled'},{signal:controller.signal});
   controller.abort();release();await waiting;await assert.rejects(pending,/TOOL_CANCELLED/);assert.equal(sent,0);
 }finally{await c.close();fs.rmSync(dir,{recursive:true,force:true});}
});
