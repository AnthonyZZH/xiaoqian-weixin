import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';

const MAX=5*1024*1024;
const check=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const relative=value=>typeof value==='string'&&value.length>0&&value.length<=1000&&!/^[\\/]|[:\x00-\x1f<>"|?*]/.test(value)&&
 value.split(/[\\/]/).every(p=>p&&p!=='.'&&p!=='..'&&!/[. ]$/.test(p)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));

export function invokeSavedFileWorker(request,{python='python',timeoutMs=5000,signal}={}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(Error('SAVED_FILE_CANCELLED'));return;}
  const env={PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8'};
  for(const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  const child=spawn(python,['-B',fileURLToPath(new URL('./saved_file_worker.py',import.meta.url))],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let done=false,size=0;const chunks=[];
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const stop=code=>{child.kill();finish(Error(code));};
  const abort=()=>stop('SAVED_FILE_CANCELLED');
  const timer=setTimeout(()=>stop('SAVED_FILE_TIMEOUT'),timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});
  child.stderr.resume();child.stdin.on('error',()=>stop('SAVED_FILE_WORKER_FAILED'));
  child.stdout.on('data',part=>{size+=part.length;if(size>Math.ceil(MAX*4/3)+8192)stop('SAVED_FILE_OUTPUT_LIMIT');else chunks.push(part);});
  child.on('error',()=>finish(Error('SAVED_FILE_WORKER_UNAVAILABLE')));
  child.on('close',code=>{
   if(done)return;
   if(code!==0){finish(Error('SAVED_FILE_WORKER_FAILED'));return;}
   try{const reply=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(reply.ok!==true)throw Error(/^[A-Z0-9_]{1,80}$/.test(reply.code)?reply.code:'SAVED_FILE_WORKER_FAILED');finish(null,reply.result);}catch(e){finish(e);}
  });
  child.stdin.end(JSON.stringify(request));
 });
}

