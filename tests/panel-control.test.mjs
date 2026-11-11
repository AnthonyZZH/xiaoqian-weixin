import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {applySettings,normalizeSettings,DEFAULT_SETTINGS} from '../src/panel-settings.mjs';
import {generateImage} from '../src/draw-api.mjs';
import {createCapabilities} from '../src/capabilities.mjs';
import {createPanelControl} from '../src/panel-control.mjs';
import {createPanel} from '../vendor/task-engine/panel.mjs';
import {Store} from '../vendor/task-engine/store.mjs';
import {Engine} from '../vendor/task-engine/engine.mjs';

const tmp=()=>fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'xq-panel-'));
const PNG=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),Buffer.alloc(80,7)]);
const basePatch=()=>[{insert:[{id:'xiaoqian-wechat-native',name:'file:///x/index.mjs',config:{model:{provider:'deepseek-official',model:'deepseek-flash'},balance:{enabled:true},billingCollector:{enabled:true,root:'C:/b'},chats:[]}},{id:'other',name:'x'}]}];
async function serve(handler){const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(r=>server.close(r))};}
const body=req=>new Promise(r=>{let s='';req.on('data',c=>s+=c);req.on('end',()=>r(s?JSON.parse(s):{}));});

test('settings map onto the host patch: DeepSeek by default, any OpenAI-compatible endpoint when custom',()=>{
 const source=basePatch(),official=applySettings(source,DEFAULT_SETTINGS);
 assert.deepEqual(source,basePatch(),'input is not modified');
 assert.deepEqual(official.find(e=>e.id==='agent-default-model').config,{provider:'deepseek-official',model:'deepseek-flash',reasoningEffort:'off'});
 assert.equal(official.some(e=>e.id==='llm-pi-ai'),false);
 const bridge=p=>p.flatMap(e=>e.insert||[]).find(e=>e.id==='xiaoqian-wechat-native').config;
 assert.equal(bridge(official).balance.enabled,true);assert.equal(bridge(official).draw,undefined);
 const custom=applySettings(official,{chat:{mode:'custom',baseURL:'http://127.0.0.1:11434/v1/',model:'qwen3:14b',contextWindow:32000},draw:{mode:'openai',baseURL:'https://img.example/v1',model:'img-1',size:'768x768'}});
 const provider=custom.find(e=>e.id==='llm-pi-ai').config.providers['xq-custom'];
 assert.deepEqual({api:provider.api,baseURL:provider.baseURL,apiKeyEnv:provider.apiKeyEnv,models:provider.models},{api:'openai-completions',baseURL:'http://127.0.0.1:11434/v1',apiKeyEnv:'XQ_CUSTOM_LLM_API_KEY',models:[{id:'qwen3:14b',name:'qwen3:14b',contextWindow:32000}]});
 assert.deepEqual(bridge(custom).model,{provider:'xq-custom',model:'qwen3:14b'});
 assert.equal(custom.find(e=>e.id==='agent-default-model').config.provider,'xq-custom');
 assert.equal(bridge(custom).balance.enabled,false);assert.equal(bridge(custom).billingCollector.enabled,false);assert.equal(bridge(custom).billingCollector.root,'C:/b');
 assert.deepEqual(bridge(custom).draw,{enabled:true,kind:'openai',baseURL:'https://img.example/v1',model:'img-1',size:'768x768',apiKeyEnv:'XQ_DRAW_API_KEY'});
 assert.equal(JSON.stringify(custom).includes('sk-'),false);
 const back=applySettings(custom,DEFAULT_SETTINGS);assert.equal(back.some(e=>e.id==='llm-pi-ai'),false);assert.equal(bridge(back).balance.enabled,true);assert.equal(bridge(back).draw,undefined);
 for(const bad of [{chat:{mode:'custom',baseURL:'ftp://x',model:'m'}},{chat:{mode:'custom',baseURL:'http://u:p@h/v1',model:'m'}},{chat:{mode:'custom',baseURL:'http://h/v1',model:''}},
  {chat:{mode:'custom',baseURL:'http://h/v1',model:'m',contextWindow:10}},{draw:{mode:'openai',baseURL:'http://h/v1',model:''}},{draw:{mode:'sdwebui',baseURL:'http://h',size:'big'}},{chat:{mode:'other'}}])
  assert.throws(()=>normalizeSettings(bad),e=>e.code==='SETTINGS_INVALID',JSON.stringify(bad));
});

