import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {WeChatCore} from '../../src/core.mjs';import {DurableDriverClient} from '../../driver/durable-client.mjs';
import {installScopedGroupImages} from '../../src/scoped-group-images.mjs';
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
function fixture(t){
 const parent=path.join(import.meta.dirname,'temporary-group');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'case-'));
 const chats=[{id:'fixture-owner',title:'SYNTHETIC OWNER',mode:'private',owner:true},{id:'fixture-group',title:'SYNTHETIC GROUP',mode:'group',owner:false,persona:'SYNTHETIC GROUP PERSONA'},{id:'fixture-other',title:'SYNTHETIC OTHER',mode:'group',owner:false}];
 const messages=new Map(chats.map(c=>[c.id,[]])),inputs=new Map(chats.map(c=>[c.id,[]])),calls=[];let admitted=0,core,mutation;
 const driver=new DurableDriverClient({targets:chats,startPaused:true,mediaAllowStaticCapture:true});
 driver._performCall=async(op,args)=>{
  calls.push(op);
  if(op==='read')return {status:'ok',identityVersion:'uia-row-v2',readId:'SYNTHETIC READ',generation:1,messages:messages.get(args.targetId)};
  if(op==='ack')return {status:'ok'};
  assert.ok(['image_inspect','image_capture','image_current'].includes(op),'no download, UI or new provider');
  const raw=messages.get(args.targetId).find(m=>m.id===args.messageId);assert.ok(raw);
  const bounds={x:10,y:20,width:2,height:2},data={schema:'xq.native-image/v1',ticket:'SYNTHETIC ONE USE TICKET '.repeat(3),messageId:raw.id,sourceKey:raw.sourceKey,generation:1,readId:'SYNTHETIC READ',expiresAt:Date.now()+15000,imageBounds:bounds,viewportBounds:bounds,current:true};
  if(op==='image_capture')data.rgba=Buffer.from([0,255,0,255,0,255,0,255,0,255,0,255,0,255,0,255]).toString('base64');
  return {status:'ok',data};
 };
 const attachments={async admitPromptContent(parts){admitted++;assert.equal(parts.length,1);assert.equal(parts[0].type,'image');assert.equal(parts[0].mediaType,'image/png');if(mutation)mutation();return [{type:'image',attachment:{attachmentId:'sha256:'+hash(Buffer.from(parts[0].data,'base64')),mediaType:'image/png',width:2,height:2}}];}};
 core=new WeChatCore({stateDir:root,chats,driver,model:{provider:'synthetic-original-provider',model:'synthetic-original-model'},imageInput:{prepare(){throw Error('OLD_INPUT');},content(){}},agents:{create(){throw Error('NO_ALTERNATE_AGENT');}},sessions:{async flush(){return true;}}});
 const agents=new Map();for(const chat of chats){const agent={session:{id:core.state(chat.id).sessionId},followup(m){inputs.get(chat.id).push(m);}};agents.set(chat.id,agent);core.handles.set(chat.id,{agent});core.state(chat.id).bootstrapped=true;}
 // Synthetic synchronous TEXT policy. A deployment passes its existing policy;
 // the public adapter adds no image/model-based routing decision.
 const decideTopic=(s,m,now)=>{if(m.text.includes('@FixtureBot'))s.groupTopic={id:'synthetic-topic',lastAt:now};const allow=m.text.includes('@FixtureBot')||!!s.groupTopic&&m.text==='[image]';return {allow,reason:allow?'synthetic_addressed':'not_addressed',topicId:s.groupTopic?.id};};
 const dispose=installScopedGroupImages({bridge:{core,driver},attachments,groupId:'fixture-group',decideTopic,topicIdleMs:8*60*1000});
 core.store.data.paused=false;driver.paused=false;
 t.after(async()=>{dispose();await core.close();assert.equal(path.dirname(path.resolve(root)),parent);fs.rmSync(root,{recursive:true,force:true});});
 const image=(key,text='[image]')=>({id:hash(key),sourceKey:'row-'+key,role:'user',sender:'SYNTHETIC SENDER',text,imageAvailable:true});
 return {core,driver,calls,inputs,agents,messages,image,get admitted(){return admitted;},setMutation(fn){mutation=fn;},poll(id='fixture-group'){return core.poll(id);}};
}
test('gate=false: zero evidence acquisition, screenshot, SDK admission and model-facing input; old poll stays zero',async t=>{
 const f=fixture(t);f.messages.set('fixture-group',[f.image('unaddressed')]);
 assert.equal((await f.poll()).accepted,0);await f.poll();
 assert.equal(f.calls.filter(c=>c==='image_inspect').length,0);assert.equal(f.calls.filter(c=>c==='image_capture').length,0);assert.equal(f.admitted,0);assert.equal(f.inputs.get('fixture-group').length,0);
});
test('text decision then corresponding single image once; original Agent and group authority preserved',async t=>{
 const f=fixture(t),original=f.agents.get('fixture-group');
 f.messages.set('fixture-group',[{id:hash('nomination'),role:'user',sender:'SYNTHETIC SENDER',text:'@FixtureBot image'},f.image('addressed')]);
 await f.poll();assert.equal(f.admitted,1);assert.equal(f.calls.filter(c=>c==='image_capture').length,1);assert.equal(f.inputs.get('fixture-group')[1].content[1].type,'image');
 await f.poll();assert.equal(f.admitted,1);assert.equal(f.inputs.get('fixture-group').length,2);assert.equal(f.core.handles.get('fixture-group').agent,original);assert.equal(f.core.chat('fixture-group').persona,'SYNTHETIC GROUP PERSONA');
 for(const tool of ['owner_attachment_read','owner_file_read','owner_powershell'])assert.equal(f.core.status('fixture-group').availableTools.includes(tool),false);
});
test('other configured group and paused group cannot acquire evidence or admit pixels',async t=>{
 const f=fixture(t);f.messages.set('fixture-other',[f.image('other','@FixtureBot image')]);await f.poll('fixture-other');
 f.core.state('fixture-group').groupPaused=true;f.messages.set('fixture-group',[f.image('paused','@FixtureBot image')]);await f.poll();
 assert.equal(f.admitted,0);assert.equal(f.calls.some(c=>c.startsWith('image_')),false);
});
test('topic change while SDK admission resolves cannot enqueue image pixels',async t=>{
 const f=fixture(t);f.messages.set('fixture-group',[f.image('mutated','@FixtureBot image')]);f.setMutation(()=>f.core.state('fixture-group').groupTopic.lastAt++);
 await assert.rejects(f.poll(),/IMAGE_SCOPE_REVOKED/);assert.equal(f.inputs.get('fixture-group').length,0);
});
test('owner image uses original owner Agent/provider and cannot replay on poll',async t=>{
 const f=fixture(t),agent=f.agents.get('fixture-owner');f.messages.set('fixture-owner',[f.image('owner')]);await f.poll('fixture-owner');await f.poll('fixture-owner');
 assert.equal(f.admitted,1);assert.equal(f.inputs.get('fixture-owner').length,1);assert.equal(f.inputs.get('fixture-owner')[0].content[1].type,'image');assert.equal(f.core.handles.get('fixture-owner').agent,agent);assert.equal(f.core.model.provider,'synthetic-original-provider');
});
