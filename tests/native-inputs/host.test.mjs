import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
import {createDriverSavedFileHost} from '../../src/driver-saved-file-host.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),id=x=>crypto.createHash('sha256').update(x).digest('hex');
function fixture(t){
 const folder=fs.mkdtempSync(path.join(here,'temporary-'));t.after(()=>{assert.equal(path.dirname(path.resolve(folder)),here);fs.rmSync(folder,{recursive:true,force:true});});
 const chat={id:'owner',title:'TEST_OWNER',mode:'private',owner:true},message={id:id('source'),role:'user',readId:'fresh',generation:7,nativeRef:{kind:'file'}},read={readId:'fresh',generation:7};read.nativeCurrent=[message];
 const trusted=new WeakSet([read]);let calls=0,fail=false,active=true;
 const ledgerPath=path.join(folder,'attempts.json'),driver={isTrustedNativeRead:r=>trusted.has(r),async withNativeFileLease(fn){return fn(async()=>{
  calls++;assert.equal(JSON.parse(fs.readFileSync(ledgerPath)).records[0][1].state,'attempting');
  if(fail)throw Error('SAVED_FILE_NATIVE_RESULT_UNKNOWN');
  return {status:'ok',data:{kind:'native-saved-file',completed:true,sourceMessageId:message.id,readId:read.readId,generation:read.generation,accountId:'fixture-account',exclusiveRead:true,sha256:id('bytes'),relativePath:'2026-11/fixture.txt',expectedBytes:5,fileIdentity:{scheme:'windows-file-id-v1',device:'1',inode:'2'},nativeFileId:'native-fixture',displayName:'fixture.txt',mappingMethod:'native-file-id'}};
 });}};
 const options={fileRoot:path.join(folder,'fixture-account/msg/file'),accountId:'fixture-account',ownerChatId:chat.id,ownerBindingId:'binding',ledgerPath,isOwnerActive:()=>active};
 return {chat,message,read,driver,options,input:{chat,message,read},calls:()=>calls,fail:v=>fail=v,active:v=>active=v,fresh(){const m={...message,readId:'later',generation:8},r={...read,readId:'later',generation:8,nativeCurrent:[m]};trusted.add(r);return {chat,message:m,read:r};}};
}
test('durable reserve precedes native action; concurrent calls and later reads never receive twice',async t=>{
 const f=fixture(t),host=createDriverSavedFileHost(f.driver,f.options);const [a,b]=await Promise.all([host.resolveSavedFile(f.input),host.resolveSavedFile(f.input)]);
 assert.equal(f.calls(),1);assert.equal(a,b);assert.equal(host.verifyBinding(a),true);
 const later=await host.resolveSavedFile(f.fresh());assert.equal(later.sourceMessageId,a.sourceMessageId);assert.equal(f.calls(),1);
});
test('uncertain response remains quarantined after another read and process recreation',async t=>{
 const f=fixture(t);f.fail(true);let host=createDriverSavedFileHost(f.driver,f.options);
 await assert.rejects(host.resolveSavedFile(f.input));host=createDriverSavedFileHost(f.driver,f.options);
 await assert.rejects(host.resolveSavedFile(f.fresh()),/OUTCOME_UNKNOWN/);assert.equal(f.calls(),1);
});
test('crashed attempting record is unknown; it cannot initiate another UI action',async t=>{
 const f=fixture(t),key=id('binding:'+f.message.id);fs.writeFileSync(f.options.ledgerPath,JSON.stringify({version:1,binding:'binding',chat:'owner',records:[[key,{state:'attempting',sourceMessageId:f.message.id}]]}));
 await assert.rejects(createDriverSavedFileHost(f.driver,f.options).resolveSavedFile(f.input),/OUTCOME_UNKNOWN/);assert.equal(f.calls(),0);
});
test('forged read, copied row, group or revoked authority reject before native UI',async t=>{
 const f=fixture(t),host=createDriverSavedFileHost(f.driver,f.options);
 for(const input of [{...f.input,read:{...f.read}},{...f.input,message:{...f.message}},{...f.input,chat:{...f.chat,mode:'group'}}])assert.throws(()=>host.resolveSavedFile(input));
 f.active(false);assert.throws(()=>host.resolveSavedFile(f.input));assert.equal(f.calls(),0);
});
test('ledger cannot be reused by another owner binding',t=>{const f=fixture(t);fs.writeFileSync(f.options.ledgerPath,JSON.stringify({version:1,binding:'other',chat:'owner',records:[]}));assert.throws(()=>createDriverSavedFileHost(f.driver,f.options),/SCOPE_CHANGED/);});
