import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const fail=code=>{throw Error(code)};
export function createConfigStore(directory){
 fs.mkdirSync(directory,{recursive:true});
 const file=path.join(directory,'servers.json');
 return{read(){if(!fs.existsSync(file))return{};const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value.version!==1||!value.servers||Array.isArray(value.servers))fail('STORE_INVALID');return value.servers;},write(servers){const temporary=file+'.'+randomUUID();fs.writeFileSync(temporary,JSON.stringify({version:1,servers}),{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}};
}
export function validateServer(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('CONFIG_INVALID');
 const allowed=['serverName','transport','command','args','url'];
 if(Object.keys(raw).some(k=>!allowed.includes(k)))fail('EXTRA_CONFIG_REQUIRES_HOST_FLOW');
 if(!/^[A-Za-z0-9_-]{1,32}$/.test(raw.serverName)||['__proto__','constructor','prototype'].includes(raw.serverName))fail('NAME_INVALID');
 const config={serverName:raw.serverName,transport:raw.transport};
 if(raw.transport==='stdio'){
  if(typeof raw.command!=='string'||!raw.command||raw.command.length>500||/[\r\n\0]/.test(raw.command))fail('COMMAND_INVALID');
  if(!Array.isArray(raw.args)||raw.args.length>100||raw.args.some(a=>typeof a!=='string'||a.length>2000||a.includes('\0')))fail('ARGS_INVALID');
  config.command=raw.command;config.args=[...raw.args];
 }else if(raw.transport==='streamable-http'){
  if(typeof raw.url!=='string'||raw.url.length>2000)fail('URL_INVALID');const u=new URL(raw.url);
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)fail('URL_OR_CREDENTIAL_FLOW_REQUIRED');
  config.url=u.href;
 }else fail('TRANSPORT_INVALID');
 return config;
}
/** Native MCP is an effect-scoped plugin, not a ctx.mcpManager service. */
export function createMcpManager({ownerCtx,agent,bindingId,isOwner,confirmChange,store,nativePackageRoot='C:/xiaoqian/app/dsh/node_modules/@deepseek-ai',loadNative}={}){
 if(!ownerCtx?.plugin||typeof isOwner!=='function'||!store)fail('OWNER_CONTEXT_REQUIRED');
 const active=new Map(),revocation=new AbortController();let revoked=false,chain=Promise.resolve();
 const auth=async exec=>{if(revoked||exec?.agent!==agent||!await isOwner({agent,bindingId}))fail('OWNER_ONLY');if(exec.signal?.aborted)fail('CANCELLED');};
 async function approve(action,config){if(typeof confirmChange!=='function')fail('CONFIRMATION_REQUIRED');const requestId=randomUUID();const r=await confirmChange({requestId,action,config,agent,bindingId,risks:{hostAccountExecution:config.transport==='stdio',networkConnection:true,downloadAndExecuteMayOccur:config.transport==='stdio',scope:'owner-agent-only',credentials:'none supplied; env/headers require a separate host flow'}});if(r?.approved!==true||r.requestId!==requestId)fail('CONFIRMATION_REQUIRED');}
 async function mount(config,exec){
  if(active.has(config.serverName))return{status:'already_running',serverName:config.serverName};
  const native=await(loadNative?loadNative():import(pathToFileURL(path.join(nativePackageRoot,'dsh-mcp-client/lib/index.js')).href));
  await auth(exec);
  let resolve,reject;const ready=new Promise((a,b)=>{resolve=a;reject=b});
  const fork=ownerCtx.plugin({name:'owner-mcp-'+config.serverName,inject:native.inject,Config:native.Config,async apply(inner,resolved){try{await native.apply(inner,resolved);resolve();}catch{reject(Error('MCP_START_FAILED'));throw Error('MCP_START_FAILED');}}},{...config,failOnStartupError:true,toolCallTimeoutMs:30000,maxInstructionBytes:16384,reconnect:{enabled:false,initialDelayMs:500,maxDelayMs:30000,maxAttempts:1}});
  let timer,abort;const stop=new Promise((_,r)=>{timer=setTimeout(()=>r(Error('MCP_START_TIMEOUT')),20000);abort=()=>r(Error('CANCELLED'));exec.signal?.addEventListener('abort',abort,{once:true});});
  try{await Promise.race([ready,stop]);await auth(exec);active.set(config.serverName,fork);return{status:'running',serverName:config.serverName,persistence:'config-saved; reconnect after host restart requires explicit start'};}
  catch(error){await fork.dispose();throw error;}finally{clearTimeout(timer);exec.signal?.removeEventListener('abort',abort);}
 }
 const api={
  acceptsToolName(name){return [...active.keys()].some(id=>name.startsWith('mcp__'+id+'__'));},
  async revoke(){revoked=true;revocation.abort();for(const fork of active.values())await fork.dispose();active.clear();},
  invoke(action,args={},exec={}){exec={...exec,signal:exec.signal?AbortSignal.any([exec.signal,revocation.signal]):revocation.signal};const job=chain.then(async()=>{await auth(exec);const servers=store.read();
   if(action==='list')return Object.values(servers).map(c=>({serverName:c.serverName,transport:c.transport,status:active.has(c.serverName)?'running':'configured'}));
   if(action==='add'){if(typeof args.configJson!=='string'||args.configJson.length>20000)fail('CONFIG_SIZE_INVALID');const config=validateServer(JSON.parse(args.configJson));if(Object.hasOwn(servers,config.serverName))fail('SERVER_ALREADY_CONFIGURED');await approve(args.start===true?'add-and-start':'add',config);await auth(exec);servers[config.serverName]=config;store.write(servers);return args.start===true?mount(config,exec):{status:'configured',serverName:config.serverName};}
   if(!Object.hasOwn(servers,args.serverName))fail('SERVER_UNKNOWN');
   if(action==='start'){const config=validateServer(servers[args.serverName]);await approve('start',config);await auth(exec);return mount(config,exec);}
   if(action==='stop'){const fork=active.get(args.serverName);if(fork){await fork.dispose();active.delete(args.serverName);}return{status:'stopped'};}
   fail('ACTION_DENIED');});chain=job.catch(()=>{});return job;},
  register(ctx,defineTool){ctx.tools.register(defineTool({name:'owner_mcp',description:'主人MCP配置列表、明确添加并启动、启动和停止。新执行或连接须宿主具体批准，工具仅进入主人Agent作用域。',parameters:{action:{type:'string',required:true,description:'list/add/start/stop'},configJson:{type:'string',description:'不含密钥的精确stdio或streamable-http配置JSON'},serverName:{type:'string'},start:{type:'boolean'}},output:{schema:{type:'json'},render:(_a,r)=>[{type:'text',text:JSON.stringify(r)}]},execute:(a,e)=>api.invoke(a.action,a,e)}));}
 };
 ownerCtx.effect(()=>()=>api.revoke());
 return api;
}
