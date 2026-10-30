import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root=process.env.XQ_NATIVE_PACKAGE_ROOT||'C:/xiaoqian/app/dsh/node_modules/@deepseek-ai/';
const load=async n=>import(pathToFileURL(root+n+'/lib/index.js').href);
const {Context}=await load('cordis');const {LlmAdapter}=await load('dsh-llm');
const ctx=new Context(),fibers=[];let bridge;
const errors=[];ctx.on('agent/error',(...args)=>errors.push(args.map(x=>({keys:Object.keys(x||{}),code:x?.code,message:x?.message,error:x?.error?.stack,failure:x?.failure,reason:x?.reason}))));
class Offline extends LlmAdapter{
 async *stream(){yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'Synthetic offline result'};yield {type:'block-end',index:0,block:{type:'text',text:'Synthetic offline result'}};yield {type:'finish',reason:{kind:'stop'}};}
}
try{
 for(const n of ['dsh-system-prompt','dsh-session','dsh-agent','dsh-llm','dsh-tools','dsh-session-projection','dsh-agent-loop'])fibers.push(ctx.plugin((await load(n)).default,{}));
 fibers.push(ctx.plugin(await load('dsh-session-persistence-jsonl'),{root:path.join(process.argv[3],'sessions'),compression:'none'}));
 fibers.push(ctx.plugin({inject:['llm'],apply(c){c.llm.registerAdapter(['offline'],new Offline());}},{}));
 for(const f of fibers)await f.await();
 const {defineTool}=await load('dsh-tools');
 const plugin=await import('../../src/index.mjs');const pluginFiber=ctx.plugin(plugin,{enabled:true,startPaused:true,stateDir:path.join(process.argv[3],'bridge'),mode:'mock',nativePackageRoot:root,model:{provider:'offline',model:'offline'},chats:[{id:'test',title:'Synthetic Only',mode:'group',owner:false}]});fibers.push(pluginFiber);await pluginFiber.await();bridge=ctx.xiaoqianBridge;assert.ok(bridge,'native plugin activation must expose bridge');
 bridge.core.resume();await bridge.core.ingest({chatId:'test',messages:[{id:process.argv[2],text:'Synthetic input '+process.argv[2]}]});
 const h=bridge.core.handles.get('test');await h.agent.whenIdle();assert.equal(await ctx.sessions.flush(h.agent.session),true);
 const messages=h.agent.session.deriveMessages();const users=messages.filter(m=>m.role==='user');
 assert.ok(users.length>=(process.argv[2]==='resume'?2:1));
 assert.equal(errors.length,0,JSON.stringify(errors));
 assert.ok(messages.some(m=>m.role==='assistant'&&m.content.some(b=>b.type==='text'&&b.text==='Synthetic offline result')));
 console.log(JSON.stringify({mode:process.argv[2],sessionId:bridge.core.status('test').sessionId,users:users.length,errors,offline:true}));
}finally{await bridge?.core.close();for(const f of fibers.reverse())await f.dispose();}
