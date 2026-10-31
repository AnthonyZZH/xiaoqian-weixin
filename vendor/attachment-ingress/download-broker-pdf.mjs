/** Bounded save-as broker. UI selectors come ONLY from a validated native UI port. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const check=(ok,code)=>{if(!ok)throw new Error(code);};
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
export function createDownloadBroker({root,uiPort,profile,isOwnerActive,timeoutMs=8000,pollMs=200}={}){
 check(path.isAbsolute(root),'DOWNLOAD_ROOT_REQUIRED');
 check(typeof isOwnerActive==='function','OWNER_AUTHORITY_REQUIRED');
 check(Number.isInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=30000,'DOWNLOAD_TIMEOUT_INVALID');
 check(Number.isInteger(pollMs)&&pollMs>=20&&pollMs<=1000,'DOWNLOAD_POLL_INVALID');
 const base=path.resolve(root);let cursor=path.parse(base).root;
 for(const part of base.slice(cursor.length).split(path.sep).filter(Boolean)){
  cursor=path.join(cursor,part);if(fs.existsSync(cursor))check(!fs.lstatSync(cursor).isSymbolicLink(),'DOWNLOAD_LINK_DENIED');
 }
 if(!fs.existsSync(base))fs.mkdirSync(base);
 check(fs.lstatSync(base).isDirectory()&&fs.realpathSync(base)===base,'DOWNLOAD_ROOT_INVALID');
 const running=new Map();
 function journalFile(key){return path.join(base,key+'.json');}
 function store(key,row){const tmp=journalFile(key)+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(row),{flag:'wx'});fs.renameSync(tmp,journalFile(key));}
 function load(key){
  const file=journalFile(key);if(!fs.existsSync(file))return null;
  const st=fs.lstatSync(file);check(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size<16384,'DOWNLOAD_JOURNAL_INVALID');
  return JSON.parse(fs.readFileSync(file,'utf8'));
 }
 function target(row){
  check(/^[a-f0-9-]+$/.test(row.directory)&&/^[a-f0-9-]+\.(txt|docx|pdf)$/.test(row.file),'DOWNLOAD_TARGET_INVALID');
  const dir=path.join(base,row.directory),st=fs.lstatSync(dir);
  check(st.isDirectory()&&!st.isSymbolicLink()&&fs.realpathSync(dir)===dir,'DOWNLOAD_LINK_DENIED');return path.join(dir,row.file);
 }
 function bytesIfComplete(row,maxBytes){
  const file=target(row);if(!fs.existsSync(file))return null;
  const before=fs.lstatSync(file);check(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=maxBytes,'DOWNLOAD_FILE_REJECTED');
  let fd;try{
   fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));const actual=fs.fstatSync(fd);
   check(actual.dev===before.dev&&actual.ino===before.ino&&actual.nlink===1&&actual.isFile()&&actual.size<=maxBytes,'DOWNLOAD_FILE_CHANGED');
   const bytes=Buffer.alloc(Math.min(actual.size,maxBytes)+1),count=fs.readSync(fd,bytes,0,bytes.length,0),after=fs.fstatSync(fd);
   if(count!==actual.size||after.size!==actual.size||after.mtimeMs!==actual.mtimeMs)return null;
   return {bytes:bytes.subarray(0,count),stamp:[actual.size,actual.mtimeMs,hash(bytes.subarray(0,count))].join(':')};
  }finally{if(fd!==undefined)fs.closeSync(fd);}
 }
 async function run(card,scope){
  const deadline=Date.now()+timeoutMs;
  async function bounded(call){
   const remaining=deadline-Date.now();check(remaining>0,'DOWNLOAD_DEADLINE');
   const controller=new AbortController();let timer;
   try{return await Promise.race([call({signal:controller.signal,deadline}),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('DOWNLOAD_DEADLINE'));},remaining);})]);}
   finally{clearTimeout(timer);}
  }
  check(profile?.verified===true&&typeof profile.evidenceId==='string'&&profile.evidenceId.length>0,'DOWNLOAD_PROFILE_UNVERIFIED');
  check(typeof uiPort?.inspect==='function'&&typeof uiPort?.saveAs==='function'&&typeof uiPort?.completion==='function','DOWNLOAD_UI_PORT_REQUIRED');
  check(typeof card.sourceMessageId==='string'&&/\.(txt|docx|pdf)$/i.test(card.displayName),'DOWNLOAD_CARD_INVALID');
  check(typeof scope.ownerBindingId==='string'&&typeof scope.ownerChatId==='string'&&scope.maxBytes>0&&scope.maxBytes<=5*1024*1024,'DOWNLOAD_SCOPE_INVALID');
  const key=hash(JSON.stringify([scope.ownerBindingId,scope.ownerChatId,card.sourceMessageId]));
  let row=load(key);
  if(row)check(row.ownerBindingId===scope.ownerBindingId&&row.chatId===scope.ownerChatId&&row.sourceMessageId===card.sourceMessageId,'DOWNLOAD_SCOPE_MISMATCH');
  check(await isOwnerActive(scope)===true,'OWNER_AUTHORITY_REVOKED');
  if(!row){
   // Caller serializes this inspect+saveAs with all other UI operations. The port
   // must revalidate exact window/chat/card identity immediately before its action.
   const evidence=await bounded(control=>uiPort.inspect(card,{...scope,...control},profile));
   check(evidence?.verified===true&&evidence.sourceMessageId===card.sourceMessageId&&evidence.chatId===scope.ownerChatId&&evidence.filename===card.displayName&&typeof evidence.identityToken==='string'&&evidence.identityToken,'DOWNLOAD_CARD_IDENTITY_UNVERIFIED');
   check(await isOwnerActive(scope)===true,'OWNER_AUTHORITY_REVOKED');
   row={ownerBindingId:scope.ownerBindingId,chatId:scope.ownerChatId,sourceMessageId:card.sourceMessageId,
    directory:crypto.randomUUID(),file:crypto.randomUUID()+path.extname(card.displayName).toLowerCase(),state:'reserved',evidenceId:profile.evidenceId};
   fs.mkdirSync(path.join(base,row.directory));store(key,row); // durable BEFORE UI
   try{await bounded(control=>uiPort.saveAs(card,{...scope,...control,destination:target(row),expectedIdentity:evidence.identityToken,profile}));}
   catch{row.state='unknown';store(key,row);throw new Error('DOWNLOAD_ACTION_UNKNOWN');}
  }
  // Existing reservation never repeats the click, even after crash or timeout.
  let previous='',stable=0;
  while(Date.now()<deadline){
   check(await isOwnerActive(scope)===true,'OWNER_AUTHORITY_REVOKED');
   const proof=await bounded(control=>uiPort.completion(card,{...scope,...control,destination:target(row),evidenceId:row.evidenceId}));
   const complete=proof?.completed===true&&proof.sourceMessageId===row.sourceMessageId&&proof.chatId===row.chatId&&proof.destination===target(row)&&Number.isInteger(proof.expectedBytes)&&proof.expectedBytes>=0&&proof.expectedBytes<=scope.maxBytes&&typeof proof.evidenceToken==='string'&&proof.evidenceToken.length>0;
   const item=complete?bytesIfComplete(row,scope.maxBytes):null;
   if(item&&item.bytes.length!==proof.expectedBytes){previous='';stable=0;await new Promise(resolve=>setTimeout(resolve,pollMs));continue;}
   if(item){stable=item.stamp===previous?stable+1:1;previous=item.stamp;
    if(stable>=3){
     if(row.sha256)check(row.sha256===hash(item.bytes),'DOWNLOAD_CONTENT_CHANGED');
     row.state='complete';row.sha256=hash(item.bytes);store(key,row);
     return {verified:true,ownerBindingId:row.ownerBindingId,chatId:row.chatId,sourceMessageId:row.sourceMessageId,bytes:item.bytes};
    }
   }else{stable=0;previous='';}
   await new Promise(resolve=>setTimeout(resolve,pollMs));
  }
  row.state='unknown';store(key,row);throw new Error('DOWNLOAD_COMPLETION_UNKNOWN');
 }
 return Object.freeze({acquire(card,scope){
  const key=hash(JSON.stringify([scope.ownerBindingId,scope.ownerChatId,card.sourceMessageId]));
  if(running.has(key))return running.get(key);
  const promise=run(card,scope).finally(()=>running.delete(key));running.set(key,promise);return promise;
 }});
}
