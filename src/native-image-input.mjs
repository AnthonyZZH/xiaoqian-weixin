import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';

const check=(ok,code)=>{if(!ok)throw Object.assign(new Error(code),{code});};
const id=x=>typeof x==='string'&&x.length>0&&x.length<=256;
const integer=x=>Number.isSafeInteger(x);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const rect=r=>r&&['x','y','width','height'].every(k=>integer(r[k]))&&Math.abs(r.x)<=1_000_000&&Math.abs(r.y)<=1_000_000&&r.width>0&&r.height>0&&r.width<=32768&&r.height<=32768;
const inside=(a,b)=>a.x>=b.x&&a.y>=b.y&&a.x+a.width<=b.x+b.width&&a.y+a.height<=b.y+b.height;
const MAX_FRAME_PIXELS=16_000_000,MAX_IMAGE_PIXELS=2_000_000,MAX_EDGE=2048,MAX_BYTES=4*1024*1024;
const sha=b=>createHash('sha256').update(b).digest('hex');
let table;
function crc32(b){
  table??=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  let c=0xffffffff;for(const n of b)c=table[(c^n)&255]^(c>>>8);return (c^0xffffffff)>>>0;
}
function chunk(name,data){const tag=Buffer.from(name),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);tag.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(out.subarray(4,-4)),out.length-4);return out;}

/** Pure screenshot crop. Input/output stay in memory; no path, URL, download or OCR. */
export function cropScreenshot(frame,imageBounds){
  check(rect(frame?.bounds)&&rect(imageBounds)&&inside(imageBounds,frame.bounds),'IMAGE_CROP_INVALID');
  const {width,height}=frame.bounds;
  check(width*height<=MAX_FRAME_PIXELS,'IMAGE_FRAME_LIMIT');
  check(imageBounds.width<=MAX_EDGE&&imageBounds.height<=MAX_EDGE&&imageBounds.width*imageBounds.height<=MAX_IMAGE_PIXELS,'IMAGE_PIXEL_LIMIT');
  // A provider supplies detached RGBA bytes, never a file name or compressed image.
  check(Buffer.isBuffer(frame.rgba)&&frame.rgba.length===width*height*4,'IMAGE_FRAME_INVALID');
  const scan=Buffer.alloc((imageBounds.width*4+1)*imageBounds.height);
  const x=imageBounds.x-frame.bounds.x,y=imageBounds.y-frame.bounds.y;
  for(let row=0;row<imageBounds.height;row++){
    const from=((y+row)*width+x)*4,to=row*(imageBounds.width*4+1);
    frame.rgba.copy(scan,to+1,from,from+imageBounds.width*4);
  }
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(imageBounds.width);ihdr.writeUInt32BE(imageBounds.height,4);ihdr[8]=8;ihdr[9]=6;
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]);
  check(png.length<=MAX_BYTES,'IMAGE_BYTE_LIMIT');return png;
}

/**
 * Trusted host capability, not a model tool. provider must originate evidence
 * from the authenticated current native read (see PROVIDER-CONTRACT.md).
 * Flags alone never authenticate an object obtained from message JSON.
 */
