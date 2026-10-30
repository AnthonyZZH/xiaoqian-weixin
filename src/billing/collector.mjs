import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createCaptureFetch} from './capture-final-request.mjs';
import {measureEnvelope,METER_VERSION} from './estimated-meter.mjs';
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const controllers=new Map();
const failure=code=>Object.assign(Error(code),{code});
export function createBillingCollector({root,enabled=true}){
 if(!path.isAbsolute(root||''))throw failure('BILLING_ABSOLUTE_ROOT_REQUIRED');
 root=path.resolve(root);
 if(controllers.has(root))throw failure('BILLING_COLLECTOR_ALREADY_REGISTERED');
 fs.mkdirSync(root,{recursive:true});
 if(fs.lstatSync(root).isSymbolicLink())throw failure('BILLING_ROOT_LINK_DENIED');
 const sessions=new Map(),pending=new Map();let closed=false,on=enabled===true,writeFailures=0,settled=0;
 function save(row){
  const file=path.join(root,row.attempt_id+'.json'),temp=file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify(row),{flag:'wx',mode:0o600});fs.renameSync(temp,file);}
  catch{writeFailures++;try{fs.unlinkSync(temp);}catch{}}
 }
 const capture=createCaptureFetch({
  select:c=>!closed&&on&&sessions.has(String(c.sessionId))&&sessions.get(String(c.sessionId)).active()===true,
  observe(body,meta){
   const binding=[...sessions.values()].find(v=>v.hash===meta.session_hash);
   if(!binding||closed||!['deepseek-flash','deepseek-v4-pro'].includes(body.model))return;
   const meter=measureEnvelope(body,'historical-complete-envelope');
   const fields={...body};delete fields.messages;delete fields.system;delete fields.tools;delete fields.dsh_session_log;delete fields.dsh_plugin_packages;
   const system_sha256=sha(JSON.stringify(body.system??null)),tools_sha256=sha(JSON.stringify(body.tools??[]));
   // Strict family: a changed rendered system, tool schema, ACL or request policy breaks calibration.
   const policy_sha256=sha(JSON.stringify(binding.policy()));
   const history_policy_sha256=sha(JSON.stringify(body.messages.map(m=>({role:m.role,content:m.role==='system'?m.content:(m.content||[]).filter(v=>['tool_addition','tool_removal'].includes(v.type))})).filter(m=>m.role==='system'||m.content.length)));
   const family=sha(JSON.stringify({provider:'deepseek-official',model:body.model,system_sha256,tools_sha256,policy_sha256,history_policy_sha256,fields}));
   if(pending.size>=64){pending.clear();writeFailures++;return;}
   pending.set(meta.attempt_id,{model:body.model,family,system_sha256,tools_sha256,policy_sha256,history_policy_sha256,
    meter_input:meter.available?meter.value:null,meter_version:METER_VERSION,meter_available:meter.available});
  },
  append(row){
   const p=pending.get(row.attempt_id);
   if(!p)return;
   if(row.kind==='request_started')p.wire_bytes=row.shape?.bodyBytesDiagnostic??null;
   const base={schema:'xq.billing.collector/v1',attempt_id:row.attempt_id,session_hash:row.session_hash,request_hash:row.request_sha256,
    started_at:row.started_at,route_id:'deepseek-official/'+p.model,...p};
   if(row.kind==='request_started'){save({...base,status:'started',complete:false});return;}
   if(!['actual_usage','usage_unavailable'].includes(row.kind))return;
   pending.delete(row.attempt_id);settled++;
   // Fixed numeric whitelist: never write a raw event, payload, headers, exception or URL.
   const u=row.usage||{};
   const usage={hit:u.cacheReadTokens??null,miss:u.inputTokens??null,write:u.cacheWriteTokens??null,output:u.outputTokens??null};
   const complete=row.complete===true&&p.meter_available===true&&Object.values(usage).every(v=>Number.isSafeInteger(v)&&v>=0);
   save({...base,status:complete?'settled':'unavailable',complete,completed_at:new Date().toISOString(),usage,
    field_presence:Object.fromEntries(Object.entries(usage).map(([k,v])=>[k,v!==null])),
    reason:complete?'provider_cumulative_final':(['transport_unknown','http_or_empty_body','stream_unknown','consumer_cancelled_unknown','eof','provider_terminal'].includes(row.reason)?row.reason:'unavailable'),
    cache_semantics:'input_tokens_is_uncached;cache_read_and_creation_are_separate;cumulative_replace',
    pricing_attribution:'use_started_at_and_completed_at_with_trusted_tariff;cross_band_hold',
    forecastPermission:false});
  }
 });
 const api={
  register({sessionId,active,policy}){
   if(closed||typeof active!=='function'||typeof policy!=='function')throw failure('BILLING_HOST_BINDING_REQUIRED');
   const id=String(sessionId);if(!id||sessions.has(id))throw failure('BILLING_SESSION_ALREADY_REGISTERED');
   const binding={hash:sha(id),active,policy};sessions.set(id,binding);
   let disposed=false;return ()=>{if(!disposed){disposed=true;if(sessions.get(id)===binding)sessions.delete(id);}};
  },
  fetch(baseFetch,context,url,init){
   let u;try{u=new URL(url);}catch{return baseFetch(url,init);}
   if(u.origin!=='https://api.deepseek.com'||!/^\/anthropic\/(v1\/)?messages$/.test(u.pathname)||context.provider!=='deepseek-official'||!['deepseek-flash','deepseek-v4-pro'].includes(context.model))return baseFetch(url,init);
   return capture(baseFetch,context,url,init);
  },
  owns(sessionId){const b=sessions.get(String(sessionId));try{return !closed&&on&&!!b&&b.active()===true;}catch{return false;}},
  setEnabled(value){if(closed)throw failure('BILLING_COLLECTOR_CLOSED');on=value===true;},
  status(){return {schema:'xq.billing.collector.status/v1',enabled:on&&!closed,registeredSessions:sessions.size,pending:pending.size,settled,writeFailures,automaticRotationEnabled:false};},
  close(){if(closed)return;closed=true;on=false;sessions.clear();pending.clear();controllers.delete(root);}
 };
 controllers.set(root,api);return api;
}
export function billingProviderFetch(baseFetch,context,url,init){
 // Exactly one collector can select an active session. More than one is a configuration error; do not duplicate billing records.
 const matches=[...controllers.values()].filter(c=>c.owns?.(context.sessionId));
 if(matches.length!==1)return baseFetch(url,init);
 return matches[0].fetch(baseFetch,context,url,init);
}
