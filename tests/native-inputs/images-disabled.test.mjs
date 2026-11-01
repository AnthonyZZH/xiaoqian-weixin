import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {WeChatCore} from '../../src/core.mjs';import {digest} from '../../src/state.mjs';
test('disabled automatic images report no pixels once and do not block following owner text',async t=>{
 const parent=path.join(import.meta.dirname,'temporary-images-off');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'case-'));
 const id=s=>crypto.createHash('sha256').update(s).digest('hex'),inputs=[],history=[];
 const rows=[{id:id('new-image'),role:'user',text:'[Image]',imageAvailable:true},{id:id('following-text'),role:'user',text:'ordinary owner text'}];
 const driver={supportsAck:true,async call(op){history.push(op);assert.ok(['read','ack'].includes(op));return op==='read'?{status:'ok',messages:rows}:{status:'ok'};},async close(){}};
 const core=new WeChatCore({stateDir:root,chats:[{id:'owner',title:'SYNTHETIC',mode:'private',owner:true}],driver,agents:{create(){throw Error('NO_NEW_AGENT');}},sessions:{async flush(){return true;}}});
 core.handles.set('owner',{agent:{session:{id:core.state('owner').sessionId},followup(input){inputs.push(input);}}});core.state('owner').bootstrapped=true;core.store.data.paused=false;
 t.after(async()=>{await core.close();assert.equal(path.dirname(path.resolve(root)),parent);fs.rmSync(root,{recursive:true,force:true});});
 assert.equal((await core.poll('owner')).accepted,2);assert.equal(inputs.length,2);assert.equal(inputs[0].content.length,1);
 const unavailable={status:'unavailable',pixelsDelivered:false,code:'IMAGE_AUTO_EXTERNAL_NOT_AUTHORIZED'};
 assert.deepEqual(core.state('owner').messages[digest(rows[0].id)].imageRead,unavailable);assert.ok(inputs[1].content[0].text.includes('ordinary owner text'));
 await core.poll('owner');assert.equal(inputs.length,2);assert.equal(history.some(x=>/image|extract|download/.test(x)),false);
});
