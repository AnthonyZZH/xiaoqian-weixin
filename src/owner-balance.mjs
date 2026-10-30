import fs from 'node:fs';import path from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';import crypto from 'node:crypto';
import {createOwnerToolkit} from '../vendor/owner-tools/index.mjs';
export function isOwnedProviderShim(name,stateDir){
 try{const u=new URL(name);if(u.protocol!=='file:')return false;const file=fileURLToPath(u),root=fs.realpathSync(path.join(stateDir,'provider-shim')),base=path.basename(file),match=/^provider-shim-([a-f0-9]{24})\.mjs$/.exec(base);if(!match||fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>1024*1024||fs.realpathSync(path.dirname(file))!==root)return false;return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').startsWith(match[1]);}catch{return false;}
}
export function selectOfficialProviderEntries(entries,{shimFile,stateDir}){
 return [...entries].filter(e=>e.options&&e.options.disabled!==true&&(e.options.name==='@deepseek-ai/dsh-llm-deepseek-api-key'||e.options.name===pathToFileURL(shimFile).href||isOwnedProviderShim(e.options.name,stateDir)));
}
export function createOwnerBalance({hostCtx,getCore,isCurrentOwner,stateDir,shimFile}){
 const entries=new Map();let capability=null,closed=false;
 const proof=(name,value)=>fs.writeFileSync(path.join(stateDir,name),JSON.stringify(value));
 const getProvider=async()=>{
  const facts=capability?.describe();if(!facts?.officialOrigin||!facts.tlsVerification)return null;
  return {kind:'deepseek-official',baseURL:facts.baseURL,requestOfficialBalance:request=>capability.requestOfficialBalance(request)};
 };
 const register=async e=>{
  if(closed||e.bound||!capability)return;
  const facts=capability.describe();proof('owner-balance-origin-proof.json',{at:new Date().toISOString(),...facts,credentialReadByBridge:false});
  const kit=await createOwnerToolkit({isCurrentOwner,getProvider});if(!kit.available().includes('owner_balance'))return;
  if(closed||!entries.has(e.agent))return;e.bound=kit.bind({agent:e.agent,bindingId:e.bindingId});
  e.bound.register(e.ctx,definition=>e.defineTool({...definition,async execute(args,exec){const value=await e.bound.execute('owner_balance',args,exec);return {...value,queriedAt:new Date().toISOString()};}}));
  getCore().capabilities.ownerNativeTools=[...new Set([...(getCore().capabilities.ownerNativeTools||[]),'owner_balance'])];
  e.ctx.systemPrompt?.section?.({name:'owner-api-balance',order:318,text:'owner_balance reads the current official API-key balance only. It cannot recharge, pay, change credentials or query personal finances. Report returned currency/is_available/time; a failed query is not a zero balance.'});

 };
 hostCtx.inject(['xiaoqianOfficialBalance'],inner=>{const value=inner.xiaoqianOfficialBalance;capability=value;for(const e of entries.values())void register(e).catch(()=>{});inner.effect(()=>()=>{if(capability===value)capability=null;for(const e of entries.values()){e.bound?.revoke();e.bound=null;}});});
 // Update only this existing profile entry's module name. Its config/credential references remain untouched.
 hostCtx.inject(['loader'],inner=>{void(async()=>{
  const rows=selectOfficialProviderEntries(inner.loader.entries(),{shimFile,stateDir});
  if(rows.length!==1){proof('owner-balance-shim-status.json',{at:new Date().toISOString(),ok:false,code:'OFFICIAL_PROVIDER_ROW_NOT_UNIQUE',count:rows.length});return;}
  const row=rows[0],target=pathToFileURL(shimFile).href,originalName=row.options.name;
  proof('owner-balance-shim-status.json',{at:new Date().toISOString(),state:'loading',entryId:row.id,originalName,shim:target});
  if(originalName!==target){await row.fiber?.dispose();await row.update({name:target});await row.init();await row.fiber?.await();}
  for(let i=0;i<60&&!capability;i++)await new Promise(r=>setTimeout(r,50));
  if(!capability){if(originalName!==target){await row.fiber?.dispose();await row.update({name:originalName});await row.init();await row.fiber?.await();}proof('owner-balance-shim-status.json',{at:new Date().toISOString(),ok:false,code:'SHIM_CAPABILITY_UNAVAILABLE',originalEntryRestored:true});return;}
  proof('owner-balance-shim-status.json',{at:new Date().toISOString(),ok:true,entryId:row.id,originalName,shim:target,originalConfigUnchanged:true});
 })().catch(()=>proof('owner-balance-shim-status.json',{at:new Date().toISOString(),ok:false,code:'PROVIDER_SHIM_LOAD_FAILED'}));});
 return {available:()=>['owner_balance'],register({ctx,agent,bindingId,defineTool}){const e={ctx,agent,bindingId,defineTool,bound:null};entries.set(agent,e);void register(e).catch(()=>{});ctx.effect(()=>()=>{e.bound?.revoke();entries.delete(agent);});},close(){closed=true;for(const e of entries.values())e.bound?.revoke();entries.clear();}};
}
