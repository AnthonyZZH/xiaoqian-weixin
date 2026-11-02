import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {createExecution,canonical} from './execution.mjs';
import {runRotationWorker} from './execution-rpc.mjs';
import {createPending} from './pending.mjs';
import {createWireGuardRegistry} from './wire-guards.mjs';
import {installIngressBinding} from './ingress-binding.mjs';
import {renderContextSections,joinContextSections} from './native-render.mjs';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const SHADOW=Symbol.for('xiaoqian.numeric-shadow.interval-v3'),BUDGET=Symbol.for('xiaoqian.retrieval-budget.v1');
export function containPostCommitGuardFailure({core,ownerId,newAgentId,pending,error}){if(core.state(ownerId).sessionId!==newAgentId)return;const p=pending.read(),code=/^[A-Z0-9_]+$/.test(error?.message??'')?error.message:'COLD_WIRE_GUARD_FAILED';core.state(ownerId).rotationUncertain={operation:p?.operation_id,code};core.store.save();pending.guardRejected(code);}
export function measureColdAssembly(assembly,input,renderPrompt){const units=s=>Buffer.byteLength(JSON.stringify(s),'utf8')-2;return units(renderPrompt(assembly))+units(joinContextSections(renderContextSections(assembly)))+Buffer.byteLength(JSON.stringify(assembly.tools),'utf8')+Buffer.byteLength(JSON.stringify(input),'utf8')+4096;}
/** Bound by createBridge with its EXISTING configuration and imported reviewed
 * modules. No guessed MCP URL, provider credentials or model call is needed. */
