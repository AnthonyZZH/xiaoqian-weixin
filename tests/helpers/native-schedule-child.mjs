import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

const root=process.env.XQ_NATIVE_PACKAGE_ROOT||'C:/xiaoqian/app/dsh/node_modules/@deepseek-ai/';
const state=path.resolve(process.argv[2]);fs.mkdirSync(state,{recursive:true});
const mode=process.argv[3]||'create';
const load=async n=>import(pathToFileURL(root+n+'/lib/index.js').href);
const {Context}=await load('cordis');
const {LlmAdapter}=await load('dsh-llm');
class Offline extends LlmAdapter{async *stream(){modelCalls++;yield {type:'finish',reason:{kind:'stop'}};}}
const ctx=new Context(),fibers=[];
let modelCalls=0;
async function mount(name,config={},selector=null){
  const m=await load(name),p=selector?m[selector]:(m.default||m);
  const f=ctx.plugin(p,config);fibers.push(f);await f.await();
  console.log(JSON.stringify({mounted:name,services:['agents','sessions','storage','storageDomain','sessionPersistence','sessionController','schedule','workspaceRegistry','attachments','fileUploads','remoteAccess','typert','agentDefaultModel','sessionQuery'].filter(k=>ctx[k])}));
}
try{
  await mount('dsh-storage');
  await mount('dsh-storage-json',{root:path.join(state,'storage')});
  await mount('dsh-storage-domain',{backend:'json'});
  for(const n of ['dsh-system-prompt','dsh-session','dsh-agent','dsh-llm','dsh-tools','dsh-session-projection','dsh-agent-loop'])await mount(n);
  const offlineFiber=ctx.plugin({inject:['llm'],apply(c){c.llm.registerAdapter(['offline'],new Offline());}},{});
  fibers.push(offlineFiber);await offlineFiber.await();
  await mount('dsh-session-persistence-jsonl',{root:path.join(state,'sessions'),compression:'none'});
  await mount('dsh-agent-default-model',{provider:'offline',model:'offline'});
  await mount('dsh-attachment-local',{root:path.join(state,'attachments')});
  await mount('dsh-fs');
  await mount('dsh-api-remote-access');
  await mount('dsh-typert-registry');
  await mount('dsh-workspace');
  await mount('dsh-session-query-sqlite',{path:path.join(state,'query.db'),openAt:'never'});
  const uploads=ctx.plugin({name:'offline-file-uploads',apply(c){c.provide('fileUploads',{resolve(){throw new Error('offline_upload_disabled');},registerAgentResolver(){return ()=>{};}});}},{});
  fibers.push(uploads);await uploads.await();
  await mount('dsh-api-session-controller');
  await mount('dsh-schedule');
  console.log(JSON.stringify({scheduleMethods:Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.schedule))}));
  const inserted=[],presteps=[];
  ctx.on('agent/inbox/inserted',event=>{
    if(event?.message?.source?.kind==='schedule')inserted.push(event.message);
  });
  ctx.on('agent/pre-step',(event,next)=>{
    if(event?.messages?.some(message=>message?.source?.kind==='schedule'))presteps.push(event);
    // The probe verifies admission and storage. It never calls a model.
    return Promise.resolve({kind:'reject'});
  });
  if(mode==='create'){
    const sid='sched-'+randomUUID();
    const h=await ctx.agents.create({sessionId:sid,agentOptions:{provider:'offline',model:'offline'}});
    const flush=await ctx.sessions.flush(h.agent.session);assert.equal(flush,true);
    const at=new Date(Date.now()+3600_000).toISOString();
    const task=await ctx.schedule.create(sid,{title:'Synthetic wake',prompt:'Synthetic no-send reminder',at});
    const catalog=await ctx.schedule.catalog();
    assert.ok(catalog.some(row=>row.id===task.id&&row.sessionId===sid&&row.status==='active'));
    fs.writeFileSync(path.join(state,'probe.json'),JSON.stringify({sid,taskId:task.id}));
    console.log(JSON.stringify({mode,created:true,flush,taskId:task.id,sessionId:sid}));
    await h.dispose();
  }else if(mode==='verify'){
    const saved=JSON.parse(fs.readFileSync(path.join(state,'probe.json'),'utf8'));
    const catalog=await ctx.schedule.catalog();
    assert.ok(catalog.some(row=>row.id===saved.taskId&&row.sessionId===saved.sid&&row.status==='active'));
    console.log(JSON.stringify({mode,restored:true,taskId:saved.taskId,sessionId:saved.sid}));
  }else if(mode==='due'){
    const sid='sched-'+randomUUID();
    const h=await ctx.agents.create({sessionId:sid,agentOptions:{provider:'offline',model:'offline'}});
    assert.equal(await ctx.sessions.flush(h.agent.session),true);
    const task=await ctx.schedule.create(sid,{title:'Synthetic due',prompt:'Synthetic no-model reminder',at:new Date(Date.now()+1200).toISOString()});
    const deadline=Date.now()+7000;
    let row;
    while(Date.now()<deadline){
      row=(await ctx.schedule.catalog()).find(item=>item.id===task.id);
      if(row?.status==='inactive'&&inserted.length)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(row?.status,'inactive');
    assert.equal(inserted.length,1);
    assert.equal(inserted[0].source.kind,'schedule');
    assert.ok(inserted[0].content.some(part=>part.type==='text'&&part.text.includes(task.id)));
    assert.equal(presteps.length,1);
    assert.equal(modelCalls,0);
    console.log(JSON.stringify({mode,delivered:true,taskId:task.id,sessionId:sid,producer:inserted[0].source.kind,presteps:presteps.length,modelCalls}));
    await h.dispose();
  }else throw new Error('invalid_probe_mode');
}catch(e){console.error(JSON.stringify({error:String(e),stack:e?.stack?.slice(0,2500)}));process.exitCode=1;}
finally{for(const f of fibers.reverse())try{await f.dispose();}catch(e){console.error(JSON.stringify({dispose:String(e)}));}}
