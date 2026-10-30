import {randomUUID} from 'node:crypto';
const pkg=/^(@[a-z0-9-]+\/[a-z0-9._-]+|[a-z0-9][a-z0-9._-]*)(@[0-9][a-zA-Z0-9.+-]*)?$/;
export function createPluginManager({ctx,isOwner,confirmChange}){
 if(!ctx||typeof isOwner!=='function')throw Error('HOST_CONTEXT_REQUIRED');
 return{bind(agent,bindingId){let revoked=false;
 async function auth(exec){if(revoked||exec?.agent!==agent||!await isOwner({agent,bindingId}))throw Error('OWNER_ONLY');if(exec.signal?.aborted)throw Error('CANCELLED');}
 async function approve(action,subject){if(typeof confirmChange!=='function')throw Error('CONFIRMATION_REQUIRED');const requestId=randomUUID();const result=await confirmChange({requestId,action,subject,agent,bindingId});if(result?.approved!==true||result.requestId!==requestId)throw Error('CONFIRMATION_REQUIRED');return requestId;}
 return{revoke(){revoked=true},async invoke(action,args={},exec){
 await auth(exec);const m=ctx.pluginManager;if(!m)throw Error('MANAGER_UNAVAILABLE');
 if(action==='list')return{bundles:(await m.listBundles()).map(({name,version,official,availability,enabled,installed,error})=>({name,version,official,availability,enabled,installed,error:error?{code:error.code}:undefined})),plugins:(await m.listPlugins()).map(({entryId,moduleName,enabled})=>({entryId,moduleName,enabled}))};
 if(action==='indexes')return ctx.pluginMarket?ctx.pluginMarket.listIndexes():{unavailable:true};
 if(action==='search'){if(!ctx.pluginMarket)throw Error('MARKET_UNAVAILABLE');const rows=await ctx.pluginMarket.listIndexes();if(!rows.some(x=>x.url===args.indexUrl))throw Error('INDEX_NOT_CONFIGURED');return ctx.pluginMarket.search(args.indexUrl,{text:String(args.query||'').slice(0,500),sort:{kind:args.query?'relevance':'index'},offset:0,limit:20});}
 if(action==='inspect'){if(typeof args.spec!=='string'||!pkg.test(args.spec))throw Error('REGISTRY_SPEC_REQUIRED');return m.inspect(args.spec,undefined,exec.signal);}
 if(action==='install'){if(typeof args.spec!=='string'||!pkg.test(args.spec))throw Error('REGISTRY_SPEC_REQUIRED');
 const rows=await m.listBundles();const name=args.spec.replace(/@[0-9][^@]*$/,'');const found=rows.find(x=>x.name===name&&x.availability!=='missing');
 if(found)return{status:'already_installed',name:found.name,version:found.version,enabled:found.enabled};
 const inspection=await m.inspect(args.spec,undefined,exec.signal);if(inspection.problem)throw Error('INSPECTION_REJECTED');
 const requestId=await approve('install',{spec:args.spec,inspection,hostCodeExecution:true,newCredentials:false,approvedBuilds:[]});await auth(exec);
 return m.installBundle(args.spec,{requestId,saveExact:true});}
 if(action==='enable'){const rows=await m.listPlugins();const row=rows.find(x=>x.entryId===args.entryId);if(!row)throw Error('PLUGIN_NOT_INSTALLED');await approve('enable',{entryId:row.entryId,moduleName:row.moduleName,hostCodeExecution:true});await auth(exec);return m.setPluginEnabled(row.entryId,true);}
 throw Error('ACTION_DENIED');
 },register(agentCtx,defineTool){const bound=this;agentCtx.tools.register(defineTool({name:'owner_plugins',description:'主人插件发现、检查、具体安装和启用。新变更使用宿主具体批准，不提升全局权限。',parameters:{action:{type:'string',required:true,description:'list/indexes/search/inspect/install/enable'},spec:{type:'string'},query:{type:'string'},indexUrl:{type:'string'},entryId:{type:'string'}},output:{schema:{type:'json'},render:(_a,r)=>[{type:'text',text:JSON.stringify(r)}]},execute:(a,e)=>bound.invoke(a.action,a,e)}));}};}};
}