test('image generation speaks OpenAI-compatible and SD WebUI, sends the key only as a header, and rejects non-images',async t=>{
 const seen=[];
 const api=await serve(async(req,res)=>{const b=await body(req);seen.push({url:req.url,auth:req.headers.authorization,b});res.setHeader('content-type','application/json');
  if(req.url==='/v1/images/generations')return res.end(JSON.stringify(b.prompt==='by-url'?{data:[{url:api.url+'/file.png'}]}:b.prompt==='not-image'?{data:[{b64_json:Buffer.alloc(100,65).toString('base64')}]}:{data:[{b64_json:PNG.toString('base64')}]}));
  if(req.url==='/file.png'){res.setHeader('content-type','image/png');return res.end(PNG);}
  if(req.url==='/sdapi/v1/txt2img')return res.end(JSON.stringify({images:[PNG.toString('base64')]}));
  res.statusCode=500;res.end('{}');});
 t.after(api.close);
 const env={K:'secret-key'},openai={kind:'openai',baseURL:api.url+'/v1',model:'img-1',size:'512x768',apiKeyEnv:'K'};
 const a=await generateImage(openai,'a cat',{env});assert.equal(a.extension,'png');assert.ok(a.bytes.equals(PNG));
 assert.deepEqual(seen[0],{url:'/v1/images/generations',auth:'Bearer secret-key',b:{model:'img-1',prompt:'a cat',size:'512x768',n:1}});
 assert.ok((await generateImage(openai,'by-url',{env})).bytes.equals(PNG));
 await assert.rejects(generateImage(openai,'not-image',{env}),/DRAW_NOT_AN_IMAGE/);
 const sd=await generateImage({kind:'sdwebui',baseURL:api.url,model:'',size:'640x512'},'a dog',{env:{}});assert.ok(sd.bytes.equals(PNG));
 const call=seen.find(s=>s.url==='/sdapi/v1/txt2img');assert.equal(call.auth,undefined);assert.deepEqual([call.b.width,call.b.height,call.b.prompt],[640,512,'a dog']);
 await assert.rejects(generateImage({...openai,baseURL:api.url+'/missing'},'x',{env}),/DRAW_HTTP_500/);
 await assert.rejects(generateImage({...openai,baseURL:'http://127.0.0.1:9'},'x',{env}),/DRAW_ENDPOINT_UNREACHABLE/);
 // Through the bridge capability: the picture is imported into the chat's media library and approved for sending.
 const root=tmp(),imported=[];t.after(()=>fs.rmSync(root,{recursive:true,force:true}));process.env.XQ_TEST_DRAW_KEY='secret-key';
 const caps=createCapabilities({config:{chats:[{id:'owner',owner:true}],draw:{enabled:true,kind:'openai',baseURL:api.url+'/v1',model:'img-1',size:'512x512',apiKeyEnv:'XQ_TEST_DRAW_KEY'}},generatedRoot:path.join(root,'generated'),
  media:{importOriginal:async(chatId,file,meta)=>{imported.push({chatId,size:fs.statSync(file).size,meta});return {media_id:'m_1'};},approve:async()=>{}}});
 assert.deepEqual(await caps.draw({chatId:'owner',args:{prompt:'a cat'}}),{status:'ready_to_send',mediaId:'m_1',animated:false});
 assert.equal(imported[0].size,PNG.length);assert.equal(imported[0].meta.description,'a cat');
 await assert.rejects(caps.draw({chatId:'owner',args:{prompt:''}}),/DRAW_PROMPT_INVALID/);
});