export function createNativeImageInput({attachments,provider,getScope}={}){
  check(typeof attachments?.admitPromptContent==='function','NATIVE_ATTACHMENT_STORE_REQUIRED');
  check(typeof getScope==='function'&&['withReadLease','evidenceForRead','capture','isCurrent'].every(k=>typeof provider?.[k]==='function'),'TRUSTED_IMAGE_PROVIDER_REQUIRED');
  const tickets=new WeakMap(),uncertainFailures=new WeakSet();
  const current=(chatId,scope)=>check(same(getScope(chatId),scope),'IMAGE_SCOPE_REVOKED');
  return Object.freeze({
    isUncertainFailure(error){return error!==null&&typeof error==='object'&&uncertainFailures.has(error);},
    async prepare({chatId,message,read}){
      check(id(chatId)&&/^[a-f0-9]{64}$/.test(message?.id)&&message.role==='user'&&message.imageAvailable===true&&id(message.sourceKey),'IMAGE_CANONICAL_MESSAGE_REQUIRED');
      check(read?.identityVersion==='uia-row-v2'&&integer(read.generation)&&read.generation>0&&id(read.readId),'IMAGE_READ_PROVENANCE_REQUIRED');
      const scope=structuredClone(getScope(chatId));
      check(scope?.active===true&&id(scope.binding)&&id(scope.sessionId)&&['private','group'].includes(scope.mode)&&typeof scope.owner==='boolean'&&integer(scope.groupEpoch)&&id(scope.provider)&&id(scope.model),'IMAGE_SCOPE_INVALID');
      let captureAttempted=false;
      try{return await provider.withReadLease(async()=>{
        current(chatId,scope);
        const evidence=await provider.evidenceForRead({chatId,message,read,scope:structuredClone(scope)});
        check(evidence&&evidence.chatId===chatId&&evidence.messageId===message.id&&evidence.sourceKey===message.sourceKey&&evidence.generation===read.generation&&evidence.readId===read.readId&&evidence.binding===scope.binding&&evidence.role==='user'&&evidence.kind==='image'&&evidence.state==='ready','IMAGE_EVIDENCE_INVALID');
        check(evidence.exactImageBounds===true&&evidence.unobscured===true&&rect(evidence.imageBounds)&&rect(evidence.viewportBounds)&&inside(evidence.imageBounds,evidence.viewportBounds),'IMAGE_EXACT_BOUNDS_REQUIRED');
        // Snapshot primitives before awaiting: a mutable host receipt cannot widen the crop.
        const bounds=structuredClone(evidence.imageBounds),viewport=structuredClone(evidence.viewportBounds);
        check(await provider.isCurrent(evidence)===true,'IMAGE_SNAPSHOT_STALE');
        captureAttempted=true;
        const receipt=await provider.capture(evidence);
        check(receipt?.evidence===evidence&&receipt.generation===read.generation&&receipt.readId===read.readId&&same(receipt.frame?.bounds,viewport),'IMAGE_CAPTURE_PROVENANCE_MISMATCH');
        check(await provider.isCurrent(evidence)===true,'IMAGE_SNAPSHOT_STALE');current(chatId,scope);
        const png=cropScreenshot(receipt.frame,bounds);
        // Actual installed Harness API: encoded uploads -> durable ImageBlock refs.
        const blocks=await attachments.admitPromptContent([{type:'image',data:png.toString('base64'),mediaType:'image/png',name:'wechat-message-capture.png'}]);
        current(chatId,scope);check(await provider.isCurrent(evidence)===true,'IMAGE_SNAPSHOT_STALE');
        check(Array.isArray(blocks)&&blocks.length===1&&blocks[0]?.type==='image'&&blocks[0].attachment&&typeof blocks[0].attachment==='object','IMAGE_ADMISSION_INVALID');
        const ticket=Object.freeze({});
        tickets.set(ticket,{chatId,messageId:message.id,scope,evidence,blocks:structuredClone(blocks),sha256:sha(png)});
        return ticket;
      });}catch(error){
        if(error!==null&&typeof error==='object'&&(captureAttempted||['IMAGE_MEASUREMENT_CAPTURE_UNKNOWN','IMAGE_MEASUREMENT_STALE'].includes(error.code||error.message)))uncertainFailures.add(error);
        throw error;
      }
    },
    async content(ticket,{chatId,messageId}){
      const row=tickets.get(ticket);
      check(row&&row.chatId===chatId&&row.messageId===messageId,'IMAGE_TICKET_SCOPE_MISMATCH');
      current(chatId,row.scope);check(await provider.isCurrent(row.evidence)===true,'IMAGE_SNAPSHOT_STALE');current(chatId,row.scope);
      return structuredClone(row.blocks);
    }
  });
}
