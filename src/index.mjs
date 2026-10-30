import {bindOwnerBilling} from './billing/owner-binding.mjs';
import {createBillingCollector} from './billing/collector.mjs';
import {createOwnerIntegrations} from './owner-integrations.mjs';
import {createOwnerRotation} from './owner-rotation.mjs';
import {createOwnerSupplements} from './owner-supplements.mjs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {WeChatCore} from './core.mjs';
import {DurableDriverClient} from '../driver/durable-client.mjs';
import {FeatureStore,scopedDirectory} from './features.mjs';
import {InitiativeStore} from './initiative.mjs';
import {OwnerDecisionBridge,expireOwnerWake} from './owner-decision-bridge.mjs';
import {MediaLibrary} from './media.mjs';
import {MediaBridge} from './media-bridge.mjs';
import {LegacyImporter} from './importer.mjs';
import {EvidenceMemory} from './evidence-memory.mjs';
import {createCapabilities} from './capabilities.mjs';
import {NativeTasks} from './native-tasks.mjs';
import {allowedTools,requireValue,validateChats} from './policy.mjs';

export const name='xiaoqian-wechat-native';
export const inject=['agents','sessions','tools','sessionPersistence'];
export function validatePlatform(mode,platform=process.platform){
 requireValue(mode!=='live'||platform==='win32','LIVE_DRIVER_REQUIRES_WINDOWS');
}
const str=(description,required=false)=>({type:'string',description,...(required?{required:true}:{})});
const fields={
 wechat_memory_confirm:{key:str('Fact key',true),content:str('Verifiable fact',true),kind:str('preference/profile/relationship/goal/event',true),turnId:str('Original message ID in this chat',true),quote:str('Exact quote from that message',true)},
 wechat_reply:{text:str('要发到当前聊天的文字'),stickerId:str('当前聊天已批准表情的目录ID'),at:{type:'array',items:{type:'string'},description:'群成员显示名'}},
 wechat_skip:{},
 wechat_status:{},
 wechat_memory_read:{},
 wechat_memory_search:{query:str('本聊天记忆检索词',true)},
 wechat_memory_edit:{expectedRevision:str('读取结果里的修订号',true),facts:{type:'array',items:{type:'string'},required:true},style:str('聊天风格')},
 wechat_sticker_search:{query:str('表情描述关键词')},
 wechat_sticker_review:{action:str('list/approve/reject/describe',true),id:str('目录ID'),description:str('描述')},
 wechat_persona:{text:str('新的社交人格；省略则读取')},
 wechat_relay:{targetId:str('预先允许的目标ID',true),text:str('要转告的文字',true),at:{type:'array',items:{type:'string'}}},
 wechat_control:{action:str('pause/resume',true)},
 wechat_search:{query:str('搜索词',true)},
 wechat_draw:{prompt:str('绘图描述',true)},
 wechat_task:{task:str('主人要求的工作',true)},
 wechat_task_status:{jobId:str('Job ID',true)},
 wechat_describe_image:{id:str('当前会话媒体ID',true)}
};
const descriptions={
 wechat_memory_confirm:'Confirm a fact grounded in an exact original quote from this owner chat. Cross-chat citations are denied.',
 wechat_reply:'给当前已绑定微信会话发送文字和/或目录表情。不要在普通回答里假装发送。',
 wechat_skip:'这次主动检查无值得说的话，明确跳过并重新安排主动时间。',
 wechat_status:'读取当前会话状态，不读取其他会话正文。',
 wechat_memory_read:'读取当前会话自己的社交记忆。',
 wechat_memory_search:'检索当前会话自己的记忆。',
 wechat_memory_edit:'主人入口编辑自己的会话记忆，需修订号。',
 wechat_sticker_search:'按描述检索当前聊天已批准表情，返回ID，不接受路径。',
 wechat_sticker_review:'主人入口审核当前会话的表情候选、修改描述。',
 wechat_persona:'主人入口读取或修改自己的社交人格。',
 wechat_relay:'主人明确指令转告到已配置目标。目标列表由管理员设置。',
 wechat_control:'主人入口暂停或恢复微信桥；暂停后可从管理员控制端恢复。',
 wechat_search:'使用已配置搜索适配器；不可用时报告不可用。',
 wechat_draw:'调用已配置绘图适配器；不可用时如实报告。',
 wechat_task:'提交主人要求的长任务到当前常驻 Harness 的已配置工作能力。',
 wechat_task_status:'Read owner task status and durable result.',
 wechat_describe_image:'描述当前会话已获得的媒体；不能读取任意路径。'
};
export async function createBridge(ctx,config,{defineTool,driver,capabilities={},ownerServices={}}={}) {
 requireValue(config&&Array.isArray(config.chats),'CONFIG_INVALID');
 config={...config,chats:[...validateChats(config.chats).values()]};
 requireValue(path.isAbsolute(config.stateDir),'ABSOLUTE_STATE_DIR_REQUIRED');
 requireValue(config.mode==='mock'||config.mode==='live','MODE_REQUIRED');
 requireValue(config.mode!=='live'||config.liveEnabled===true,'LIVE_NOT_APPROVED');
 validatePlatform(config.mode);
 const root=path.resolve(config.stateDir);
 const generatedRoot=config.forge?.enabled===true?scopedDirectory(root,'generated'):path.join(root,'generated');
 const mediaImportRoots=[...(config.mediaImportRoots||[]),...(config.forge?.enabled===true?[generatedRoot]:[])];
 capabilities={...capabilities,ownerNativeTools:config.ownerNativeTools||capabilities.ownerNativeTools||[]};
 const features=new FeatureStore({stateDir:root,chats:config.chats});
 requireValue(config.driverRpcPath===undefined||path.isAbsolute(config.driverRpcPath),'ABSOLUTE_DRIVER_RPC_PATH_REQUIRED');
 const ui=driver||new DurableDriverClient({rpcPath:config.driverRpcPath,mode:config.mode,liveEnabled:config.liveEnabled===true,python:config.python||'python',targets:config.chats,stateDir:path.join(root,'driver'),mediaRoot:path.join(root,'media'),mediaImportRoots,mediaAllowStaticCapture:config.mediaAllowStaticCapture===true,schedulePath:path.join(root,'schedule','schedule.sqlite3'),timeZone:config.timeZone||'Asia/Shanghai',initiative:config.initiative||{},legacyDir:config.legacyDir||fileURLToPath(new URL('../legacy/',import.meta.url)),timeoutMs:config.uiTimeoutMs||20000,commandTimeout:config.uiCommandTimeout||5,mock:config.mock||{},startPaused:true});
 const initiative=driver?new InitiativeStore({stateDir:path.join(root,'initiative'),chats:config.chats,config:config.initiative||{},timeZone:config.timeZone||'Asia/Shanghai'}):new OwnerDecisionBridge(ui,{onTimeout:e=>expireOwnerWake(core,e)});
 const media=driver?new MediaLibrary({root:path.join(root,'media')}):new MediaBridge(ui);
 const importer=new LegacyImporter({features,media,archiveRoot:path.join(root,'legacy-archive'),chats:config.chats,allowedMediaRoot:config.mediaImportRoot||null});
 const evidenceMemory=new EvidenceMemory({root:path.join(root,'evidence-memory'),chats:config.chats});
 capabilities={...createCapabilities({config,media,generatedRoot,python:config.python||'python'}),...capabilities};
 let core;
 if(config.billingCollector?.enabled===true&&!(config.ownerIntegrations?.enabled===true&&config.balance?.enabled===true))throw Error('BILLING_BALANCE_SHIM_INTEGRATION_REQUIRED');
 const billingCollector=config.billingCollector?.enabled===true?createBillingCollector({root:config.billingCollector.root}):null;
 const ownerRotation=config.rotation?.enabled===true?createOwnerRotation({hostCtx:ctx,getCore:()=>core,config}):null;
 const ownerIntegrations=config.ownerIntegrations?.enabled===true?createOwnerIntegrations({hostCtx:ctx,getCore:()=>core,config,services:ownerServices}):null;
 const ownerSupplements=await createOwnerSupplements({getCore:()=>core,config,services:ownerServices});
 capabilities={...capabilities,ownerSupplements,ownerSearchTool:ownerSupplements.available().includes('owner_search'),ownerNativeTools:[...new Set([...(capabilities.ownerNativeTools||[]),...ownerSupplements.available(),...(ownerIntegrations?.available()||[])])]};
 const taskManager=new NativeTasks({root:path.join(root,'native-tasks'),agents:ctx.agents,sessions:ctx.sessions,
   model:config.taskModel||config.model,tools:config.ownerTaskTools||[],
   isOwner:id=>config.chats.some(c=>c.id===id&&c.owner===true),
   isPaused:()=>core?.store.data.paused!==false});
 capabilities={...capabilities,task:capabilities.task||((input)=>taskManager.submit(input)),
   taskStatus:capabilities.taskStatus||((input)=>taskManager.status(input)),taskManager};
 if(!defineTool)({defineTool}=await import(config.nativePackageRoot?pathToFileURL(path.join(config.nativePackageRoot,'dsh-tools/lib/index.js')).href:'@deepseek-ai/dsh-tools'));
 core=new WeChatCore({stateDir:path.join(root,'bridge'),chats:config.chats,agents:ctx.agents,sessions:ctx.sessions,driver:ui,media,features,evidenceMemory,initiative,capabilities,model:config.model,
   registerAgent:async(agentCtx,agent,chat,bridge)=>{
     bindOwnerBilling({collector:billingCollector,getCore:()=>core,agentCtx,agent,chat});
     ownerSupplements.register({agentCtx,agent,chat,defineTool});ownerIntegrations?.register({agentCtx,agent,chat,defineTool});ownerRotation?.register({agent,chat,defineTool});
     for(const toolName of allowedTools(chat,capabilities)){
       if(!fields[toolName])continue;
       agentCtx.tools.register(defineTool({
         name:toolName,description:descriptions[toolName],parameters:fields[toolName],
         output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
         async execute(args,exec){
           requireValue(exec.agent===agent,'TOOL_AGENT_MISMATCH');
           requireValue(!exec.signal?.aborted,'TOOL_CANCELLED');
           const callId=String(exec.callId||'');requireValue(callId.length>0,'TOOL_CALL_ID_REQUIRED');
           // Stable call identity is Host supplied, never a model argument.
           return bridge.invoke(chat.id,toolName,{...args,deliveryId:callId},{signal:exec.signal,...bridge.permits.context(chat.id,agent)});
         }
       }));
     }
   }});
 const originalClose=core.close.bind(core);let closing;core.close=()=>closing??=(async()=>{billingCollector?.close();ownerSupplements.close();ownerRotation?.close();await ownerIntegrations?.close();return originalClose();})();
 return {core,driver:ui,media,features,evidenceMemory,initiative,importer,taskManager,ownerSupplements,ownerRotation,ownerIntegrations,billingCollector};
}
export async function apply(ctx,config={}) {
 if(config.enabled!==true)return;
 // Service injection prevents activation without the native Agent driver/persistence.
 const bridge=await createBridge(ctx,config);
 let stopped=false,polling=false,ticking=false;
 const report=code=>ctx.logger?.warn?.(code);
 ctx.effect(()=>{
   // These timers only fetch UI events/check persisted clocks; they never call a model.
   const poll=setInterval(async()=>{
     if(stopped||polling||bridge.core.store.data.paused)return;
     polling=true;
     try{for(const c of config.chats){if(stopped)break;await bridge.core.poll(c.id);}}
     catch{report('WECHAT_POLL_FAILED');}finally{polling=false;}
   },Math.max(500,config.pollMs||2000));
   const tick=setInterval(async()=>{
     if(stopped||ticking||bridge.core.store.data.paused)return;
     ticking=true;try{await bridge.initiative.tick(e=>bridge.core.wake(e.chatId,e));
       for(const c of config.chats)bridge.evidenceMemory.maintain(c.id);}
     catch{report('WECHAT_INITIATIVE_FAILED');}finally{ticking=false;}
   },Math.max(1000,config.tickMs||10000));
   return async()=>{stopped=true;clearInterval(poll);clearInterval(tick);await bridge.core.close();};
 });
 if(config.startPaused===false)bridge.core.resume();
 // Host-only control, deliberately not a network listener or public group capability.
 ctx.provide('xiaoqianBridge',bridge);
 return;
}
