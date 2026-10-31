import {createCachedMarket,COMMUNITY_INDEXES} from '../vendor/owner-tools/plugin-management/community-market-cached.mjs';
import {createOwnerManagementJobs} from './owner-management-jobs.mjs';
import {createApprovalOutbox} from './owner-approval-outbox.mjs';
import {createWechatApproval} from '../vendor/owner-tools/plugin-management/wechat-approval.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createPluginManager} from '../vendor/owner-tools/plugin-management/index.mjs';
import {apply as provideNativeServices,discoverConfiguredMcp} from '../vendor/owner-tools/plugin-management/native-host.mjs';
import {createMcpManager,createConfigStore} from '../vendor/owner-tools/mcp-management/index.mjs';

export function createOwnerNativeManagement({hostCtx,isCurrentOwner,stateDir,nativePackageRoot,getCore,python='python',marketFactory=createCachedMarket,acceptanceChecks=false}){
 const slots={pluginManager:null,pluginMarket:null,loader:null},entries=new Map(),calls=new AsyncLocalStorage();
 for(const key of Object.keys(slots))hostCtx.inject([key],inner=>{const value=inner[key];slots[key]=value;inner.effect(()=>()=>{if(slots[key]===value)slots[key]=null;});});
 const market=marketFactory({cacheDir:path.join(stateDir,'owner-market-cache'),python,canonicalGithubApi:true});
 const trusted=new WeakSet();
 const outbox=createApprovalOutbox({stateDir,getCore,isCurrentOwner});
 const jobs=createOwnerManagementJobs({hostCtx,stateDir,nativePackageRoot,isCurrentOwner,onFinished(job,row){return outbox.notify({chatId:job.chatId,deliveryId:'owner-approval-prompt:result-'+job.id,expiresAt:new Date(Date.now()+90000).toISOString(),text:'主人管理任务 '+job.id+'：'+(row.state==='completed'?'宿主操作已返回，实际安装/连接状态仍应核对原生列表。':row.state==='unknown'?'结果不确定，不会自动重试；请核对原生列表。':'操作已结束且未获确认执行。')+' 状态：'+row.state+'；结果：'+(row.nativeOutcome||row.code||'未确认')+'。不会自动增加构建权限、凭据或重启宿主。'},job.principal);},createBroker(job,{ctx,agent,onWaiting,onPrompt,onApproved}){
  const authorized=()=>{const parent=entries.get(job.principal.agent);return !!parent&&isCurrentOwner(job.principal)===true&&parent.ctx.get('approval')?.effectivePolicy?.(parent.agent)==='ask';};
  const broker=createWechatApproval({ctx,agent,bindingId:job.principal.bindingId,ownerChatId:job.chatId,isCurrentOwner:authorized,isTrustedOwnerInbound:event=>trusted.has(event),notifyOwner:prompt=>{onPrompt(prompt);return outbox.notify(prompt,job.principal);}});
  return {...broker,async confirmOwnerRequest(request,exec){if(!authorized())throw Error('APPROVAL_REJECTED_BY_OWNER_POLICY');onWaiting(request.requestId);const result=await broker.confirm({...request,ownerJob:{jobId:job.id,parentSessionId:job.principal.agent.session.id}}, {...exec,agent},ctx.get('approval'));if(!authorized())throw Error('OWNER_AUTHORITY_REVOKED');onApproved();return result;}};
 }});
 const proof=(name,value)=>fs.writeFileSync(path.join(stateDir,name),JSON.stringify(value));
 const confirmation=async request=>{
  const exec=calls.getStore(),e=entries.get(request.agent);
  if(!e||exec?.agent!==e.agent||!await isCurrentOwner({agent:e.agent,bindingId:e.bindingId}))throw Error('OWNER_ONLY');
  if(!exec.job?.broker)throw Error('WORKER_APPROVAL_CONTEXT_REQUIRED');
  return exec.job.broker.confirmOwnerRequest(request,exec);
 };
 const plugins=createPluginManager({ctx:slots,isOwner:isCurrentOwner,confirmChange:confirmation});
 return {managedSessionRows:()=>jobs.sessionRows(),available:()=>['owner_plugins','owner_mcp'],async consumeOwnerApproval({chatId,message}){
  if(!getCore()?.isTrustedDriverMessage(message)||!/^(同意|拒绝|网页审批) [A-Za-z0-9_-]{1,100} [a-f0-9]{16}$/.test(message.text.trim()))return{consumed:false};
  const event={chatId,mode:'private',role:'user',origin:'wechat-driver',text:message.text};trusted.add(event);return jobs.consume({chatId,event});
 },accepts(chatId,name){const e=[...entries.values()].find(e=>e.chatId===chatId);return !!e&&e.mcp.acceptsToolName(name);},register({ctx,agent,bindingId,chatId,defineTool}){
  const plugin=plugins.bind(agent,bindingId),mcp=createMcpManager({ownerCtx:ctx,agent,bindingId,isOwner:isCurrentOwner,confirmChange:confirmation,store:createConfigStore(path.join(stateDir,'owner-mcp',bindingId)),nativePackageRoot});
  const e={ctx,agent,bindingId,chatId,mcp,plugin};entries.set(agent,e);
  const auth=async exec=>{if(exec?.agent!==agent||!await isCurrentOwner({agent,bindingId}))throw Error('OWNER_ONLY');};
  const invokePlugin=async(args,exec)=>{
   await auth(exec);
   if(args.action==='status')return jobs.status({agent,bindingId},args.jobId);
   if(['install','enable'].includes(args.action)){args=structuredClone(args);return jobs.submit({principal:{agent,bindingId},chatId,kind:'plugin',action:args.action,callId:exec.callId,args,run:context=>{const nativeExec={...context,agent,job:context.job};return calls.run(nativeExec,()=>plugin.invoke(args.action,args,nativeExec));}});}
   let result;
   if(args.action==='indexes'){result={nativeMarketAvailable:!!slots.pluginMarket,native:slots.pluginMarket?await slots.pluginMarket.listIndexes():[],community:COMMUNITY_INDEXES,note:'Native market availability and community sources are separate. An absent native service does not mean the listed community indexes are unavailable.'};}
   else if(args.action==='search'&&args.installedOnly!==true&&(!args.indexUrl||COMMUNITY_INDEXES.some(v=>v.url===args.indexUrl))){result=await market.search({query:args.query,indexUrl:args.indexUrl,signal:exec.signal});}
   else if(args.action==='search'&&!args.indexUrl){
    if(!slots.pluginManager)throw Error('MANAGER_UNAVAILABLE');
    const q=String(args.query||'').toLowerCase();const list=await plugin.invoke('list',{},exec);
    result={scope:'installed-only',bundles:list.bundles.filter(b=>b.name.toLowerCase().includes(q)),marketAvailable:!!slots.pluginMarket,instruction:'For market search, choose an existing configured indexUrl. No source is added automatically.'};
   }else result=await calls.run(exec,()=>plugin.invoke(args.action,args,exec));
   await auth(exec);return result;
  };
  const invokeMcp=async(args,exec)=>{
   await auth(exec);
   if(args.action==='status')return jobs.status({agent,bindingId},args.jobId);
   if(['add','start','stop'].includes(args.action)){args=structuredClone(args);return jobs.submit({principal:{agent,bindingId},chatId,kind:'mcp',action:args.action,callId:exec.callId,args,run:context=>{const nativeExec={...context,agent,job:context.job};return calls.run(nativeExec,()=>mcp.invoke(args.action,args,nativeExec));}});}
   if(args.action==='discover')return {profile:discoverConfiguredMcp(slots),ownerManaged:await mcp.invoke('list',{},exec),credentialsHidden:true,libraryConnectivityInferredFromMcpList:false,note:'This registry does not enumerate independent xiaoqian_library_* adapters. Use xiaoqian_library_health to determine main-library connectivity; an empty managed registry does not mean the library is disconnected.'};
   const result=await calls.run(exec,()=>mcp.invoke(args.action,args,exec));await auth(exec);return result;
  };
  plugin.register(ctx,definition=>defineTool({...definition,parameters:{...definition.parameters,installedOnly:{type:'boolean'},jobId:{type:'string'}},execute:invokePlugin}));
  mcp.register(ctx,definition=>defineTool({...definition,parameters:{...definition.parameters,jobId:{type:'string'}},description:definition.description+' discover reads profile declaration metadata without credentials. Writes return a background jobId immediately; status(jobId) reads it. A concrete one-shot native approval is notified only to the verified owner private chat, with native Web fallback for unsupported full reviews. No auto-approval.',execute:invokeMcp}));
  ctx.systemPrompt?.section?.({name:'owner-native-management',order:316,text:'owner_plugins supports list/indexes/search/inspect/install/enable. enable requires exact entryId from list. Search defaults to the existing community catalog, clearly third-party; installedOnly=true searches installed bundles. indexes reports exact sources. Catalog data never authorizes installation. owner_mcp supports discover/list/add/start/stop. Writes return jobId immediately: never wait in the foreground. Use action=status plus jobId for progress. The owner receives the exact requestId/action/version/source/expiry and nonce command; only the host verifies the owner response. Unknown third-party code always requires this specific confirmation. Existing installed bundles are reused. Full stdio or enable details may require native Web approval. Never invent a confirmation command or approve yourself. Never auto-approve scripts or pass credentials. Native stdio MCP runs as the host account, not an isolated shell.'});
  ctx.effect(()=>()=>{jobs.revoke({agent,bindingId});plugin.revoke();void mcp.revoke();entries.delete(agent);});

  const marketProof=path.join(stateDir,'owner-community-market-live-proof.json');
  if(acceptanceChecks&&!fs.existsSync(marketProof)){
   proof('owner-community-market-live-proof.json',{at:new Date().toISOString(),state:'started'});
   void invokePlugin({action:'search',query:'dsh-market'},{agent,callId:'host-community-market-readonly'}).then(result=>proof('owner-community-market-live-proof.json',{at:new Date().toISOString(),ok:result.ok===true,scope:result.scope,indexUrl:result.indexUrl,catalogCount:result.catalogCount,total:result.total,returned:result.items?.length,bytes:result.bytes,official:false,newInstalls:0,modelCalls:0})).catch(error=>proof('owner-community-market-live-proof.json',{at:new Date().toISOString(),ok:false,code:error.message}));
  }
  const target=path.join(stateDir,'owner-native-management-live-proof.json');
  if(acceptanceChecks&&!fs.existsSync(target)){
   proof('owner-native-management-live-proof.json',{at:new Date().toISOString(),state:'started'});
   void(async()=>{
    for(let n=0;n<30&&!slots.pluginManager;n++)await new Promise(r=>setTimeout(r,100));
    const exec={agent,callId:'host-owner-management-readonly'};
    // All acceptance operations are local reads; inspect an installed spec exits already-installed before registry IO.
    const list=await invokePlugin({action:'list'},exec),search=await invokePlugin({action:'search',query:'dsh-market',installedOnly:true},exec),inspection=await invokePlugin({action:'inspect',spec:'@ace-zone/dsh-market@0.1.66'},exec),discovery=await invokeMcp({action:'discover'},exec),indexes=await invokePlugin({action:'indexes'},exec);
    let denied=false;try{await invokePlugin({action:'list'},{agent:{}});}catch{denied=true;}
    proof('owner-native-management-live-proof.json',{at:new Date().toISOString(),ok:true,bundles:list.bundles.length,plugins:list.plugins.length,entryIdsPresent:list.plugins.every(p=>typeof p.entryId==='string'),installedSearchMatches:search.bundles.length,searchScope:search.scope,inspectionStatus:inspection.status,inspectionProblem:inspection.problem,profileMcpDeclarations:discovery.profile.entries.length,profileDiscoveryStatus:discovery.profile.status,ownerManaged:discovery.ownerManaged,marketAvailable:!!slots.pluginMarket,indexCount:Array.isArray(indexes)?indexes.length:0,approvalServiceAvailable:!!ctx.get('approval')?.request,approvalChannel:'native approval/request -> existing Web API waterfall',approvalPromptTested:false,wrongAgentDenied:denied,newInstalls:0,newMcpStarts:0,modelCalls:0,wechatSends:0});
   })().catch(error=>proof('owner-native-management-live-proof.json',{at:new Date().toISOString(),ok:false,code:error.code||error.message}));
  }
 },async close(){outbox.close();await jobs.close();market.close();for(const e of entries.values()){e.plugin.revoke();void e.mcp.revoke();}entries.clear();}};
}
