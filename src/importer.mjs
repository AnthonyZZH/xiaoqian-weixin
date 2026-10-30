import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {atomicJson,scopedDirectory,trustedChats} from './features.mjs';
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const check=(c,code)=>{if(!c)throw new Error(code);};
const text=(v,n)=>{check(typeof v==='string'&&v.length<=n,'IMPORT_TEXT_INVALID');return v;};
const unsafe=/ignore\s+(all|previous)|system\s*prompt|(?:执行|忽略|覆盖).{0,8}(?:指令|规则|提示)|(?:api[_ -]?key|password|密码|密钥)\s*[:：=]|\b\d{7,}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/iu;
/** Operator-only migration; never queues old history as new messages. */
export class LegacyImporter{
 constructor({features,media,archiveRoot,chats,allowedMediaRoot}){
  this.features=features;this.media=media;this.chats=trustedChats(chats);
  this.root=scopedDirectory(archiveRoot);this.mediaRoot=allowedMediaRoot?path.resolve(allowedMediaRoot):null;
 }
 safeSource(raw){
  check(this.mediaRoot&&typeof raw==='string'&&path.isAbsolute(raw),'IMPORT_MEDIA_ROOT_REQUIRED');
  const file=path.resolve(raw),rel=path.relative(this.mediaRoot,file);
  check(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel),'IMPORT_MEDIA_ESCAPE');
  let cursor=path.parse(file).root;
  for(const p of file.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,p);check(!fs.lstatSync(cursor).isSymbolicLink(),'IMPORT_MEDIA_LINK');}
  const stat=fs.statSync(file);check(stat.isFile()&&stat.size<=16*1024*1024,'IMPORT_MEDIA_SIZE');
  return file;
 }
 plan({chatId,memory={},persona='',history=[],stickers=[]}){
  check(this.chats.has(chatId),'IMPORT_CHAT_UNKNOWN');check(memory&&typeof memory==='object'&&!Array.isArray(memory),'IMPORT_MEMORY_INVALID');
  const facts=[];
  for(const [name,p]of Object.entries(memory.people||{})){
   check(p&&typeof p==='object'&&Array.isArray(p.facts||[]),'IMPORT_PERSON_INVALID');
   for(const f of p.facts||[])facts.push(text(name,30)+'：'+text(f,160));
   if(p.impression)facts.push(text(name,30)+'的印象：'+text(p.impression,160));
  }
  for(const [term,p]of Object.entries(memory.jargon||{}))facts.push(text(term,40)+'：'+text(typeof p==='string'?p:p.meaning,160));
  for(const f of memory.facts||[])facts.push(text(f,240));
  check(facts.length<=500,'IMPORT_MEMORY_TOO_LARGE');
  check(Array.isArray(history)&&history.length<=20000,'IMPORT_HISTORY_INVALID');
  const archive=history.map(r=>{check(r&&['user','assistant'].includes(r.role),'IMPORT_HISTORY_ROLE_INVALID');return {role:r.role,text:text(r.text??r.content??'',32000),sender:text(r.sender||'',200),provenance:'legacy_import_untrusted'};});
  check(Buffer.byteLength(JSON.stringify(archive),'utf8')<=8*1024*1024,'IMPORT_HISTORY_TOO_LARGE');
  check(Array.isArray(stickers)&&stickers.length<=5000,'IMPORT_STICKERS_INVALID');
  const assets=stickers.map(s=>{const sourcePath=this.safeSource(s.sourcePath);return {sourcePath,description:text(s.description||'',1000),expectedHash:crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex')};});
  const current=this.features.readMemory(chatId),safe=facts.filter(f=>!unsafe.test(f)),quarantined=facts.filter(f=>unsafe.test(f));
  const body={version:1,chatId,expectedRevision:current.revision,facts:[...new Set([...current.facts,...safe])],style:text(memory.style||current.style||'',600),persona:text(persona,12000),history:archive,assets,quarantined};
  check(!unsafe.test(body.style),'IMPORT_STYLE_REVIEW_REQUIRED');
  return {...body,digest:hash(body),summary:{facts:safe.length,quarantined:quarantined.length,history:archive.length,assets:assets.length,willReplayMessages:false}};
 }
 async apply(plan,{confirmedDigest}={}){
  const {digest,summary,...body}=plan;
  check(confirmedDigest===digest&&hash(body)===digest,'IMPORT_PLAN_UNCONFIRMED_OR_CHANGED');
  check(this.chats.has(plan.chatId),'IMPORT_CHAT_UNKNOWN');
  const marker=path.join(this.root,hash(plan.chatId)+'-'+digest+'.json');
  if(fs.existsSync(marker)){
   const prior=JSON.parse(fs.readFileSync(marker,'utf8'));
   if(prior.digest===digest&&prior.status==='completed')return {status:'already_imported',digest};
   throw new Error('IMPORT_INCOMPLETE_REQUIRES_REVIEW');
  }
  check(this.features.readMemory(plan.chatId).revision===plan.expectedRevision,'IMPORT_MEMORY_CONFLICT');
  for(const a of plan.assets)check(crypto.createHash('sha256').update(fs.readFileSync(this.safeSource(a.sourcePath))).digest('hex')===a.expectedHash,'IMPORT_ASSET_CHANGED');
  atomicJson(marker,{version:1,status:'applying',digest,chatId:plan.chatId});
  // Retain raw legacy material locally, but never give it execution privileges or replay.
  atomicJson(path.join(this.root,hash(plan.chatId)+'-history.json'),{version:1,history:plan.history,quarantined:plan.quarantined});
  const revision=this.features.editMemory(plan.chatId,{expectedRevision:plan.expectedRevision,facts:plan.facts,style:plan.style}).revision;
  if(plan.persona)this.features.setPersona(plan.chatId,plan.persona);
  const assets=[];
  for(const a of plan.assets)assets.push(await this.media.importOriginal(plan.chatId,a.sourcePath,{description:a.description}));
  atomicJson(marker,{version:1,status:'completed',digest,chatId:plan.chatId,revision,assets:assets.map(a=>a.media_id)});
  return {status:'imported',digest,...summary};
 }
}
