import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
const fail=code=>Object.assign(Error(code),{code});
export function runImportWorker({python,script,sitePackages,mediaRoot,collection,request,signal,timeoutMs=20000}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(fail('IMPORT_CANCELLED'));return;}
  const env={};for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
  const child=spawn(python,['-I','-S','-u',script,'--site-packages',sitePackages,'--media-root',mediaRoot,'--collection',collection],{env,cwd:path.dirname(script),windowsHide:true,stdio:['pipe','pipe','pipe']});
  let done=false,reason=null,size=0,killTimer;const chunks=[];
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const stop=code=>{if(done||reason)return;reason=code;child.kill();killTimer=setTimeout(()=>finish(fail('IMPORT_TERMINATION_UNCONFIRMED')),1000);};
  const abort=()=>stop('IMPORT_CANCELLED');const timer=setTimeout(()=>stop('IMPORT_TIMEOUT'),timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});child.stderr.resume();child.stdin.on('error',()=>{});
  child.stdout.on('data',b=>{size+=b.length;if(size>1024*1024)stop('IMPORT_OUTPUT_LIMIT');else chunks.push(b);});
  child.once('error',()=>finish(fail('IMPORT_PROCESS_FAILED')));
  child.once('close',code=>{if(reason){finish(fail(reason));return;}if(code!==0){finish(fail('IMPORT_WORKER_FAILED'));return;}try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{finish(fail('IMPORT_RESPONSE_INVALID'));}});
  child.stdin.end(JSON.stringify(request));
 });
}
export function createOwnerMediaImport({isCurrentOwner,python,sitePackages,mediaRoot,operationRoot}){
 fs.mkdirSync(operationRoot,{recursive:true});
 const script=fileURLToPath(new URL('../tools/remote-image-worker.py',import.meta.url));
 return {available:()=>['owner_media_import_url'],bind({agent,bindingId,chatId}){
  const controller=new AbortController(),collection='c_'+crypto.createHash('sha256').update(chatId).digest('hex').slice(0,32);
  const auth=async exec=>{if(controller.signal.aborted||exec?.agent!==agent||exec.signal?.aborted||!await isCurrentOwner({agent,bindingId}))throw fail('OWNER_ONLY');if(typeof exec.callId!=='string'||!exec.callId)throw fail('CALL_ID_REQUIRED');};
  const execute=async(args,exec)=>{
   await auth(exec);
   if(!args||Object.keys(args).some(k=>!['url','description','tags'].includes(k))||typeof args.url!=='string'||args.url.length>2000||typeof (args.description??'')!=='string'||(args.description||'').length>1000||!Array.isArray(args.tags||[])||(args.tags||[]).length>20||(args.tags||[]).some(t=>typeof t!=='string'||t.length>80))throw fail('IMPORT_ARGUMENT_INVALID');
   const key=crypto.createHash('sha256').update(bindingId+'\0'+exec.callId).digest('hex'),file=path.join(operationRoot,key+'.json');
   if(fs.existsSync(file)){const prior=JSON.parse(fs.readFileSync(file,'utf8'));return prior.result?{...prior.result,cached:true}:{ok:false,code:'IMPORT_PRIOR_OUTCOME_UNKNOWN',outcome:'unknown',cached:true};}
   fs.writeFileSync(file,JSON.stringify({state:'pending',at:new Date().toISOString()}),{flag:'wx'});
   const signal=exec.signal?AbortSignal.any([exec.signal,controller.signal]):controller.signal;
   let result;try{result=await runImportWorker({python,script,sitePackages,mediaRoot,collection,request:args,signal});await auth(exec);}catch(error){result={ok:false,code:error.code||'IMPORT_FAILED',outcome:'unknown',instruction:'Query the pending catalog; do not automatically retry this operation.'};}
   const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify({state:result.ok?'done':'unknown',at:new Date().toISOString(),result}));fs.renameSync(tmp,file);
   await auth(exec);return result;
  };
  return {execute,revoke:()=>controller.abort(),register(ctx,defineTool){ctx.tools.register(defineTool({name:'owner_media_import_url',description:'主人专属：从公开直链下载原始图片或动图到当前表情库，新资源待审核，不自动发送；超时或未知结果先查询待审库，不自动重试。网页/登录/付费墙不支持。',parameters:{url:{type:'string',required:true},description:{type:'string'},tags:{type:'array',items:{type:'string'}}},output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute}));}};
 }};
}
