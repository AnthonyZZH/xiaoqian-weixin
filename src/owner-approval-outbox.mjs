import fs from 'node:fs';
import path from 'node:path';
import {atomicWrite} from './state.mjs';

// Host-only, operation-scoped notification delivery. No replay of ambiguous sends.
export function createApprovalOutbox({stateDir,getCore,isCurrentOwner,clock=Date.now}){
 const unavailable=()=>({async notify(){return{status:'rejected',code:'APPROVAL_OUTBOX_STATE_UNAVAILABLE'}},close(){},snapshot(){return{available:false,code:'APPROVAL_OUTBOX_STATE_UNAVAILABLE'}}});
 const file=path.join(stateDir,'owner-approval-outbox.json');let rows;
 try{fs.mkdirSync(stateDir,{recursive:true});if(fs.existsSync(file)){const st=fs.lstatSync(file);if(st.isSymbolicLink()||st.nlink!==1||st.size>10*1024*1024)throw Error('STATE_INVALID');rows=JSON.parse(fs.readFileSync(file,'utf8'));}else rows={};
  if(!rows||Object.getPrototypeOf(rows)!==Object.prototype||Object.keys(rows).length>10000)throw Error('STATE_INVALID');
  for(const [id,row]of Object.entries(rows))if(!/^owner-approval-prompt:[A-Za-z0-9_-]{1,100}$/.test(id)||!row||!['queued','sending','ok','rejected','unknown','cancelled'].includes(row.status))throw Error('STATE_INVALID');
 }catch{return unavailable();}
 const flights=new Map(),controllers=new Set();let closed=false;
 const save=()=>atomicWrite(file,rows);
 for(const row of Object.values(rows)){if(row.status==='sending')row.status='unknown';else if(row.status==='queued')row.status='cancelled';delete row.text;}
 try{save();}catch{return unavailable();}
 return{async notify(prompt,principal){
  if(closed||!await isCurrentOwner(principal))return{status:'rejected'};
  const core=getCore(),chat=core?.chats.get(prompt.chatId),id=prompt.deliveryId;
  if(chat?.owner!==true||chat.mode!=='private'||!/^owner-approval-prompt:[A-Za-z0-9_-]{1,100}$/.test(id||'')||typeof prompt.text!=='string'||prompt.text.length>6000)return{status:'rejected'};
  // One bounded driver operation: a multiline prompt must not monopolize the
  // global core queue with one UI send per line. Larger reviews use native Web.
  const text=prompt.text.replace(/\r?\n/g,'；');
  if(Array.from(text).length>Math.min(1000,core.driver?.maxChars||1000))return{status:'rejected',code:'APPROVAL_PROMPT_REQUIRES_WEB'};
  if(flights.has(id))return flights.get(id);
  if(rows[id])return{status:rows[id].status,duplicate:true};
  if(Object.keys(rows).length>=10000)return{status:'rejected',code:'APPROVAL_OUTBOX_CAPACITY'};
  const expiry=Date.parse(prompt.expiresAt);if(!Number.isFinite(expiry)||expiry<=clock()||expiry-clock()>90000)return{status:'rejected'};
  rows[id]={status:'queued',chatId:prompt.chatId,expiresAt:prompt.expiresAt};save();
  const controller=new AbortController();controllers.add(controller);
  const timer=setTimeout(()=>controller.abort(),Math.max(1,expiry-clock()));
  const work=Promise.resolve().then(async()=>{
   if(closed||controller.signal.aborted||!await isCurrentOwner(principal)){rows[id].status='cancelled';save();return{status:'rejected'};}
   rows[id].status='sending';save();
   let result;try{result=await core.send(prompt.chatId,{text,deliveryId:id},{signal:controller.signal,preservePendingWake:true});}catch{result={status:'unknown'};}
   rows[id].status=['ok','rejected'].includes(result?.status)?result.status:'unknown';rows[id].at=new Date(clock()).toISOString();save();
   return{status:rows[id].status};
  }).finally(()=>{clearTimeout(timer);controllers.delete(controller);flights.delete(id);});
  flights.set(id,work);return work;
 },close(){closed=true;for(const c of controllers)c.abort();},snapshot(){return structuredClone(rows);}};
}