// Trusted native bindings only. No glob, basename lookup, download, UI or model path.
export function createSavedFileBroker({root,accountId,ownerBindingId,ownerChatId,resolveBoundFile,verifyBinding,isOwnerActive,
 worker=invokeSavedFileWorker,python='python',timeoutMs=5000}={}){
 check(path.isAbsolute(root||'')&&!/^[\\/]{2}/.test(root),'SAVED_FILE_ROOT_REQUIRED');
 const parent=path.dirname(root),accountRoot=path.dirname(parent);
 const legacy=path.basename(root).toLowerCase()==='file'&&path.basename(parent).toLowerCase()==='filestorage';
 const current=path.basename(root).toLowerCase()==='file'&&path.basename(parent).toLowerCase()==='msg'&&
   path.basename(path.dirname(accountRoot)).toLowerCase()==='xwechat_files';
 check(legacy||current,'SAVED_FILE_ROOT_REQUIRED');
 check(typeof accountId==='string'&&accountId.length>0&&typeof ownerBindingId==='string'&&ownerBindingId.length>0&&typeof ownerChatId==='string'&&ownerChatId.length>0,'SAVED_FILE_SCOPE_REQUIRED');
 check(path.basename(accountRoot)===accountId,'SAVED_FILE_ACCOUNT_ROOT_MISMATCH');
 check(typeof resolveBoundFile==='function'&&typeof verifyBinding==='function'&&typeof isOwnerActive==='function','SAVED_FILE_BINDING_REQUIRED');
 check(Number.isInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=15000,'SAVED_FILE_TIMEOUT_INVALID');
 const base=path.resolve(root),running=new Map();
 async function run(card,scope){
  check(scope.ownerBindingId===ownerBindingId&&scope.ownerChatId===ownerChatId&&await isOwnerActive(scope)===true,'OWNER_ATTACHMENT_REQUIRED');
  check(/^[a-f0-9]{64}$/.test(card?.sourceMessageId)&&typeof card.displayName==='string'&&/^[^\\/:\x00-\x1f]{1,196}\.(txt|docx|pdf)$/i.test(card.displayName),'SAVED_FILE_CARD_INVALID');
  check(Number.isInteger(scope.maxBytes)&&scope.maxBytes>0&&scope.maxBytes<=MAX,'SAVED_FILE_LIMIT_INVALID');
  const receipt=await resolveBoundFile(card,scope);
  check(receipt,'SAVED_FILE_MAPPING_UNAVAILABLE');
  check(receipt.kind==='native-saved-file'&&receipt.mappingMethod==='native-file-id'&&receipt.sourceMessageId===card.sourceMessageId&&
   receipt.ownerBindingId===ownerBindingId&&receipt.chatId===ownerChatId&&receipt.accountId===accountId&&
   typeof receipt.nativeFileId==='string'&&receipt.nativeFileId.length>0&&receipt.nativeFileId.length<=256,'SAVED_FILE_BINDING_MISMATCH');
  check(Number.isSafeInteger(receipt.generation)&&receipt.generation>0&&await verifyBinding(receipt,scope)===true,'SAVED_FILE_BINDING_UNVERIFIED');
  check(receipt.completed===true,'SAVED_FILE_NOT_COMPLETE');
  check(Number.isSafeInteger(receipt.expectedBytes)&&receipt.expectedBytes>=0&&receipt.expectedBytes<=scope.maxBytes,'SAVED_FILE_SIZE_LIMIT');
  check(relative(receipt.relativePath)&&path.extname(receipt.relativePath).toLowerCase()===path.extname(card.displayName).toLowerCase(),'SAVED_FILE_PATH_DENIED');
  const expectedHash=receipt.sha256;
  check(expectedHash===undefined||/^[a-f0-9]{64}$/.test(expectedHash),'SAVED_FILE_HASH_INVALID');
  check(receipt.fileIdentity&&receipt.fileIdentity.scheme===(process.platform==='win32'?'windows-file-id-v1':'posix-stat-v1')&&
    /^\d+$/.test(receipt.fileIdentity.device)&&/^\d+$/.test(receipt.fileIdentity.inode),'SAVED_FILE_IDENTITY_REQUIRED');
  const result=await worker({root:base,relativePath:receipt.relativePath,expectedBytes:receipt.expectedBytes,
    expectedSha256:expectedHash,fileIdentity:receipt.fileIdentity,maxBytes:scope.maxBytes,stableMs:75},{python,timeoutMs,signal:scope.signal});
  check(await isOwnerActive(scope)===true&&await verifyBinding(receipt,scope)===true,'SAVED_FILE_BINDING_UNVERIFIED');
  check(result&&typeof result.base64==='string'&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.base64),'SAVED_FILE_BYTES_INVALID');
  const bytes=Buffer.from(result.base64,'base64');
  check(bytes.length===receipt.expectedBytes&&result.bytes===bytes.length&&result.sha256===sha(bytes)&&(!expectedHash||result.sha256===expectedHash),'SAVED_FILE_HASH_MISMATCH');
  check(result.extension===path.extname(card.displayName).toLowerCase(),'SAVED_FILE_FORMAT_DENIED');
  check(result.fileIdentity?.scheme===receipt.fileIdentity.scheme&&result.fileIdentity?.device===receipt.fileIdentity.device&&result.fileIdentity?.inode===receipt.fileIdentity.inode,'SAVED_FILE_IDENTITY_MISMATCH');
  check(process.platform!=='win32'||result.exclusiveRead===true,'SAVED_FILE_EXCLUSIVE_READ_REQUIRED');
  return {verified:true,sourceMessageId:card.sourceMessageId,ownerBindingId,chatId:ownerChatId,bytes,sha256:result.sha256};
 }
 return Object.freeze({async acquire(card,scope){
  // Authorization happens for every caller before joining an in-flight job.
  check(scope?.ownerBindingId===ownerBindingId&&scope?.ownerChatId===ownerChatId&&await isOwnerActive(scope)===true,'OWNER_ATTACHMENT_REQUIRED');
  check(!scope.signal?.aborted,'SAVED_FILE_CANCELLED');
  const key=JSON.stringify([card?.sourceMessageId,card?.displayName,scope.maxBytes]);
  let job=running.get(key);
  if(!job){job=run(card,scope).finally(()=>running.delete(key));running.set(key,job);}
  const result=await job;
  check(!scope.signal?.aborted&&await isOwnerActive(scope)===true,'OWNER_AUTHORITY_REVOKED');
  return result;
 }});
}
