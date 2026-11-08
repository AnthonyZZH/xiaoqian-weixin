import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createBridge} from '../src/index.mjs';
import {createDriverSavedFileHost} from '../src/driver-saved-file-host.mjs';
import {DurableDriverClient} from '../driver/durable-client.mjs';
import {allowedTools,authorize} from '../src/policy.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const owner={id:'owner',title:'SYNTHETIC OWNER',mode:'private',owner:true};
const group={id:'group',title:'SYNTHETIC GROUP',mode:'group',owner:false};
const formats=['txt','md','csv','json','pdf','docx','xlsx','pptx','zip'];
function temporary(t,close=()=>{}){
 const root=fs.mkdtempSync(path.join(repo,'.git','t011-test-'));
 t.after(async()=>{await close();assert.ok(path.resolve(root).startsWith(path.join(repo,'.git')+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 return root;
}
async function fixture(t,{autoImages=false,autoFiles=true}={}){
 let bridge;
 const root=temporary(t,()=>bridge?.core.close()),fileRoot=path.join(root,'account','FileStorage','File');fs.mkdirSync(fileRoot,{recursive:true});
 const calls=[],agents=[],trusted=new WeakSet(),receipts=new WeakSet(),received=[],parsed=[];
 let next,seq=0;
 const create=async options=>{
  const tools=new Map(),sections=[],agent={status:'idle',inbox:{nextTurn:[],nextStep:[]},session:{id:options.sessionId||options.resumeSessionId,seq:0,eventAt:()=>null},followup:m=>calls.push(m)};
  const ctx={tools:{register:d=>tools.set(d.name,d),restrict(){},guard(fn){ctx.guard=fn;}},systemPrompt:{section:s=>sections.push(s)},effect(){},on(){}};
  agent.ctx=ctx;await options.setup(ctx,agent);const h={agent,tools,sections,dispose(){}};agents.push(h);return h;
 };
 const driver={supportsAck:true,isTrustedNativeRead:r=>trusted.has(r),call:async(op,args)=>{
  if(op==='read')return next;
  if(op==='ack')return {status:'ok'};
  throw Error('UNEXPECTED_DRIVER_OPERATION '+op);
 }};
 const savedHost={fileRoot,accountId:'account',timeoutMs:15000,verifyBinding:r=>receipts.has(r),async resolveSavedFile({message,read}){
  if(message.nativeRef?.kind!=='file')return null;
  assert.ok(trusted.has(read)&&read.nativeCurrent.includes(message));received.push({message,read});
  const bytes=fs.readFileSync(path.join(fileRoot,message.nativeRef.name));
  const receipt={kind:'native-saved-file',mappingMethod:'native-file-id',completed:true,sourceMessageId:message.id,
   readId:read.readId,generation:read.generation,accountId:'account',nativeFileId:message.id,displayName:message.nativeRef.name,
   relativePath:message.nativeRef.name,expectedBytes:bytes.length,sha256:sha(bytes),exclusiveRead:true,
   fileIdentity:{scheme:process.platform==='win32'?'windows-file-id-v1':'posix-stat-v1',device:'1',inode:'2'},
   ownerBindingId:bridge.core.state(owner.id).binding,chatId:owner.id};receipts.add(receipt);return receipt;
 }};
 const imageHost={withReadLease:fn=>fn(),async evidenceForRead({chatId,message,read,scope}){return {chatId,messageId:message.id,sourceKey:message.sourceKey,readId:read.readId,generation:read.generation,binding:scope.binding,role:'user',kind:'image',state:'ready',exactImageBounds:true,unobscured:true,imageBounds:{x:0,y:0,width:1,height:1},viewportBounds:{x:0,y:0,width:1,height:1}};},isCurrent:async()=>true,async capture(evidence){return {evidence,readId:evidence.readId,generation:evidence.generation,frame:{bounds:evidence.viewportBounds,rgba:Buffer.from([1,2,3,255])}};}};
 bridge=await createBridge({agents:{create,resume:create},sessions:{flush:async()=>true},attachments:{admitPromptContent:async blocks=>{
  assert.equal(blocks[0].type,'image');return [{type:'image',attachment:{id:'synthetic-image'}}];
 }}},{stateDir:root,mode:'mock',chats:[owner,group],model:{provider:'synthetic',model:'synthetic'},autoImages,autoFiles},
 {driver,defineTool:x=>x,savedFileHost:savedHost,imageHost,savedFileWorker:async request=>{
  const bytes=fs.readFileSync(path.join(request.root,request.relativePath));
  return {base64:bytes.toString('base64'),bytes:bytes.length,sha256:sha(bytes),extension:path.extname(request.relativePath),fileIdentity:request.fileIdentity,exclusiveRead:true};
 },ownerServices:{worker:async request=>{parsed.push(request);return {text:'SYNTHETIC PARSER PORT',truncated:false};}}});
 bridge.core.resume();
 function read(rows){next={status:'ok',identityVersion:'uia-row-v2',readId:'synthetic-read-'+(++seq),generation:seq,messages:rows.map(r=>({...r})),nativeCurrent:rows.map(r=>({...r,readId:'synthetic-read-'+seq,generation:seq}))};trusted.add(next);return next;}
 function file(ext,index=0){const name='same-name-'+index+'.'+ext;fs.writeFileSync(path.join(fileRoot,name),'SYNTHETIC '+ext+' '+index);return {id:sha(name+'-'+seq),text:'SYNTHETIC file card',role:'user',nativeRef:{kind:'file',name}};}
 return {bridge,calls,agents,received,parsed,read,file,root,async invoke(h,name,args={}){return h.tools.get(name).execute(args,{agent:h.agent,callId:crypto.randomUUID()});}};
}

for(const ext of formats)test(ext+' traverses exact-read receipt, shared registry, owner descriptor and parser port',async t=>{
 const f=await fixture(t);f.read([]);await f.bridge.core.poll('owner');
 const row=f.file(ext),batch=f.read([row]);await f.bridge.core.poll('owner');
 assert.equal(f.received.length,1);assert.equal(f.received[0].read,batch);
 const descriptor=f.bridge.ownerAttachments.registered()[0];assert.equal(descriptor.sourceMessageId,row.id);
 assert.ok(f.calls.some(m=>m.content.some(b=>b.text?.includes(descriptor.attachmentId))));
 const h=f.bridge.core.handles.get('owner');await f.invoke(h,'owner_attachment_read',{attachmentId:descriptor.attachmentId});
 assert.equal(f.parsed[0].extension,'.'+ext);assert.equal(Buffer.from(f.parsed[0].base64,'base64').toString(),'SYNTHETIC '+ext+' 0');
 await f.bridge.core.poll('owner');assert.equal(f.received.length,1);
});

test('startup baselines never receive or replay historical files',async t=>{
 const f=await fixture(t);f.read([f.file('txt')]);await f.bridge.core.poll('owner');assert.equal(f.received.length,0);assert.equal(f.calls.length,0);
});
test('same display name in later batches preserves separate attachment bytes',async t=>{
 const f=await fixture(t);f.read([]);await f.bridge.core.poll('owner');
 const first=f.file('txt');f.read([first]);await f.bridge.core.poll('owner');
 const second=f.file('txt');fs.writeFileSync(path.join(f.root,'account','FileStorage','File',second.nativeRef.name),'SYNTHETIC REPLACEMENT');
 f.read([second]);await f.bridge.core.poll('owner');
 const rows=f.bridge.ownerAttachments.registered();assert.equal(rows.length,2);assert.notEqual(rows[0].attachmentId,rows[1].attachmentId);
 const binding=f.bridge.core.state('owner').binding;
 assert.equal(Buffer.from(f.bridge.ownerAttachments.attachments.read(rows[0].attachmentId,binding).base64,'base64').toString(),'SYNTHETIC txt 0');
 assert.equal(Buffer.from(f.bridge.ownerAttachments.attachments.read(rows[1].attachmentId,binding).base64,'base64').toString(),'SYNTHETIC REPLACEMENT');
});
test('group files/images are refused and receive neither owner tool',async t=>{
 assert.equal(allowedTools(group,{describeImage:()=>{}}).has('wechat_describe_image'),false);
 assert.throws(()=>authorize(group,'wechat_describe_image'),/OWNER_IMAGE_REQUIRED/);
 const f=await fixture(t,{autoImages:true});f.read([]);await f.bridge.core.poll('group');
 const row=f.file('txt');row.imageAvailable=true;row.sourceKey='synthetic-image';f.read([row]);await f.bridge.core.poll('group');
 assert.equal(f.received.length,0);assert.equal(f.bridge.ownerAttachments.registered().length,0);
 const h=f.bridge.core.handles.get('group');assert.equal(h.tools.has('owner_attachment_read'),false);assert.equal(h.tools.has('owner_sessions_status'),false);
 assert.equal(h.agent.ctx.guard({name:'owner_attachment_read'}),'WECHAT_TOOL_SCOPE_DENIED');
 assert.equal(f.calls[0].content.some(b=>b.type==='image'),false);assert.match(f.calls[0].content[0].text,/OWNER_IMAGE_REQUIRED/);
});
test('owner images are native blocks on the original agent followup',async t=>{
 const f=await fixture(t,{autoImages:true});f.read([]);await f.bridge.core.poll('owner');
 f.read([{id:sha('image'),text:'SYNTHETIC image',role:'user',imageAvailable:true,sourceKey:'synthetic'}]);await f.bridge.core.poll('owner');
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].content[1].type,'image');assert.match(f.calls[0].content[0].text,/"pixelsDelivered":true/);
});
test('new rotation agent registers both tools; retired and foreign agents cannot use them',async t=>{
 const f=await fixture(t);const old=await f.bridge.core.handle('owner');
 const next=await f.bridge.core.openHandle('owner',{sessionId:'synthetic-rotated',created:false});
 for(const name of ['owner_attachment_read','owner_sessions_status'])assert.ok(next.tools.has(name));
 await assert.rejects(()=>f.invoke(next,'owner_sessions_status'),/OWNER_ONLY/);
 f.bridge.core.handles.set('owner',next);f.bridge.core.state('owner').sessionId='synthetic-rotated';
 const status=await f.invoke(next,'owner_sessions_status');assert.equal(status.readOnly,true);
 await assert.rejects(()=>f.invoke(old,'owner_sessions_status'),/OWNER_ONLY/);
 await assert.rejects(()=>f.invoke(old,'owner_attachment_read',{attachmentId:'synthetic'}),/OWNER_AUTHORITY_REVOKED/);
 await assert.rejects(()=>next.tools.get('owner_attachment_read').execute({attachmentId:'synthetic'},{agent:old.agent,callId:'synthetic'}),/OWNER_AGENT_MISMATCH/);
});
test('saved-file host rejects fabricated batches and never retries an unknown receive',async t=>{
 const root=temporary(t),message={id:sha('saved'),role:'user',readId:'r',generation:1,nativeRef:{kind:'file'}};
 const read={readId:'r',generation:1,nativeCurrent:[message]};let dispatches=0;
 const driver={isTrustedNativeRead:r=>r===read,withNativeFileLease:async()=>{dispatches++;throw Error('SYNTHETIC_UNKNOWN');}};
 const options={fileRoot:root,accountId:'synthetic',ownerChatId:'owner',ownerBindingId:'binding',ledgerPath:path.join(root,'ledger.json'),isOwnerActive:()=>true};
 let host=createDriverSavedFileHost(driver,options);
 assert.throws(()=>host.resolveSavedFile({chat:owner,message,read:{...read}}),/SAVED_FILE_READ_UNTRUSTED/);
 await assert.rejects(()=>host.resolveSavedFile({chat:owner,message,read}),/SYNTHETIC_UNKNOWN/);
 host=createDriverSavedFileHost(driver,options);
 await assert.rejects(()=>host.resolveSavedFile({chat:owner,message,read}),/SAVED_FILE_OUTCOME_UNKNOWN/);assert.equal(dispatches,1);
});
test('file acquisition holds the single driver FIFO until completion',async t=>{
 const root=temporary(t),driver=new DurableDriverClient({targets:[owner],stateDir:root});const order=[];let release,started;
 const begun=new Promise(r=>started=r),pending=new Promise(r=>release=r);
 driver._performCall=async op=>{order.push(op);return {status:'ok'};};
 const file=driver.withNativeFileLease(async send=>{started();await pending;await send('saved_file_acquire',{targetId:'owner'});});
 await begun;const read=driver.call('read',{targetId:'owner'});assert.deepEqual(order,[]);release();await Promise.all([file,read]);assert.deepEqual(order,['saved_file_acquire','read']);await driver.close();
});
for(const script of ['attachment_readers.py','attachment_native.py'])test('offline Python contracts: '+script,t=>{
 const python=process.env.XQ_TEST_PYTHON;
 if(!python){t.skip('XQ_TEST_PYTHON unavailable; parser execution remains unverified');return;}
 const result=spawnSync(python,['-B',fileURLToPath(new URL('./'+script,import.meta.url))],{encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
});
