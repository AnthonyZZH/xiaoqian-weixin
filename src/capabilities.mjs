import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomicJson,readJson} from './features.mjs';

function invokeWorker(request,{python='python',workerPath,timeoutMs=20000,signal}={}){
  return new Promise((resolve,reject)=>{
    const script=workerPath||fileURLToPath(new URL('../tools/capability_worker.py',import.meta.url));
    const env={};for(const key of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP','USERPROFILE'])if(process.env[key])env[key]=process.env[key];
    env.PYTHONDONTWRITEBYTECODE='1';env.PYTHONIOENCODING='utf-8';
    const child=spawn(python,['-u','-B',script],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error)reject(error);else resolve(value);};
    const abort=()=>{child.kill();finish(new Error('CAPABILITY_CANCELLED'));};
    const timer=setTimeout(()=>{child.kill();finish(new Error('CAPABILITY_TIMEOUT'));},timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>256*1024){child.kill();finish(new Error('CAPABILITY_RESPONSE_TOO_LARGE'));}});
    child.stderr.resume();
    child.on('error',()=>finish(new Error('CAPABILITY_START_FAILED')));
    child.on('close',code=>{
      if(done)return;
      if(code!==0) return finish(new Error('CAPABILITY_PROCESS_FAILED'));
      let row;try{row=JSON.parse(output.trim());}catch{return finish(new Error('CAPABILITY_BAD_RESPONSE'));}
      if(row.ok!==true)return finish(new Error(row.code||'CAPABILITY_FAILED'));
      finish(null,row);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

/** Small optional tools run outside the serial UI process and never call DeepSeek API. */
export function createCapabilities({config={},media,generatedRoot,python='python',workerPath}={}){
  const result={};
  const drawQuota=chatId=>{
    const chat=config.chats?.find(c=>c.id===chatId);
    if(!chat)throw new Error('DRAW_CHAT_UNKNOWN');
    if(chat.owner)return;
    if(chat.drawEnabled!==true)throw new Error('DRAW_CHAT_DENIED');
    const limit=config.drawDailyLimit??3;
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('DRAW_QUOTA_INVALID');
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:config.timeZone||'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const file=path.join(generatedRoot,'draw-quota.json');
    const state=readJson(file,{version:1,used:{}});
    if(state.version!==1||!state.used||Array.isArray(state.used))throw new Error('DRAW_QUOTA_STATE_INVALID');
    const key=createHash('sha256').update(chatId).digest('hex');
    const row=state.used[key];const used=row?.day===day?row.count:0;
    if(!Number.isInteger(used)||used<0||used>=limit)throw new Error('DRAW_DAILY_LIMIT');
    state.used[key]={day,count:used+1};atomicJson(file,state);
  };
  if(config.searchEnabled===true)result.search=async({args,signal})=>{
    const query=args.query;
    if(typeof query!=='string'||!query.trim()||query.length>200)throw new Error('SEARCH_QUERY_INVALID');
    const answer=await invokeWorker({operation:'search',query},{python,workerPath,timeoutMs:20000,signal});
    if(!Array.isArray(answer.results)||answer.results.length>5)throw new Error('SEARCH_RESULT_INVALID');
    return answer.results.map(row=>({title:String(row.title||'').slice(0,500),
      url:String(row.url||'').slice(0,2000),snippet:String(row.snippet||'').slice(0,2000)}));
  };
  if(config.forge?.enabled===true)result.draw=async({chatId,args,signal})=>{
    if(!media?.importOriginal)throw new Error('MEDIA_UNAVAILABLE');
    const prompt=args.prompt;
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>4000)throw new Error('DRAW_PROMPT_INVALID');
    fs.mkdirSync(generatedRoot,{recursive:true});
    drawQuota(chatId);
    const output=path.join(generatedRoot,'draw-'+randomUUID()+'.png');
    const answer=await invokeWorker({operation:'draw',prompt,url:config.forge.url,
      model:config.forge.model,generatedRoot,output,timeout:600},
      {python,workerPath,timeoutMs:620000,signal});
    const row=await media.importOriginal(chatId,answer.path,{description:prompt.slice(0,1000),name:'Generated image'});
    await media.approve(row.media_id,{scope:chatId});
    return {status:'ready_to_send',mediaId:row.media_id,animated:false};
  };
  if(config.vision?.enabled===true&&config.vision.inputMode!=='native_attachment')result.describeImage=async({chatId,args,signal})=>{
    if(!media?.previewForVision)throw new Error('VISION_MEDIA_UNAVAILABLE');
    if(typeof args.id!=='string'||!/^m_[0-9a-f]{32}$/.test(args.id))throw new Error('VISION_MEDIA_ID_INVALID');
    const preview=await media.previewForVision(chatId,args.id);
    const answer=await invokeWorker({operation:'vision',url:config.vision.url,
      model:config.vision.model,imageBase64:preview.base64},
      {python,workerPath,timeoutMs:40000,signal});
    if(typeof answer.description!=='string'||!answer.description.trim())throw new Error('VISION_RESPONSE_INVALID');
    return {description:answer.description.slice(0,2000),sourceLabel:preview.label,animationFramesAnalyzed:false};
  };
  return result;
}
