import {AsyncLocalStorage} from 'node:async_hooks';
const check=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const rect=r=>r&&['x','y','width','height'].every(k=>Number.isSafeInteger(r[k]))&&r.width>0&&r.height>0&&r.width<=4096&&r.height<=4096&&r.width*r.height<=8_000_000;

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
     imageBounds:structuredClone(data.imageBounds),viewportBounds:structuredClone(data.viewportBounds),
     sourceKind:data.sourceKind||'static_screenshot',pixelEncoding:data.pixelEncoding,originalSize:data.originalSize});
   issued.set(evidence,{...structuredClone(data),chatId});return evidence;
  },
  async isCurrent(evidence){
   try{const row=known(evidence),data=await request('image_current',wire(row));return data.current===true&&data.ticket===row.ticket&&data.readId===row.readId&&data.generation===row.generation&&same(data.imageBounds,row.imageBounds);}catch{return false;}
  },
  async capture(evidence){
   const row=known(evidence),data=await request('image_capture',wire(row));
   check(data.ticket===row.ticket&&data.messageId===row.messageId&&data.readId===row.readId&&data.generation===row.generation&&
     same(data.imageBounds,row.imageBounds)&&same(data.viewportBounds,row.viewportBounds),'IMAGE_CAPTURE_PROVENANCE_MISMATCH');
   if(row.pixelEncoding==='encoded-image/v1'){
    check(row.sourceKind==='wechat_viewer_original'&&data.pixelEncoding===row.pixelEncoding&&data.mediaType===row.mediaType&&['image/png','image/jpeg'].includes(data.mediaType),'IMAGE_ENCODING_INVALID');
    check(typeof data.encoded==='string'&&data.encoded.length<=5592408&&/^[A-Za-z0-9+/]*={0,2}$/.test(data.encoded),'IMAGE_FRAME_INVALID');
    const bytes=Buffer.from(data.encoded,'base64');
    check(bytes.length>0&&bytes.length<=4*1024*1024&&bytes.toString('base64')===data.encoded,'IMAGE_FRAME_INVALID');
    if(data.mediaType==='image/png')check(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.readUInt32BE(16)===row.imageBounds.width&&bytes.readUInt32BE(20)===row.imageBounds.height,'IMAGE_DIMENSIONS_INVALID');
    else check(bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217,'IMAGE_FRAME_INVALID');
    return {evidence,generation:row.generation,readId:row.readId,frame:{bounds:structuredClone(row.viewportBounds)},image:{data:bytes,mediaType:data.mediaType}};
   }
   check(typeof data.rgba==='string'&&data.rgba.length<=1398104&&/^[A-Za-z0-9+/]*={0,2}$/.test(data.rgba),'IMAGE_FRAME_INVALID');
   const rgba=Buffer.from(data.rgba,'base64');
   check(rgba.length===row.imageBounds.width*row.imageBounds.height*4&&rgba.toString('base64')===data.rgba,'IMAGE_FRAME_INVALID');
   return {evidence,generation:row.generation,readId:row.readId,frame:{bounds:structuredClone(row.viewportBounds),rgba}};
  }
 });
}
