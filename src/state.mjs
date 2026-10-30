import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function digest(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}
function plain(v){return v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;}
function assert(c){if(!c)throw new Error('STATE_INVALID');}
export function validateState(v){
 assert(plain(v)&&v.version===1&&plain(v.chats)&&Array.isArray(v.audit)&&v.audit.length<=1000&&typeof v.paused==='boolean');
 assert(Object.keys(v.chats).length<=500);
 for(const [id,c]of Object.entries(v.chats)){
  assert(/^[A-Za-z0-9_-]{1,80}$/.test(id)&&!['__proto__','constructor','prototype'].includes(id)&&plain(c));
  assert(typeof c.sessionId==='string'&&c.sessionId.length>0&&c.sessionId.length<=200&&/^[a-f0-9]{64}$/.test(c.binding));
  assert(typeof c.created==='boolean'&&typeof c.bootstrapped==='boolean'&&plain(c.messages)&&plain(c.deliveries));
  assert(Object.keys(c.messages).length<=50000&&Object.keys(c.deliveries).length<=50000);
  for(const [k,m]of Object.entries(c.messages))assert(typeof k==='string'&&k.length<=200&&plain(m)&&['accepting','accepted','unknown','baseline','rejected'].includes(m.status));
  for(const [k,d]of Object.entries(c.deliveries))assert(k.length>0&&k.length<=200&&plain(d)&&['sending','ok','rejected','unknown'].includes(d.status));
  if(c.taskCompletions!==undefined){assert(plain(c.taskCompletions)&&Object.keys(c.taskCompletions).length<=1000);for(const [key,row]of Object.entries(c.taskCompletions))assert(/^[a-f0-9]{64}$/.test(key)&&plain(row)&&['pending','accepting','accepted','unknown'].includes(row.status)&&typeof row.principal==='string'&&plain(row.payload)&&typeof row.payload.event_id==='string'&&typeof row.payload.task_id==='string'&&JSON.stringify(row.payload).length<=24000);}
  if(c.replyPermits!==undefined){
   assert(plain(c.replyPermits)&&Object.keys(c.replyPermits).length<=50000);
   for(const [key,g]of Object.entries(c.replyPermits)){
    assert(/^[a-f0-9]{64}$/.test(key)&&plain(g)&&typeof g.nativeMessageId==='string'&&g.nativeMessageId.length>0&&g.nativeMessageId.length<=200);
    assert(['incoming','proactive'].includes(g.kind)&&Number.isSafeInteger(g.remaining)&&g.remaining>=0&&g.remaining<=5);
    assert(['open','unknown','turn-ended','skipped','followup-unknown'].includes(g.status));
    if(g.turn!==undefined)assert(Number.isSafeInteger(g.turn)&&g.turn>=0);
    if(g.wakeId!==undefined)assert(typeof g.wakeId==='string'&&g.wakeId.length>0&&g.wakeId.length<=300);
   }
  }
  if(c.sendQuarantined!==undefined)assert(typeof c.sendQuarantined==='boolean');
  if(c.replyPermit!=null)assert(plain(c.replyPermit)&&['incoming','proactive'].includes(c.replyPermit.kind)&&Number.isSafeInteger(c.replyPermit.remaining)&&c.replyPermit.remaining>=0&&c.replyPermit.remaining<=5);
  if(c.pendingWake!=null)assert(plain(c.pendingWake)&&typeof c.pendingWake.wakeId==='string'&&c.pendingWake.wakeId.length>0&&c.pendingWake.wakeId.length<=300);
 }
 for(const row of v.audit)assert(plain(row)&&typeof row.code==='string'&&row.code.length<=100&&typeof row.at==='string'&&Number.isFinite(Date.parse(row.at))&&typeof row.chat==='string'&&/^[a-f0-9]{64}$/.test(row.chat));
 return v;
}
export function atomicWrite(file,value){
 fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';let fd;
 try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value,null,2),'utf8');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(tmp,file);}
 finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
export class State{
 constructor(dir){
  this.dir=path.resolve(dir);fs.mkdirSync(this.dir,{recursive:true});
  if(fs.lstatSync(this.dir).isSymbolicLink())throw new Error('STATE_LINK_DENIED');
  this.lock=path.join(this.dir,'bridge.lock');
  try{this.fd=fs.openSync(this.lock,'wx');fs.writeFileSync(this.fd,JSON.stringify({pid:process.pid}));}
  catch{throw new Error('STATE_LOCKED_REQUIRES_OPERATOR_REVIEW');}
  this.file=path.join(this.dir,'bridge.json');
  try{
   if(fs.existsSync(this.file)){if(fs.lstatSync(this.file).isSymbolicLink()||fs.statSync(this.file).size>32*1024*1024)throw new Error('STATE_INVALID');this.data=validateState(JSON.parse(fs.readFileSync(this.file,'utf8')));}
   else this.data={version:1,chats:{},audit:[],paused:true};
  }catch(e){this.close();throw e;}
 }
 save(){validateState(this.data);atomicWrite(this.file,this.data);}
 audit(code,chatId,extra={}){this.data.audit.push({at:new Date().toISOString(),code,chat:digest(chatId),...extra});this.data.audit=this.data.audit.slice(-1000);this.save();}
 close(){if(this.fd!==undefined){fs.closeSync(this.fd);this.fd=undefined;fs.unlinkSync(this.lock);}}
}
