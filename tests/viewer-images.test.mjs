import test from 'node:test';
import assert from 'node:assert/strict';
import {createDriverNativeImageHost} from '../src/driver-native-image-host.mjs';
import {createNativeImageInput,cropScreenshot} from '../src/native-image-input.mjs';
const bounds={x:0,y:0,width:900,height:1800};
const png=cropScreenshot({bounds,rgba:Buffer.alloc(bounds.width*bounds.height*4,255)},bounds);
function fixture(change={}){
 const data={schema:'xq.native-image/v1',messageId:'a'.repeat(64),sourceKey:'source',generation:1,readId:'read',ticket:'t'.repeat(40),expiresAt:Date.now()+15000,imageBounds:bounds,viewportBounds:bounds,sourceKind:'wechat_viewer_original',pixelEncoding:'encoded-image/v1',mediaType:'image/png',originalSize:{width:900,height:1800},encoded:png.toString('base64'),...change};
 const driver={call:async(op)=>({status:'ok',data:{...data,...(op==='image_current'?{current:true}:{})}}),withNativeImageLease:fn=>fn(driver.call)};
 const admitted=[];const scope={active:true,owner:true,mode:'private',binding:'bound',sessionId:'session',groupEpoch:0,provider:'provider',model:'model'};
 const input=createNativeImageInput({provider:createDriverNativeImageHost(driver),getScope:()=>scope,attachments:{admitPromptContent:async blocks=>{admitted.push(blocks);return [{type:'image',attachment:{id:'stored'}}];}}});
 const request={chatId:'owner',message:{id:data.messageId,role:'user',imageAvailable:true,sourceKey:'source'},read:{identityVersion:'uia-row-v2',generation:1,readId:'read'}};
 return {input,request,admitted};
}
test('viewer original passes native IPC and attachment admission without thumbnail reduction',async()=>{
 const f=fixture(),ticket=await f.input.prepare(f.request);
 assert.equal(f.admitted[0][0].data,png.toString('base64'));
 assert.deepEqual(f.input.metadata(ticket,{chatId:'owner',messageId:f.request.message.id}),{sourceKind:'wechat_viewer_original',width:900,height:1800,originalSize:{width:900,height:1800}});
 assert.equal((await f.input.content(ticket,{chatId:'owner',messageId:f.request.message.id}))[0].type,'image');
});
test('encoded viewer payload rejects mismatched image dimensions before admission',async()=>{
 const f=fixture({imageBounds:{...bounds,height:1799},viewportBounds:{...bounds,height:1799}});
 await assert.rejects(()=>f.input.prepare(f.request),/IMAGE_DIMENSIONS_INVALID/);assert.equal(f.admitted.length,0);
});
test('encoded viewer payload cannot impersonate a screenshot provider',async()=>{
 const f=fixture({sourceKind:'static_screenshot'});
 await assert.rejects(()=>f.input.prepare(f.request),/IMAGE_ENCODING_INVALID/);assert.equal(f.admitted.length,0);
});
