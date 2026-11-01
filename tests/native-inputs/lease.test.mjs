import test from 'node:test';import assert from 'node:assert/strict';
import {DurableDriverClient} from '../../driver/durable-client.mjs';
test('real file FIFO prevents polling between receive and selected-file completion',async()=>{
 const driver=new DurableDriverClient({targets:[{id:'owner',owner:true,mode:'private'}]});const history=[];let release,started;
 const inNative=new Promise(r=>started=r),wait=new Promise(r=>release=r);let savedSend;
 driver._call=async operation=>{history.push(operation);if(operation==='saved_file_acquire'){started();await wait;}return {status:'ok'};};
 const file=driver.withNativeFileLease(async send=>{savedSend=send;return send('saved_file_acquire',{targetId:'owner'});});
 await inNative;const read=driver.call('read',{targetId:'owner'});await Promise.resolve();assert.deepEqual(history,['saved_file_acquire']);release();await Promise.all([file,read]);assert.deepEqual(history,['saved_file_acquire','read']);
 assert.throws(()=>savedSend('saved_file_acquire',{}),/LEASE_CLOSED/);
});
