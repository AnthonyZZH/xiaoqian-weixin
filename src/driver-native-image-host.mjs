import {AsyncLocalStorage} from 'node:async_hooks';
const check=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const rect=r=>r&&['x','y','width','height'].every(k=>Number.isSafeInteger(r[k]))&&r.width>0&&r.height>0&&r.width<=512&&r.height<=512&&r.width*r.height<=262144;

/** Code-owned bridge to private driver IPC; not a tool or public control endpoint. */
export function createDriverNativeImageHost(driver,{clock=Date.now,allowedMessageIds}={}){
 check(typeof driver?.call==='function'&&typeof driver?.withNativeImageLease==='function','NATIVE_IMAGE_DRIVER_REQUIRED');
 const leases=new AsyncLocalStorage(),issued=new WeakMap();
 const allowed=allowedMessageIds===undefined?null:new Set(allowedMessageIds);
 async function request(operation,args){
  const send=leases.getStore()??((op,a)=>driver.call(op,a));
  const response=await send(operation,args);
  check(response?.status==='ok'&&response.data,response?.code&&/^[A-Z0-9_]{1,100}$/.test(response.code)?response.code:'NATIVE_IMAGE_RPC_FAILED');
  return response.data;
 }
 function wire(row){return {targetId:row.chatId,messageId:row.messageId,readId:row.readId,generation:row.generation,ticket:row.ticket};}
 function known(evidence){const row=issued.get(evidence);check(row&&clock()<row.expiresAt,'IMAGE_CAPABILITY_EXPIRED');return row;}
 return Object.freeze({
  withReadLease(fn){return driver.withNativeImageLease(send=>leases.run(send,fn));},
  async evidenceForRead({chatId,message,read,scope}){
   check(!allowed||allowed.has(message.id),'IMAGE_MESSAGE_NOT_AUTHORIZED');
   const data=await request('image_inspect',{targetId:chatId,messageId:message.id,generation:read.generation,readId:read.readId});
   check(data.schema==='xq.native-image/v1'&&data.messageId===message.id&&data.sourceKey===message.sourceKey&&
     data.generation===read.generation&&data.readId===read.readId&&typeof data.ticket==='string'&&data.ticket.length>=32&&
     Number.isSafeInteger(data.expiresAt)&&clock()<data.expiresAt&&rect(data.imageBounds)&&same(data.imageBounds,data.viewportBounds),'IMAGE_NATIVE_RECEIPT_INVALID');
   const evidence=Object.freeze({chatId,messageId:message.id,sourceKey:message.sourceKey,generation:data.generation,readId:data.readId,
     binding:scope.binding,role:'user',kind:'image',state:'ready',exactImageBounds:true,unobscured:true,
     imageBounds:structuredClone(data.imageBounds),viewportBounds:structuredClone(data.viewportBounds)});
   issued.set(evidence,{...structuredClone(data),chatId});return evidence;
  },
  async isCurrent(evidence){
   try{const row=known(evidence),data=await request('image_current',wire(row));return data.current===true&&data.ticket===row.ticket&&data.readId===row.readId&&data.generation===row.generation&&same(data.imageBounds,row.imageBounds);}catch{return false;}
  },
  async capture(evidence){
   const row=known(evidence),data=await request('image_capture',wire(row));
   check(data.ticket===row.ticket&&data.messageId===row.messageId&&data.readId===row.readId&&data.generation===row.generation&&
     same(data.imageBounds,row.imageBounds)&&same(data.viewportBounds,row.viewportBounds),'IMAGE_CAPTURE_PROVENANCE_MISMATCH');
   check(typeof data.rgba==='string'&&data.rgba.length<=1398104&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.rgba),'IMAGE_FRAME_INVALID');
   const rgba=Buffer.from(data.rgba,'base64');
   check(rgba.length===row.imageBounds.width*row.imageBounds.height*4&&rgba.toString('base64')===data.rgba,'IMAGE_FRAME_INVALID');
   return {evidence,generation:row.generation,readId:row.readId,frame:{bounds:structuredClone(row.viewportBounds),rgba}};
  }
 });
}
