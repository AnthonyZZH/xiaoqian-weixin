import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
export function atomic(file,value){if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('UNSAFE_FILE');const tmp=file+'.'+crypto.randomUUID()+'.tmp',fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
export class PersonaCAS{
 constructor({features,authorize,coordinatedWriters=false}){Object.assign(this,{features,authorize,coordinatedWriters});}
 file(chatId){const chat=this.features.chat(chatId);if(!chat.owner||chat.mode!=='private')throw Error('OWNER_PERSONA_ONLY');return path.join(this.features.namespace(chatId),'persona.json');}
 snapshot(chatId){const file=this.file(chatId);let raw=null;
  if(fs.existsSync(file)){if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>65536)throw Error('PERSONA_FILE_INVALID');raw=fs.readFileSync(file);const v=JSON.parse(raw);if(v.version!==1||typeof v.text!=='string'||v.text.length>12000)throw Error('PERSONA_INVALID');return {text:v.text.trim(),revision:sha(raw),generation:v.generation??null,operation:v.taskOperation??null};}
  const text=this.features.persona(chatId);return {text,revision:sha('absent\0'+text),generation:null,operation:null};
 }
 receipt(chatId,operation){const p=path.join(path.dirname(this.file(chatId)),'task-persona-receipts',sha(operation)+'.json');return fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):null;}
 commit(owner,{chatId,operation,expectedRevision,text}){
  if(owner?.mode!=='private'||owner.chatId!==chatId||this.authorize(owner)!==true)throw Error('OWNER_REVOKED');
  if(!this.coordinatedWriters)throw Error('ALL_PERSONA_WRITERS_MUST_USE_CAS');
  if(typeof text!=='string'||!text.trim()||text.trim().length>12000||typeof operation!=='string'||!operation)throw Error('CANDIDATE_INVALID');
  const file=this.file(chatId),dir=path.dirname(file),lock=file+'.task-cas.lock';
  const candidates=path.join(dir,'persona-candidates');fs.mkdirSync(candidates,{recursive:true});
  const candidateFile=path.join(candidates,sha(operation)+'.json'),candidate={text:text.trim(),expectedRevision};
  if(fs.existsSync(candidateFile)){const prior=JSON.parse(fs.readFileSync(candidateFile));if(JSON.stringify(prior)!==JSON.stringify(candidate))throw Error('OPERATION_PAYLOAD_CONFLICT');}else atomic(candidateFile,candidate);
  if(fs.existsSync(lock)){const pid=JSON.parse(fs.readFileSync(lock)).pid;try{process.kill(pid,0);throw Error('PERSONA_BUSY');}catch(e){if(e.code!=='ESRCH')throw e;fs.unlinkSync(lock);}}
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});
  try{
   const receiptDir=path.join(dir,'task-persona-receipts'),backupDir=path.join(dir,'persona-backups');
   fs.mkdirSync(receiptDir,{recursive:true});fs.mkdirSync(backupDir,{recursive:true});
   const receiptFile=path.join(receiptDir,sha(operation)+'.json'),prior=this.receipt(chatId,operation),current=this.snapshot(chatId),nextText=text.trim();
   if(prior&&prior.proposedHash!==sha(nextText))throw Error('OPERATION_PAYLOAD_CONFLICT');
   if(prior?.status==='applied')return {...prior.result,duplicate:true};
   if(prior?.status==='prepared'&&current.operation===operation&&current.generation===prior.generation){
    const result={applied:true,revision:current.revision,backupStored:true,candidateStored:true};atomic(receiptFile,{...prior,status:'applied',result});return result;
   }
   if(current.revision!==expectedRevision){if(prior)throw Object.assign(Error('COMMIT_UNCERTAIN_CURRENT_CHANGED'),{uncertain:true});return {applied:false,reason:'PERSONA_VERSION_CONFLICT',candidateStored:true};}
   const backupFile=path.join(backupDir,'task-'+sha(operation)+'.json');
   if(!fs.existsSync(backupFile))atomic(backupFile,{version:1,text:current.text,revision:current.revision,sourceExisted:fs.existsSync(file),rawBase64:fs.existsSync(file)?fs.readFileSync(file).toString('base64'):null});
   const intent=prior??{status:'prepared',operation,expectedRevision,proposedHash:sha(nextText),generation:crypto.randomUUID()};
   atomic(receiptFile,intent);
   // NO await, model call or chat/core serial lock in this critical section.
   atomic(file,{version:1,text:nextText,generation:intent.generation,taskOperation:operation});
   const result={applied:true,revision:this.snapshot(chatId).revision,backupStored:true,candidateStored:true};
   atomic(receiptFile,{...intent,status:'applied',result});return result;
  }catch(error){try{if(this.receipt(chatId,operation)?.status==='prepared')error.uncertain=true;}catch{error.uncertain=true;}throw error;}finally{fs.unlinkSync(lock);}
 }
}

/** Main must route owner writes through CAS before enabling background persona edits. */
export function blockLegacyOwnerPersonaWrites(features){
 const original=features.setPersona;
 const blocked=function(id,...args){if(this.chat(id).owner)throw Error('VERSIONED_PERSONA_WRITE_REQUIRED');return original.call(this,id,...args);};
 features.setPersona=blocked;return ()=>{if(features.setPersona===blocked)features.setPersona=original;};
}
