import fs from 'node:fs';import path from 'node:path';

/** Read existing objects directly. NEVER call core.state/status or task.status. */
export function createCoreSessionSource(core,{clock=Date.now,longTaskRoot=null,extraManagedSessions=null}={}){
 if(!(core?.chats instanceof Map))throw Error('CORE_REGISTRY_REQUIRED');
 return()=>{
  const rows=[],now=clock(),data=core.store?.data||{};
  for(const chat of core.chats.values()){
   const s=data.chats?.[chat.id]||{},agent=core.handles?.get(chat.id)?.agent;
   rows.push({id:chat.id,chatId:chat.id,sessionId:s.sessionId||null,displayName:chat.title,kind:'chat',agent,persisted:s,paused:!!data.paused||(chat.mode==='group'&&s.groupPaused===true),observedAt:now});
  }
  const manager=core.capabilities?.taskManager;let legacyTasks=0;
  for(const[jobId,task]of Object.entries(manager?.jobs?.jobs||{})){
   if(!core.chats.has(task.chatId))continue;legacyTasks++;const agent=manager.handles?.get(jobId)?.agent;
   rows.push({id:jobId,chatId:task.chatId,sessionId:task.sessionId,kind:'native-task',agent,paused:!!data.paused,observedAt:now,terminal:['completed','failed'].includes(task.status),knownState:task.status==='completed'?'idle':task.status==='failed'?'failed':'unknown',lastOutcome:task.status==='completed'?'completed':task.status==='failed'?'failed':task.status==='unknown'?'unknown':null,startedAt:task.createdAt,lastProgressAt:task.completedAt||task.createdAt,lastError:task.status==='failed'?{code:'TASK_FAILED'}:null});
  }
  const isolatedSource=core.capabilities?.isolatedTaskStatusRows;
  if(isolatedSource!==undefined&&typeof isolatedSource!=='function')throw Error('ISOLATED_STATUS_SOURCE_INVALID');
  const isolatedRows=isolatedSource?isolatedSource():[];if(!Array.isArray(isolatedRows))throw Error('ISOLATED_REGISTRY_INVALID');
  let longTasks=isolatedRows.length,metadataBytes=0;
  if(longTaskRoot&&!isolatedSource){
   const root=path.join(longTaskRoot,'native'),owner=[...core.chats.values()].find(c=>c.owner===true);
   if(owner&&fs.existsSync(root)){
    const files=fs.readdirSync(root,{withFileTypes:true});if(files.length>1000)throw Error('LONG_TASK_METADATA_CAPACITY');
    for(const entry of files){if(!entry.isFile()||!/^[-_A-Za-z0-9]+\.json$/.test(entry.name))continue;const file=path.join(root,entry.name),before=fs.lstatSync(file);if(before.isSymbolicLink()||before.nlink!==1||before.size>1024*1024)throw Error('LONG_TASK_METADATA_INVALID');
     metadataBytes+=before.size;if(metadataBytes>8*1024*1024)throw Error('LONG_TASK_METADATA_BYTES_CAPACITY');
     const task=JSON.parse(fs.readFileSync(file,'utf8'));if(typeof task.task_id!=='string'||task.sessionId!=='xiaoqian-long-'+task.task_id)throw Error('LONG_TASK_BINDING_INVALID');longTasks++;
     const terminal=['completed','cancelled','failed','unknown'].includes(task.state);
     rows.push({id:task.task_id,chatId:owner.id,sessionId:task.modelAllocated?task.sessionId:null,kind:'long-task',paused:!!data.paused,observedAt:terminal?now:before.mtimeMs,terminal,knownState:['completed','cancelled'].includes(task.state)?'idle':task.state==='failed'?'failed':task.state==='reserved'?'queued':task.state==='running'?'running':'unknown',lastOutcome:task.state==='completed'?'completed':task.state==='cancelled'?'cancelled':task.state==='failed'?'failed':task.state==='unknown'?'unknown':null,lastProgressAt:before.mtimeMs,phase:task.kind==='model'?'model':'task'});
    }
   }
  }
  const managementSource=core.capabilities?.ownerManagementStatusRows;if(managementSource!==undefined&&typeof managementSource!=='function')throw Error('MANAGEMENT_STATUS_SOURCE_INVALID');
  const managementRows=managementSource?managementSource():[];if(!Array.isArray(managementRows)||managementRows.length>8)throw Error('MANAGEMENT_STATUS_REGISTRY_INVALID');
  const extra=extraManagedSessions?extraManagedSessions():[];if(!Array.isArray(extra))throw Error('EXTRA_REGISTRY_INVALID');
  for(const row of [...isolatedRows,...managementRows.map(row=>({...row,paused:!!data.paused||row.paused===true})),...extra]){if(!core.chats.has(row.chatId))throw Error('EXTRA_SESSION_NOT_BOUND');const index=rows.findIndex(v=>v.kind===row.kind&&v.id===row.id&&v.chatId===row.chatId);if(index>=0)rows[index]={...rows[index],...row};else rows.push(row);}
  return{rows,coverage:{chatRegistry:true,legacyNativeTasks:true,longTaskRootConfigured:!!longTaskRoot,extraRegistryConfigured:!!extraManagedSessions||!!isolatedSource,isolatedTaskRegistry:!!isolatedSource,managementJobRegistry:!!managementSource,longTaskFileScanSuppressed:!!longTaskRoot&&!!isolatedSource,legacyTaskRows:legacyTasks,longTaskRows:longTasks,scopeLimit:'No global Harness, Codex or WeChat contact enumeration. Long-task live handles require explicit extra registry attachment.'}};
 };
}
