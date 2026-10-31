import {createHash,randomBytes} from 'node:crypto';
import {optionalJson} from './lossless-data.mjs';

export function renderWechatApproval(prompt){
 const d=prompt.details,s=d.subject||{},inspection=s.inspection||{};
 let description;
 if(d.action==='install'){
  if(typeof s.spec!=='string'||!/@\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(s.spec))return{ok:false,code:'EXACT_VERSION_REQUIRED_USE_WEB'};
  if(typeof inspection.registry!=='string')return{ok:false,code:'EXACT_REGISTRY_REQUIRED_USE_WEB'};
  let source;try{source=new URL(inspection.registry)}catch{return{ok:false,code:'REGISTRY_INVALID_USE_WEB'}}
  if(source.username||source.password||source.search||source.hash||source.protocol!=='https:')return{ok:false,code:'PRIVATE_OR_UNCLEAR_SOURCE_USE_WEB'};
  if(!Array.isArray(s.sourcePlan)||s.sourcePlan.length<1||s.sourcePlan.length>10)return{ok:false,code:'REGISTRY_PLAN_REQUIRED_USE_WEB'};
  const sources=[];for(const value of s.sourcePlan){let u;try{u=new URL(value)}catch{return{ok:false,code:'REGISTRY_PLAN_INVALID_USE_WEB'}}if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)return{ok:false,code:'REGISTRY_PLAN_PRIVATE_USE_WEB'};sources.push(u.href)}
  description='包：'+s.spec+'\n来源：'+source.href+'\n核对版本：'+String(inspection.version||'须在Web核对');
  description+='\n命名空间：'+(s.spec.startsWith('@deepseek-ai/')?'官方命名空间形式，尚未验签':'第三方或未知命名空间');
  description+='\n来源信任：本次新代码未验签；第三方未知来源须主人具体确认，既往宽泛授权不适用。';
  description+='\n安装来源（按宿主回退顺序，逐一授权）：'+sources.join(' -> ');
 }else if(s.transport==='stdio'){
  if(typeof s.command!=='string'||!/(?:^|[\\/])npx(?:\.cmd|\.exe)?$/i.test(s.command)||!Array.isArray(s.args))return{ok:false,code:'FULL_EXECUTION_DETAILS_REQUIRE_WEB'};
  const pinned=/^(@[a-z0-9-]+\/[a-z0-9._-]+|[a-z0-9][a-z0-9._-]*)@\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
  const index=s.args.findIndex(v=>typeof v==='string'&&pinned.test(v));if(index<0)return{ok:false,code:'EXACT_MCP_PACKAGE_REQUIRED_USE_WEB'};
  const leading=s.args.slice(0,index),sources=leading.filter(v=>v.startsWith('--registry='));
  if(sources.length!==1||leading.some(v=>!['-y','--yes'].includes(v)&&!v.startsWith('--registry=')))return{ok:false,code:'EXACT_MCP_REGISTRY_REQUIRED_USE_WEB'};
  let registry;try{registry=new URL(sources[0].slice(11))}catch{return{ok:false,code:'MCP_REGISTRY_INVALID_USE_WEB'}};
  if(registry.protocol!=='https:'||registry.username||registry.password||registry.search||registry.hash)return{ok:false,code:'MCP_REGISTRY_PRIVATE_USE_WEB'};
  if(s.args.some(v=>typeof v!=='string'||/[\r\n\0]|(?:--?)(?:token|api[-_]?key|password|secret|authorization|credential)\b|^(?:sk-|github_pat_|Bearer\s)/i.test(v)))return{ok:false,code:'MCP_CREDENTIAL_FLOW_REQUIRES_HOST'};
  description='MCP stdio：'+s.serverName+'\n第三方或未知来源，未验签；仅本次具体授权。包：'+s.args[index]+'\n下载源：'+registry.href+'\n命令：'+s.command+'\n精确参数：'+JSON.stringify(s.args)+'\n权限：按宿主账号下载并执行该包；无OS沙箱，不提供新凭据或额外监听权限。';
 }else if(s.transport==='streamable-http'){
  let endpoint;try{endpoint=new URL(s.url)}catch{return{ok:false,code:'MCP_ENDPOINT_REQUIRES_WEB'}}
  if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)return{ok:false,code:'MCP_PRIVATE_ENDPOINT_USE_WEB'};
  description='MCP：'+s.serverName+'\n端点：'+endpoint.href+'\n权限：连接该外部服务；不提供新凭据。';
 }else return{ok:false,code:'FULL_EXECUTION_DETAILS_REQUIRE_WEB'};
 const text='一次性操作确认\n操作：'+d.action+'\n'+description+'\n插件/本地MCP代码以宿主账户运行，不提供OS沙箱。此次不授权新凭据、额外构建脚本或永久授权；费用/新监听扩权需要另行确认。\n请求：'+prompt.requestId+'\n截止：'+prompt.expiresAt+'\n同意请完整回复：\n'+prompt.approveText+'\n拒绝：'+prompt.rejectText+'\n改用Web：'+prompt.webText+(prompt.webFallback.url?'\n现有面板：'+prompt.webFallback.url:'');
 return text.length<=6000?{ok:true,text}:{ok:false,code:'PROMPT_TOO_LARGE_USE_WEB'};
}

