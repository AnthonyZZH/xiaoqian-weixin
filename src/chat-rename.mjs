// Follows a group that was renamed in WeChat, without anyone editing the configuration.
// The driver records which chats the conversation list shows (session-names.json). When the group can no longer
// be opened under its known name and exactly one unknown name has appeared since the list last contained it,
// that name is tried. The driver still checks that the opened chat really is a group; if reads keep failing
// under the new name the change is undone and that name is not tried again.
import fs from 'node:fs';
import path from 'node:path';
import {isFailedPoll} from './chat-reach.mjs';

const readJson=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}};
const validName=n=>typeof n==='string'&&n.trim().length>0&&n.length<=200&&!/[\r\n]/.test(n);

/** The single name that is new since the list last showed `shown`, or null when there is none or more than one. */
export function renameCandidate(snapshot,shown,configured){
 const current=snapshot?.current?.names,before=snapshot?.lastSeen?.[shown]?.names;
 if(!Array.isArray(current)||!Array.isArray(before)||current.includes(shown))return null;
 const fresh=current.filter(n=>!before.includes(n)&&!configured.includes(n)&&validName(n));
 return fresh.length===1?fresh[0]:null;
}
export const aliasFile=stateDir=>path.join(stateDir,'chat-aliases.json');
/** Names learned earlier, applied over the configured chats at startup. An alias only applies while the
 *  configuration still says what it said when the alias was learned: a later manual edit of the configuration wins. */
export function applyChatAliases(chats,stateDir){
 const aliases=readJson(aliasFile(stateDir),{});
 return chats.map(c=>{
  const alias=aliases?.[c?.id];
  if(c?.mode!=='group'||!validName(alias?.name)||alias.over!==(c.wechatName||c.title))return c;
  const {wechatName,...rest}=c;return alias.name===c.title?rest:{...rest,wechatName:alias.name};
 });
}

/** chats: as running now (aliases applied). configured: chat id → the name the configuration file gives. */
export function createRenameFollower({chats,configured=new Map(chats.map(c=>[c.id,c.wechatName||c.title])),stateDir,driver,audit=()=>{},report=()=>{},wake,minFailures=3,giveUpAfter=8}){
 const names=new Map(chats.map(c=>[c.id,c.wechatName||c.title])),owner=chats.find(c=>c.owner&&c.mode==='private'),rows=new Map();
 function save(id){
  const file=aliasFile(stateDir),all=readJson(file,{});
  if(names.get(id)===configured.get(id))delete all[id];else all[id]={name:names.get(id),over:configured.get(id),at:new Date().toISOString()};
  fs.mkdirSync(stateDir,{recursive:true});fs.writeFileSync(file+'.tmp',JSON.stringify(all,null,2));fs.renameSync(file+'.tmp',file);
 }
 async function switchTo(c,name){await driver.rename(c.id,name);names.set(c.id,name);save(c.id);}
 async function observe(c,result){
  if(c.mode!=='group'||result?.status==='paused'||typeof driver?.rename!=='function')return;
  const row=rows.get(c.id)||{failures:0,tried:new Set(),pending:null};rows.set(c.id,row);
  if(!isFailedPoll(result)){
   row.failures=0;
   if(row.pending){
    const {from,to}=row.pending;row.pending=null;
    audit('CHAT_RENAME_FOLLOWED',c.id,{});report('CHAT_RENAME_FOLLOWED',{stack:c.id+' '+from+' -> '+to});
    if(owner&&wake)Promise.resolve().then(()=>wake(owner.id,{wakeId:'renamed:'+c.id+':'+Date.now(),reason:'chat_renamed',
     note:'群「'+from+'」被改名为「'+to+'」，你已经自动跟上了，不需要任何人处理。用 wechat_reply 简短告诉主人一声。'})).catch(e=>report('CHAT_RENAME_NOTIFY_FAILED',e));
   }
   return;
  }
  row.failures++;
  try{
   if(row.pending){
    if(++row.pending.failures<giveUpAfter)return;
    const {from,to}=row.pending;row.pending=null;row.tried.add(to);row.failures=0;
    await switchTo(c,from);audit('CHAT_RENAME_REVERTED',c.id,{});report('CHAT_RENAME_REVERTED',{stack:c.id+' '+to+' did not open as this group; back to '+from});
    return;
   }
   if(row.failures<minFailures)return;
   const shown=names.get(c.id),candidate=renameCandidate(readJson(path.join(stateDir,'driver','session-names.json'),null),shown,[...names.values()]);
   if(!candidate||row.tried.has(candidate))return;
   row.pending={from:shown,to:candidate,failures:0};row.failures=0;
   await switchTo(c,candidate);audit('CHAT_RENAME_TRIED',c.id,{});
  }catch(e){report('CHAT_RENAME_FAILED',e);}
 }
 return {observe,shown:id=>names.get(id)};
}
