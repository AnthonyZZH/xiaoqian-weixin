import path from 'node:path';
import {digest} from './state.mjs';
import {requireValue} from './policy.mjs';
import {createAttachmentRegistry} from '../vendor/owner-tools/index.mjs';
import {createAttachmentIngress} from '../vendor/attachment-ingress/attachment-ingress-pdf.mjs';
import {createSavedFileBroker} from '../vendor/attachment-ingress/saved-file-broker.mjs';

// Host callbacks resolve native file IDs; model/config text cannot supply paths.
export function createOwnerAttachmentHost({getCore,root,chats,savedHost,python,spoolDirectory='owner-attachment-spool'}={}) {
 const owners=chats.filter(c=>c.owner===true&&c.mode==='private');
 requireValue(owners.length===1,'OWNER_ATTACHMENT_BINDING_REQUIRED');
 const owner=owners[0],binding=digest(JSON.stringify([owner.id,owner.title,owner.mode,owner.owner]));
 requireValue(typeof savedHost?.resolveSavedFile==='function'&&typeof savedHost?.verifyBinding==='function','SAVED_FILE_BINDING_REQUIRED');
 const isOwnerActive=()=>{
  const core=getCore(),chat=core?.chats.get(owner.id);
  return !!(core&&!core.closed&&!core.store.data.paused&&chat?.owner&&chat.mode==='private'&&
    digest(JSON.stringify([chat.id,chat.title,chat.mode,chat.owner]))===binding&&core.state(owner.id).binding===binding&&
    !core.state(owner.id).rotationFence&&!core.state(owner.id).rotationUncertain);
 };
 requireValue(typeof spoolDirectory==='string'&&/^[a-z0-9_-]{1,80}$/.test(spoolDirectory),'ATTACHMENT_SPOOL_DIRECTORY_INVALID');
 const nativeBindings=new Map(),pending=new Map();let closed=false;
 const fileBroker=createSavedFileBroker({root:savedHost.fileRoot,accountId:savedHost.accountId,
  ownerBindingId:binding,ownerChatId:owner.id,isOwnerActive,python,
  resolveBoundFile:card=>nativeBindings.get(card.sourceMessageId),
  verifyBinding:receipt=>savedHost.verifyBinding(receipt),timeoutMs:savedHost.timeoutMs});
 const ingress=createAttachmentIngress({root:path.join(root,spoolDirectory),ownerBindingId:binding,
  ownerChatId:owner.id,createAttachmentRegistry,fileBroker,isOwnerActive});
 async function receiveOwnerFile({chatId,message,read}){
  const core=getCore();
  requireValue(!closed&&isOwnerActive()&&chatId===owner.id,'OWNER_ATTACHMENT_REQUIRED');
  requireValue(core.isTrustedAttachmentRead(message),'ATTACHMENT_DRIVER_READ_REQUIRED');
  const key=digest('attachment:'+message.id),prior=core.state(owner.id).messages[key];
  if(prior)return {status:prior.status==='accepted'?'duplicate':'unknown'};
  if(pending.has(key))return pending.get(key);
  const job=(async()=>{
   // Existing registered files stay readable, but never trigger receive or an
   // unreviewed Agent replay merely because a host was replaced/reloaded.
   const existing=ingress.registered(message.id);
   if(existing)return {...existing,status:'registered-existing'};
   const receipt=await savedHost.resolveSavedFile({chat:owner,message,read});
   if(receipt==null)return {status:'not_attachment'};
   requireValue(receipt.kind==='native-saved-file'&&receipt.sourceMessageId===message.id,'SAVED_FILE_MAPPING_UNAVAILABLE');
   requireValue(!closed&&isOwnerActive(),'OWNER_AUTHORITY_REVOKED');
   nativeBindings.set(message.id,receipt);
   const descriptor=await ingress.receive({authenticatedOwner:true,ownerBindingId:binding,chatId:owner.id,
    mode:'private',role:'user',messageId:message.id},{kind:'native-saved-file',displayName:receipt.displayName,sourceMessageId:message.id});
   requireValue(!closed&&isOwnerActive(),'OWNER_AUTHORITY_REVOKED');
   return core.deliverOwnerAttachment(owner.id,descriptor);
  })();
  pending.set(key,job);
  try{return await job;}finally{pending.delete(key);nativeBindings.delete(message.id);}
 }
 return Object.freeze({attachments:ingress.attachments,receiveOwnerFile,registered:()=>ingress.registeredFiles(),
  observeRead({chatId,rows,read}){
   if(closed||chatId!==owner.id)return;
   for(const message of rows)if(message.role!=='assistant')void receiveOwnerFile({chatId,message,read}).catch(error=>{
    const core=getCore();if(!core||core.closed)return;
    const reason=/^[A-Z0-9_]{1,80}$/.test(error?.message||'')?error.message:'SAVED_FILE_INGRESS_FAILED';
    try{core.store.audit('OWNER_ATTACHMENT_FAILED',owner.id,{reason});}catch{}
   });
  },
  async whenIdle(){await Promise.allSettled([...pending.values()]);},close(){closed=true;}
 });
}
