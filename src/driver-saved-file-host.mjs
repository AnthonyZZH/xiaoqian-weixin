import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const check=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const hash=v=>crypto.createHash('sha256').update(String(v)).digest('hex');
/** Code-owned native UI capability, never a model tool or model-selected path. */
export function createDriverSavedFileHost(driver,{fileRoot,accountId,ownerChatId,ownerBindingId,ledgerPath,isOwnerActive,timeoutMs=15000}={}){
 check(typeof driver?.withNativeFileLease==='function'&&typeof driver?.isTrustedNativeRead==='function','SAVED_FILE_DRIVER_REQUIRED');
 check(path.isAbsolute(ledgerPath||'')&&path.isAbsolute(fileRoot||''),'SAVED_FILE_HOST_PATH_REQUIRED');
 check(typeof isOwnerActive==='function','OWNER_AUTHORITY_REQUIRED');
 check(Number.isInteger(timeoutMs)&&timeoutMs>=1000&&timeoutMs<=15000,'SAVED_FILE_TIMEOUT_INVALID');
 check([accountId,ownerChatId,ownerBindingId].every(s=>typeof s==='string'&&s.length>0),'SAVED_FILE_SCOPE_REQUIRED');
 const records=new Map(),issued=new WeakSet(),jobs=new Map();
 if(fs.existsSync(ledgerPath)){
  const st=fs.lstatSync(ledgerPath);check(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size<=1024*1024,'SAVED_FILE_LEDGER_INVALID');
  const data=JSON.parse(fs.readFileSync(ledgerPath,'utf8'));check(data.version===1&&data.binding===ownerBindingId&&data.chat===ownerChatId&&Array.isArray(data.records),'SAVED_FILE_LEDGER_SCOPE_CHANGED');
  for(const [key,row] of data.records){if(row.state==='attempting')row.state='unknown';records.set(key,row);}
 }
 const save=()=>{check(records.size<=1000,'SAVED_FILE_LEDGER_LIMIT');const next=ledgerPath+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(next,JSON.stringify({version:1,binding:ownerBindingId,chat:ownerChatId,records:[...records]}),{flag:'wx'});fs.renameSync(next,ledgerPath);};
 function authorized(chat,message,read){
  check(chat.id===ownerChatId&&chat.owner===true&&chat.mode==='private'&&isOwnerActive()===true,'OWNER_ATTACHMENT_REQUIRED');
  check(driver.isTrustedNativeRead(read)===true&&read.nativeCurrent?.includes(message)&&message.role==='user'&&message.readId===read.readId&&message.generation===read.generation,'SAVED_FILE_READ_UNTRUSTED');
  check(/^[a-f0-9]{64}$/.test(message.id)&&message.nativeRef?.kind==='file','SAVED_FILE_NATIVE_CARD_REQUIRED');
 }
 async function acquire({chat,message,read}){
  authorized(chat,message,read);const key=hash(ownerBindingId+':'+message.id);let row=records.get(key);
  if(row){check(row.state==='completed','SAVED_FILE_OUTCOME_UNKNOWN');const receipt=Object.freeze(structuredClone(row.receipt));issued.add(receipt);return receipt;}
  // Persist BEFORE dispatch. Crashes and ambiguous RPC responses cannot replay UI.
  row={state:'attempting',sourceMessageId:message.id,readId:read.readId,generation:read.generation};records.set(key,row);save();
  try{
   const answer=await driver.withNativeFileLease(send=>send('saved_file_acquire',{targetId:ownerChatId,messageId:message.id,readId:read.readId,generation:read.generation}),{timeoutMs});
   check(answer?.status==='ok'&&answer.data,'SAVED_FILE_NATIVE_RESULT_UNKNOWN');const value=answer.data;
   check(value.kind==='native-saved-file'&&value.completed===true&&value.sourceMessageId===message.id&&value.generation===read.generation&&value.readId===read.readId&&value.accountId===accountId&&value.exclusiveRead===true&&/^[a-f0-9]{64}$/.test(value.sha256),'SAVED_FILE_NATIVE_PROVENANCE_MISMATCH');
   const receipt=Object.freeze({...value,ownerBindingId,chatId:ownerChatId});
   row.state='completed';row.receipt=receipt;save();
   check(isOwnerActive()===true,'OWNER_AUTHORITY_REVOKED');issued.add(receipt);return receipt;
  }catch(error){if(row.state!=='completed'){row.state='unknown';row.code=/^[A-Z0-9_]{1,100}$/.test(error?.code||error?.message||'')?(error.code||error.message):'SAVED_FILE_NATIVE_UNKNOWN';save();}throw error;}
 }
 return Object.freeze({fileRoot,accountId,timeoutMs,
  resolveSavedFile(input){
   if(input.message?.nativeRef?.kind!=='file')return Promise.resolve(null);
   authorized(input.chat,input.message,input.read);const key=hash(ownerBindingId+':'+input.message.id);
   if(!jobs.has(key)){const job=acquire(input).finally(()=>jobs.delete(key));jobs.set(key,job);}return jobs.get(key);
  },verifyBinding(receipt){return issued.has(receipt)&&isOwnerActive()===true;},
  status(){return [...records.values()].map(({state,sourceMessageId})=>({state,sourceMessageId}));}
 });
}