test('control panel: token and header gate every action; settings are saved with a fallback copy; secrets never come back',async t=>{
 const root=tmp(),store=new Store(path.join(root,'tasks'));
 const engine=new Engine({store,tools:new Map([['wait',{name:'wait',run:(a,ctx)=>new Promise((_,rej)=>ctx.signal.addEventListener('abort',()=>rej(ctx.signal.reason)))}]]),config:{mode:'live',lock:false,finalTool:null,maxParallelTasks:3,maxParallelStepsPerTask:3,stepTimeoutMs:60000}});
 engine.start();
 const files={settingsFile:path.join(root,'settings.json'),secretsFile:path.join(root,'secrets.json'),patchFile:path.join(root,'patch.json'),restartScript:path.join(root,'restart.ps1')};
 fs.writeFileSync(files.patchFile,JSON.stringify(basePatch()));
 fs.mkdirSync(path.join(root,'driver'));fs.writeFileSync(path.join(root,'driver','read-outcomes-node.jsonl'),JSON.stringify({phase:'terminal',at:'2026-01-01T00:00:00Z',outcome:'success',code:'READ'})+'\n');
 fs.writeFileSync(path.join(root,'loop-errors.log'),'2026-01-01 SOMETHING_FAILED\n');
 const core={store:{data:{paused:false}},model:{provider:'deepseek-official',model:'deepseek-flash'},capabilities:{},pause(){this.store.data.paused=true;},resume(){this.store.data.paused=false;}};
 const spawned=[],probes=[];
 const control=createPanelControl({getCore:()=>core,engine,stateDir:root,options:{...files,secretsWritable:true},env:{XQ_DEEPSEEK_API_KEY:'sk-machine-level-key-000000'},
  spawnImpl:(exe,args)=>{spawned.push([exe,...args]);return {unref(){}};},fetchImpl:async(url,init)=>{probes.push([url,init.headers.authorization]);return {ok:!url.includes('bad'),status:url.includes('bad')?401:200};}});
 const token='t'.repeat(32),panel=createPanel({engine,store,token,control,port:0});await once(panel.server,'listening');
 t.after(async()=>{await panel.close();engine.stop();store.close();fs.rmSync(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+panel.server.address().port+'/'+token+'/';
 const post=(name,data,headers={'content-type':'application/json','x-xq-panel':'1'},prefix=base)=>fetch(prefix+'api/action/'+name,{method:'POST',headers,body:JSON.stringify(data||{})});
 assert.equal((await post('bridge/pause',{},{'content-type':'application/json'})).status,404,'no panel header');
 assert.equal((await post('bridge/pause',{},{'content-type':'text/plain','x-xq-panel':'1'})).status,404,'not JSON');
 assert.equal((await post('bridge/pause',{},undefined,base.replace(token,'x'.repeat(32)))).status,404,'wrong token');
 assert.equal(core.store.data.paused,false);
 assert.deepEqual(await (await post('bridge/pause')).json(),{ok:true,result:{paused:true}});assert.equal(core.store.data.paused,true);
 await post('bridge/resume');assert.equal(core.store.data.paused,false);
 const unknown=await post('nope/nope');assert.equal(unknown.status,400);assert.equal((await unknown.json()).code,'ACTION_UNKNOWN');
 const task=engine.submit({title:'T',steps:[{id:'s1',title:'wait',tool:'wait'}]});
 assert.equal((await (await post('task/cancel',{id:task.id})).json()).result.status,'cancelled');
 assert.equal((await (await post('task/retry',{id:task.id})).json()).result.status,'running');
 let state=await (await fetch(base+'api/state')).json();
 assert.equal(state.control,true);assert.equal(state.status.lastRead.outcome,'success');assert.deepEqual(state.status.errors,['2026-01-01 SOMETHING_FAILED']);assert.deepEqual(state.status.can,{configure:true,restart:true,setKeys:true});
 assert.deepEqual(state.config.secrets,{XQ_DEEPSEEK_API_KEY:true,XQ_CUSTOM_LLM_API_KEY:false,XQ_DRAW_API_KEY:false});assert.equal(state.config.settings.chat.mode,'deepseek');
 const settings={chat:{mode:'custom',baseURL:'http://127.0.0.1:11434/v1',model:'local-model',contextWindow:32000},draw:{mode:'sdwebui',baseURL:'http://127.0.0.1:7860',size:'512x512'}};
 const tested=(await (await post('settings/test',{settings,secrets:{XQ_CUSTOM_LLM_API_KEY:'typed-key'}})).json()).result;
 assert.deepEqual(tested,{chat:{ok:true,status:200},draw:{ok:true,status:200}});assert.deepEqual(probes,[['http://127.0.0.1:11434/v1/models','Bearer typed-key'],['http://127.0.0.1:7860/sdapi/v1/sd-models',undefined]]);
 assert.equal(fs.existsSync(files.settingsFile),false,'testing saves nothing');
 const invalid=await post('settings/save',{settings:{chat:{mode:'custom',baseURL:'nope',model:'m'}}});assert.equal(invalid.status,400);assert.equal(spawned.length,0);
 const saved=await (await post('settings/save',{settings,secrets:{XQ_CUSTOM_LLM_API_KEY:'typed-key-123'}})).json();
 assert.equal(saved.ok,true);assert.equal(saved.result.restarting,true);assert.equal(JSON.stringify(saved).includes('typed-key-123'),false);
 assert.deepEqual(JSON.parse(fs.readFileSync(files.secretsFile)),{XQ_CUSTOM_LLM_API_KEY:'typed-key-123'});
 assert.deepEqual(JSON.parse(fs.readFileSync(files.patchFile+'.prev')),basePatch(),'previous configuration kept for automatic fallback');
 const patch=JSON.parse(fs.readFileSync(files.patchFile));assert.equal(patch.find(e=>e.id==='llm-pi-ai').config.providers['xq-custom'].baseURL,'http://127.0.0.1:11434/v1');
 assert.equal(fs.readFileSync(files.patchFile,'utf8').includes('typed-key-123'),false,'keys never enter the host configuration');
 assert.deepEqual(spawned,[['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',files.restartScript]]);
 state=await (await fetch(base+'api/state')).json();
 assert.equal(state.config.settings.chat.model,'local-model');assert.equal(state.config.secrets.XQ_CUSTOM_LLM_API_KEY,true);assert.equal(JSON.stringify(state).includes('typed-key'),false);
 // A deployment without file paths can still pause and manage tasks, but not reconfigure or restart.
 const limited=createPanelControl({getCore:()=>core,engine,stateDir:root,options:{}});
 assert.equal(limited.settings(),null);assert.deepEqual(limited.status().can,{configure:false,restart:false,setKeys:false});
 await assert.rejects(limited.act('settings/save',{settings}),e=>e.code==='SETTINGS_UNAVAILABLE');await assert.rejects(limited.act('host/restart'),e=>e.code==='RESTART_UNAVAILABLE');
});

test('by default keys are read-only: they come from the machine, and the panel can neither set nor read them',async t=>{
 const root=tmp(),store=new Store(path.join(root,'tasks')),engine=new Engine({store,tools:new Map(),config:{mode:'live',lock:false,maxParallelTasks:3,maxParallelStepsPerTask:3,stepTimeoutMs:60000}});
 t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
 const files={settingsFile:path.join(root,'settings.json'),patchFile:path.join(root,'patch.json'),restartScript:path.join(root,'restart.ps1')};fs.writeFileSync(files.patchFile,JSON.stringify(basePatch()));
 const core={store:{data:{paused:false}},model:{},capabilities:{}},seen=[],spawned=[];
 const control=createPanelControl({getCore:()=>core,engine,stateDir:root,options:files,env:{XQ_DEEPSEEK_API_KEY:'sk-machine-level-key-000000',XQ_CUSTOM_LLM_API_KEY:'machine-custom-key'},
  spawnImpl:(...a)=>{spawned.push(a);return {unref(){}};},fetchImpl:async(url,init)=>{seen.push(init.headers.authorization);return {ok:true,status:200};}});
 const settings={chat:{mode:'custom',baseURL:'http://127.0.0.1:11434/v1',model:'local-model',contextWindow:32000},draw:{mode:'off'}};
 assert.deepEqual(control.status().can,{configure:true,restart:true,setKeys:false});
 assert.deepEqual(control.settings().secrets,{XQ_DEEPSEEK_API_KEY:true,XQ_CUSTOM_LLM_API_KEY:true,XQ_DRAW_API_KEY:false});
 await assert.rejects(control.act('settings/save',{settings,secrets:{XQ_CUSTOM_LLM_API_KEY:'typed-in-panel'}}),e=>e.code==='SECRETS_READ_ONLY');
 assert.equal(fs.existsSync(files.settingsFile),false,'nothing is saved when a key is sent to a read-only panel');assert.equal(spawned.length,0);
 await control.act('settings/test',{settings,secrets:{XQ_CUSTOM_LLM_API_KEY:'typed-in-panel'},target:'chat'});
 assert.deepEqual(seen,['Bearer machine-custom-key'],'a typed key is ignored; the machine key is used');
 const done=await control.act('settings/save',{settings});
 assert.equal(done.saved,true);assert.equal(done.restarting,true);assert.equal(JSON.parse(fs.readFileSync(files.settingsFile)).chat.model,'local-model');
 assert.equal(fs.readdirSync(root).some(f=>f.includes('secret')),false,'no key file is ever written');
 assert.equal(JSON.stringify(control.settings()).includes('machine-custom-key'),false);
});