// Host-only transport for the existing approval/request seam. NOT a model tool.
export function createWechatApproval({ctx,agent,bindingId,ownerChatId,isCurrentOwner,isTrustedOwnerInbound,notifyOwner,webUrl=null,ttlMs=90000,clock=Date.now}={}){
 if(!ctx?.on||typeof isCurrentOwner!=='function'||typeof isTrustedOwnerInbound!=='function'||typeof notifyOwner!=='function')throw Error('APPROVAL_HOST_HOOKS_REQUIRED');
 if(!Number.isInteger(ttlMs)||ttlMs<10||ttlMs>90000)throw Error('TTL_INVALID');
 if(webUrl!==null){const u=new URL(webUrl);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error('WEB_URL_INVALID');webUrl=u.href;}
 const expected=new Map(),pending=new Map(),used=new Set();let closed=false;
 const owner=()=>!closed&&isCurrentOwner({agent,bindingId});
 const hash=s=>createHash('sha256').update(s).digest('hex');
 const fallback={url:webUrl,instruction:'打开已连接的 Harness Web 面板，选择当前主人微信会话并处理一次性审批。需要既有安全访问方式；不创建公网入口。',pureWechatComplete:false};
 function remove(p,outcome){if(p.done)return;p.done=true;clearTimeout(p.timer);p.signal?.removeEventListener('abort',p.abort);pending.delete(p.requestId);p.resolve(outcome);}
 const disposeListener=ctx.on('approval/request',async(req,next)=>{
  const e=expected.get(req.callId);
  if(req.agent!==agent||!e||req.toolName!==e.toolName||hash(req.reason||'')!==e.reasonHash)return next();
  if(!await owner())return'rejected';
  const token=randomBytes(8).toString('hex');let resolve;const wait=new Promise(r=>resolve=r);
  const p={...e,token,resolve,done:false,signal:req.signal,expiresAt:clock()+ttlMs};pending.set(p.requestId,p);
  p.abort=()=>remove(p,'cancelled');p.timer=setTimeout(p.abort,ttlMs);p.signal?.addEventListener('abort',p.abort,{once:true});
  if(p.signal?.aborted){remove(p,'cancelled');return'cancelled';}
  const prompt={chatId:ownerChatId,requestId:p.requestId,action:p.action,details:p.details,expiresAt:new Date(p.expiresAt).toISOString(),approveText:'同意 '+p.requestId+' '+token,rejectText:'拒绝 '+p.requestId+' '+token,webText:'网页审批 '+p.requestId+' '+token,webFallback:fallback,deliveryId:'owner-approval-prompt:'+p.requestId};
  try{
   const rendered=renderWechatApproval(prompt);if(!rendered.ok){remove(p,'unavailable');return next();}prompt.text=rendered.text;
   const delivery=await Promise.race([Promise.resolve().then(()=>notifyOwner(prompt)).then(result=>({result})),wait.then(answer=>({answer}))]);
   if(delivery.answer)return delivery.answer==='web'?next():delivery.answer;
   if(delivery.result?.status!=='ok'){remove(p,'unavailable');return next();}
   const answer=await wait;
   if(answer==='web')return next();
   return answer;
  }catch{remove(p,'unavailable');return next();}
  finally{remove(p,'cancelled');}
 },{prepend:true});
 const api={
  async confirm(request,exec,approval){
   if(exec?.agent!==agent||!await owner())throw Error('OWNER_ONLY');
   if(!approval?.request)throw Error('NATIVE_APPROVAL_UNAVAILABLE_USE_WEB');
   if(typeof request.requestId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(request.requestId)||used.has(request.requestId))throw Error('REQUEST_REPLAY_DENIED');
   if(typeof exec.callId!=='string'||!exec.callId||expected.has(exec.callId))throw Error('CALL_ID_REQUIRED_OR_PENDING');
   const toolName=request.config?'owner_mcp':'owner_plugins';
   const details=optionalJson({ownerJob:request.ownerJob,requestId:request.requestId,action:request.action,subject:request.subject||request.config,risks:request.risks||{hostCodeExecution:true},limits:'This exact operation only; no new credentials, build-script approval or permanent access.'});
   const reason=JSON.stringify(details);used.add(request.requestId);
   const e={requestId:request.requestId,action:request.action,details,toolName,reasonHash:hash(reason)};expected.set(exec.callId,e);
   try{
    const signal=exec.signal?AbortSignal.any([exec.signal,AbortSignal.timeout(ttlMs+10000)]):AbortSignal.timeout(ttlMs+10000);
    const outcome=await approval.request({agent,toolName,callId:exec.callId,reason,signal});
    if(outcome!=='allowed-once')throw Error('APPROVAL_'+outcome.toUpperCase().replaceAll('-','_')+'_USE_WEB');
    if(!await owner())throw Error('OWNER_AUTHORITY_REVOKED');
    return{approved:true,requestId:request.requestId};
   }finally{expected.delete(exec.callId);const p=pending.get(request.requestId);if(p)remove(p,'cancelled');}
  },
  async consumeOwnerMessage(event){
   // isTrustedOwnerInbound must verify an unforgeable host-side receipt/object,
   // NOT merely role/owner/source strings supplied by an Agent or HTTP caller.
   if(!await owner()||!await isTrustedOwnerInbound(event)||event.chatId!==ownerChatId||event.mode!=='private'||event.role!=='user'||event.origin!=='wechat-driver')return{consumed:false};
   const m=/^(同意|拒绝|网页审批) ([A-Za-z0-9_-]{1,100}) ([a-f0-9]{16})$/.exec(String(event.text||'').trim());
   if(!m)return{consumed:false};const p=pending.get(m[2]);
   if(!p||p.done||p.token!==m[3])return{consumed:false,code:'CONFIRMATION_NOT_PENDING'};
   if(clock()>=p.expiresAt){remove(p,'cancelled');return{consumed:false,code:'CONFIRMATION_EXPIRED'};}
   const outcome=m[1]==='同意'?'allowed-once':m[1]==='拒绝'?'rejected':'web';remove(p,outcome);
   return{consumed:true,requestId:p.requestId,action:p.action,outcome:outcome==='web'?'web-fallback':outcome};
  },
  fallback(){return{...fallback};},
  close(){if(closed)return;closed=true;for(const p of pending.values())remove(p,'cancelled');expected.clear();disposeListener?.();}
 };
 ctx.effect?.(()=>()=>api.close());return api;
}