export function bindOwnerRotationExecution({bridge,hostCtx,config,modules,advise}){
 const {core}=bridge,owner=[...core.chats.values()].find(c=>c.owner&&c.mode==='private');
 if(!owner)throw Error('ROTATION_OWNER_REQUIRED');
 const root=path.join(config.rotation.root,'execution-v1');fs.mkdirSync(root,{recursive:true});
 const pending=createPending(root,{atomicWrite:modules.atomicWrite});let registry;
 const guards={install(...args){registry??=createWireGuardRegistry(modules.taskWireBudget);return registry.install(...args);}};
 const limits=bridge[BUDGET]?.rotationLimits??{summaryChars:8192,summaryTextChars:4096,fixedHandoffChars:60000};
 function capture(){
  const h=core.handles.get(owner.id),s=core.state(owner.id),session=h.agent.session,seq=session.seq,rev=modules.rotationRevision(core,owner.id);
  const events=session.snapshotEvents(),persona=core.features.persona(owner.id),usage=events.filter(e=>e.type==='assistant/message').map(e=>e.data?.usage).filter(Boolean).at(-1),turns=events.filter(e=>e.type==='turn/end'&&e.data?.reason?.kind==='completed').length;
  let tasks=[];const jobs=config.longTasks?.root&&path.join(config.longTasks.root,'ledger/jobs.json');
  // Same normal capture boundary as the reviewed coordinator; never run while OFF.
  if(jobs&&fs.existsSync(jobs))tasks=Object.values(JSON.parse(fs.readFileSync(jobs,'utf8')).jobs).filter(j=>j.chatId===owner.id&&j.principal===s.binding&&!['completed','cancelled','failed'].includes(j.status)).map(j=>JSON.stringify({task_id:j.task_id,status:j.status,task:j.task}));
  const tools=h.agent.ctx.tools.schemas(h.agent).map(t=>t.name).sort();
  const snapshot={conversation_id:owner.id,session_id:session.id,agent_id:h.agent.id,revision:rev,inbound_revision:hash(JSON.stringify(s.messages)),completed_turns:(s.rotationCounters?.turnOffset??0)+turns,observed_tokens:(s.rotationCounters?.tokenOffset??0)+(usage?usage.inputTokens+(usage.cacheReadTokens??0)+(usage.cacheWriteTokens??0):0),transcript:events.map(e=>[h.agent.id+':'+e.seq,e.type,JSON.stringify(e)]),persona_version:hash(persona),persona_text:persona,owner_id:s.binding,owner_permissions:tools,unfinished_tasks:tasks,recent_handoff:session.deriveMessages().slice(-4).map(m=>JSON.stringify(m).slice(0,2000)),dedup_map:[['inbound-state',hash(JSON.stringify(s.messages))],['outbound-state',hash(JSON.stringify(s.deliveries))]]};
  if(session.seq!==seq||modules.rotationRevision(core,owner.id)!==rev)throw Error('ROTATION_CAPTURE_CHANGED');return snapshot;
 }
 const ingress=installIngressBinding({core,ownerId:owner.id,normalizeMessage:modules.normalizeMessage,prefix:modules.ownerPromptPrefix});
 const service=createExecution({autoEnabled:config.rotation.autoEnabled===true,core,ownerId:owner.id,model:core.model.model,limits,hostCtx,wireGuards:guards,pending,journal:path.join(root,'journal.sqlite3'),revision:modules.rotationRevision,capture,renderPrompt:modules.renderPrompt,
  dimensions:async()=>{const s=bridge[SHADOW]?.status;if(!s?.numeric_dimensions||s.adapterRevision!=='live-numeric-r3')throw Error('CURRENT_R3_NUMERIC_DIMENSIONS_REQUIRED');return s.numeric_dimensions;},advise,
  worker:(request,ports)=>runRotationWorker(request,ports,{python:config.rotation.python,coordinatorRoot:modules.coordinatorRoot}),
  async createPorts({controller}={}){
   const adapter=modules.createMainLibraryAdapter({chats:config.chats,url:config.library?.url});
   const scoped={call:(chatId,op,args,options)=>adapter.call(chatId,op,args,{...options,signal:controller?.signal})};
   const library=modules.createRotationLibrary({adapter:scoped,chatId:owner.id,root:path.join(root,'artifacts'),namespace:'xiaoqian-session-archive'});
   const session=modules.createRotationSession({core,chatId:owner.id,root:path.join(root,'candidates'),hostCtx});const candidates=new Map();
   const ports={'library.write':library.write,'library.read':library.read};for(const [k,v]of Object.entries(session.ports))ports['session.'+k]=v;
   const create=ports['session.create_dormant'];ports['session.create_dormant']=async(payload,key)=>{const prior=core.openHandle;const wrapped=async function(id,opts){const h=await prior.apply(this,arguments);if(id===owner.id&&opts?.handoff===payload)candidates.set(h.agent.id,h);return h;};core.openHandle=wrapped;try{return await create(payload,key);}finally{if(core.openHandle===wrapped)core.openHandle=prior;}};
   return {ports,async installColdGuard(created,wireGuards,guard,control,check){
     const candidate=candidates.get(created.agent_id);if(!candidate)throw Error('ACTUAL_DORMANT_AGENT_REQUIRED');
     const assembly=await candidate.agent.ctx.systemPrompt.assemble({scope:candidate.agent,agent:candidate.agent});
     const actualUnits=measureColdAssembly(assembly,check.input,check.renderPrompt);
     if(!check.current()||actualUnits>check.unitsUpper)throw Error('ACTUAL_COLD_SCOPE_EXCEEDS_FROZEN_BUDGET');
     const checked=wire=>{try{return guard(wire);}catch(error){containPostCommitGuardFailure({core,ownerId:owner.id,newAgentId:created.agent_id,pending,error});throw error;}};
     const slot=wireGuards.install(created.agent_id,checked,control.signal);let release;
     // First actual native step completes before ordinary later tool turns. Do
     // not read message bodies or remove the guard on HTTP headers alone.
     release=hostCtx.on('session/event',(session,event)=>{if(session.id===created.agent_id&&event.type==='step/end'){slot.close();if(typeof release==='function')release();}},{global:true});
   },close:()=>session.close()};
  }});
 ingress.setService(service);const previous=core.rotationExecution;core.rotationExecution=service;
 return {service,status:()=>{const p=pending.read();return {...service.status(),pendingOpen:p?.open===true,pendingOperationId:p?.operation_id??null,pendingWorkerStopped:p?.workerStopped===true,actualCoreProducerAttached:typeof core.isPreparedOwnerInput==='function',transport:registry?.status()??{transportAttached:modules.taskWireBudget.transportAttached,slots:0}};},close(){service.close();ingress.close();if(core.rotationExecution===service)core.rotationExecution=previous;registry?.close();}};
}
