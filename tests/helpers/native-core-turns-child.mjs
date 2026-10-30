import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root=process.env.XQ_NATIVE_PACKAGE_ROOT||'C:/xiaoqian/app/dsh/node_modules/@deepseek-ai/';
const load=async n=>import(pathToFileURL(root+n+'/lib/index.js').href);
const {Context}=await load('cordis'),{LlmAdapter}=await load('dsh-llm');
const ctx=new Context(),fibers=[],errors=[],requests=[];let bridge,calls=0,release;
const gate=new Promise(r=>release=r),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'xq-native-turn-'));
ctx.on('agent/error',x=>errors.push(String(x?.error?.message||x?.message||'agent-error')));
class Offline extends LlmAdapter{
 async *stream(request){
  const n=++calls;requests.push(JSON.stringify(request));if(n===1)await gate;
  if(n%2===1){const block={type:'tool-call',id:'offline-'+n,name:'wechat_reply',arguments:JSON.stringify({text:'synthetic reply '+n})};
   yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'tool-call-delta',index:0,id:block.id,name:block.name,argumentsDelta:block.arguments};yield{type:'block-end',index:0,block};yield{type:'finish',reason:{kind:'tool-calls'}};
  }else{yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:'done'};yield{type:'block-end',index:0,block:{type:'text',text:'done'}};yield{type:'finish',reason:{kind:'stop'}};}
 }
}
try{
 for(const n of ['dsh-system-prompt','dsh-session','dsh-agent','dsh-llm','dsh-tools','dsh-session-projection','dsh-agent-loop'])fibers.push(ctx.plugin((await load(n)).default,{}));
 fibers.push(ctx.plugin(await load('dsh-session-persistence-jsonl'),{root:path.join(scratch,'sessions'),compression:'none'}));
 fibers.push(ctx.plugin({inject:['llm'],apply(c){c.llm.registerAdapter(['offline'],new Offline());}},{}));
 for(const f of fibers)await f.await();
 const {defineTool}=await load('dsh-tools');const {createBridge}=await import('../../src/index.mjs');
 const sends=[],driver={maxChars:1000,resume(){},pause(){},async close(){},async call(op,args){assert.equal(op,'send_text');sends.push(args);return{status:sends.length===1?'unknown':'ok'}}};
 bridge=await createBridge(ctx,{stateDir:path.join(scratch,'bridge'),mode:'mock',model:{provider:'offline',model:'offline'},chats:[{id:'owner',title:'SYNTHETIC OWNER',mode:'private',owner:true}]},{driver,defineTool});
 bridge.features.setPersona('owner','SYNTHETIC_OLD_PERSONA');bridge.core.resume();
 await bridge.core.ingest({chatId:'owner',messages:[{id:'A',text:'synthetic A'},{id:'B',text:'synthetic B'}]});
 bridge.features.setPersona('owner','SYNTHETIC_NEW_PERSONA');release();
 const agent=bridge.core.handles.get('owner').agent;let timer;
 try{await Promise.race([agent.whenIdle(),new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('NATIVE_TIMEOUT')),8000))]);}finally{clearTimeout(timer);}
 await ctx.sessions.flush(agent.session);
 assert.deepEqual(errors,[]);assert.equal(sends.length,2);assert.equal(calls,4);
 const c=bridge.core.state('owner');assert.deepEqual(Object.values(c.deliveries).map(x=>x.status),['unknown','ok']);
 const grants=Object.values(c.replyPermits);assert.equal(grants.length,2);assert.equal(grants[0].remaining,0);assert.equal(grants[1].remaining,0);
 assert.ok(requests[2].includes('SYNTHETIC_NEW_PERSONA'),'next native request must read changed persona without Agent replacement');
 console.log(JSON.stringify({nativeVersion:'0.2.1-rc.4',offline:true,modelRequests:calls,actualToolDispatches:sends.length,deliveries:Object.values(c.deliveries).map(x=>x.status),personaDynamic:true,errors}));
}finally{release();await bridge?.core.close();for(const f of fibers.reverse())await f.dispose();fs.rmSync(scratch,{recursive:true,force:true});}
