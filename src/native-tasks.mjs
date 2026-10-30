import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {atomicJson,scopedDirectory} from './features.mjs';

/** Owner-only durable job ledger backed by native Harness Agents. */
export class NativeTasks {
  constructor({root,agents,sessions,model,tools=[],isOwner=()=>false,isPaused=()=>false}){
    this.root=scopedDirectory(root);this.file=path.join(this.root,'tasks.json');
    this.agents=agents;this.sessions=sessions;this.model=model;
    this.tools=[...new Set(tools)];this.isOwner=isOwner;this.isPaused=isPaused;
    this.jobs=this.read();this.handles=new Map();this.recovering=new Set();this.closed=false;
  }
  read(){
    if(!fs.existsSync(this.file))return {version:1,jobs:{}};
    if(fs.lstatSync(this.file).isSymbolicLink()||fs.statSync(this.file).size>4*1024*1024)throw new Error('TASK_STATE_INVALID');
    const data=JSON.parse(fs.readFileSync(this.file,'utf8'));
    if(data.version!==1||!data.jobs||typeof data.jobs!=='object'||Array.isArray(data.jobs)||Object.keys(data.jobs).length>1000)throw new Error('TASK_STATE_INVALID');
    for(const [id,row] of Object.entries(data.jobs))if(!/^[0-9a-f-]{36}$/.test(id)||
      !row||typeof row.sessionId!=='string'||typeof row.chatId!=='string'||
      !['preparing','submitted','completed','failed','unknown'].includes(row.status))throw new Error('TASK_STATE_INVALID');
    return data;
  }
  save(){atomicJson(this.file,this.jobs);}
  scope(ctx,chatId){
    ctx.tools.restrict({allow:this.tools});
    ctx.tools.guard(call=>this.closed||this.isPaused()?'TASK_PAUSED':
      !this.isOwner(chatId)?'TASK_OWNER_REVOKED':
      this.tools.includes(call?.name)?undefined:'TASK_TOOL_DENIED');
  }
  async submit({chatId,owner,args}){
    if(!owner||!this.isOwner(chatId))throw new Error('TASK_OWNER_REQUIRED');
    if(!this.tools.length)throw new Error('TASK_TOOLS_NOT_CONFIGURED');
    if(this.closed||this.isPaused())throw new Error('TASK_PAUSED');
    const task=args.task;
    if(typeof task!=='string'||!task.trim()||task.length>4000)throw new Error('TASK_TEXT_INVALID');
    const jobId=crypto.randomUUID(),sessionId='xiaoqian-job-'+jobId;
    const row={sessionId,chatId,status:'preparing',createdAt:new Date().toISOString()};
    this.jobs.jobs[jobId]=row;this.save();
    let handle;
    try{
      handle=await this.agents.create({sessionId,agentOptions:this.model,
        setup:async ctx=>this.scope(ctx,chatId)});
      this.handles.set(jobId,handle);
      handle.agent.followup({id:'message-'+crypto.randomUUID(),role:'user',
        content:[{type:'text',text:task}],source:{kind:'xiaoqian-owner-task'}});
      if(await this.sessions.flush(handle.agent.session)!==true)throw new Error('TASK_FLUSH_NOT_CONFIRMED');
      row.status='submitted';this.save();
      void this.watch(jobId,handle);
      return {jobId,status:'submitted'};
    }catch(e){row.status='unknown';this.save();if(handle)await handle.dispose?.();this.handles.delete(jobId);throw e;}
  }
  async watch(jobId,handle){
    const row=this.jobs.jobs[jobId];
    try{
      await handle.agent.whenIdle();
      if(this.closed)return;
      if(await this.sessions.flush(handle.agent.session)!==true)throw new Error('TASK_RESULT_NOT_DURABLE');
      const messages=handle.agent.session.deriveMessages();
      const answer=[...messages].reverse().find(m=>m.role==='assistant');
      const text=answer?.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n').trim();
      if(!text)throw new Error('TASK_RESULT_MISSING');
      row.status='completed';row.result=text.slice(0,4000);row.completedAt=new Date().toISOString();
    }catch{row.status='unknown';}
    finally{if(!this.closed)this.save();this.handles.delete(jobId);await handle.dispose?.();}
  }
  async recover(jobId){
    const row=this.jobs.jobs[jobId];
    try{
      const handle=await this.agents.resume({resumeSessionId:row.sessionId,agentOptions:this.model,
        setup:async ctx=>this.scope(ctx,row.chatId)});
      if(this.closed){await handle.dispose?.();return;}
      this.handles.set(jobId,handle);await this.watch(jobId,handle);
    }catch{row.status='unknown';if(!this.closed)this.save();}
  }
  status({chatId,owner,args}){
    if(!owner||!this.isOwner(chatId))throw new Error('TASK_OWNER_REQUIRED');
    const row=this.jobs.jobs[args.jobId];
    if(!row||row.chatId!==chatId)throw new Error('TASK_NOT_FOUND');
    if(row.status==='submitted'&&!this.handles.has(args.jobId)&&!this.recovering.has(args.jobId)&&!this.closed){
      this.recovering.add(args.jobId);
      void this.recover(args.jobId).finally(()=>this.recovering.delete(args.jobId));
    }
    return {jobId:args.jobId,status:row.status,...(row.status==='completed'?{result:row.result}:{})};
  }
  async close(){this.closed=true;await Promise.allSettled([...this.handles.values()].map(h=>h.dispose?.()));this.handles.clear();}
}
