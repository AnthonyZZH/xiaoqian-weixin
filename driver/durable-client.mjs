import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

/** Thin JSONL transport. Python DriverClient owns durable inbox/outbox and UI queue. */
export class DurableDriverClient {
  constructor(options={}){
    this.options=options;this.supportsAck=true;this.paused=options.startPaused===true;
    this.closed=false;this.child=null;this.pending=null;this.queue=Promise.resolve();
    this.timeoutMs=options.timeoutMs||20000;
    this.maxChars=options.maxChars||1000;
    if(!Array.isArray(options.targets)||!options.targets.length)throw new Error('DRIVER_TARGETS_REQUIRED');
    this.targets=new Map(options.targets.map(c=>[c.id,c]));
  }
  pause(){this.paused=true;this.queue=this.queue.then(()=>this._gracefulStop()).catch(()=>this._stop('DRIVER_PAUSED'));}
  resume(){if(this.closed)throw new Error('DRIVER_CLOSED');this.paused=false;}
  async close(){if(this.closed)return;this.closed=true;await this.queue;await this._gracefulStop();}
  call(operation,args={}){
    let captured;
    try{captured=JSON.parse(JSON.stringify(args));}catch{return Promise.resolve({status:'rejected',code:'ARGUMENT_INVALID'});}
    const job=this.queue.then(()=>this._call(operation,captured));
    this.queue=job.catch(()=>{});return job;
  }
  async _call(operation,args){
    if(this.closed)return {status:'rejected',code:'DRIVER_CLOSED'};
    if(this.paused&&operation!=='health')return {status:'paused',code:'DRIVER_PAUSED'};
    if(!['health','schedule_poll'].includes(operation)&&(!this.targets.has(args.targetId)||Object.hasOwn(args,'title')||Object.hasOwn(args,'mode')))
      return {status:'rejected',code:'DRIVER_TARGET_DENIED'};
    if(!['health','read','ack','send_text','transcribe','extract_image','send_image','media_catalog','media_review','media_import_file','media_import_static','media_preview','media_resolve','schedule_poll','schedule_heard','schedule_spoke','schedule_claim','schedule_renew','schedule_prepare','schedule_finish'].includes(operation))
      return {status:'rejected',code:'OPERATION_DENIED'};
    try{
      await this._ensure();
      return await this._request(operation,args);
    }catch(e){
      return {status:operation==='send_text'?'unknown':'error',code:String(e?.message||'DRIVER_UNAVAILABLE').slice(0,120)};
    }
  }
  async _ensure(){
    if(this.child)return;
    const root=path.dirname(fileURLToPath(import.meta.url));
    const env={};
    for(const key of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'])
      if(process.env[key])env[key]=process.env[key];
    env.PYTHONDONTWRITEBYTECODE='1';env.PYTHONIOENCODING='utf-8';
    const script=this.options.rpcPath||path.join(root,'bridge_rpc.py');
    const child=spawn(this.options.python||'python',['-u','-B',script],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child=child;
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{
      if(this.child!==child)return;
      if(line.length>2*1024*1024){this._stop('FRAME_TOO_LARGE');return;}
      let row;try{row=JSON.parse(line);}catch{this._stop('BAD_JSON');return;}
      const pending=this.pending;
      if(!pending||row.id!==pending.id||!['ok','rejected','unknown','error'].includes(row.status)){
        this._stop('BAD_RESPONSE');return;
      }
      clearTimeout(pending.timer);this.pending=null;pending.resolve(row);
    });
    child.stderr.resume();
    child.on('error',()=>{if(this.child===child)this._stop('PROCESS_ERROR');});
    child.on('exit',()=>{lines.close();if(this.child===child)this._stop('PROCESS_EXITED');});
    const config={mode:this.options.mode==='live'?'real':'fake',
      allow_real:this.options.mode==='live'&&this.options.liveEnabled===true,
      adapter_root:this.options.legacyDir,
      state_dir:this.options.stateDir,
      media_root:this.options.mediaRoot,
      media_import_roots:this.options.mediaImportRoots||[],
      media_allow_static_capture:this.options.mediaAllowStaticCapture===true,
      schedule_path:this.options.schedulePath,
      time_zone:this.options.timeZone||'Asia/Shanghai',
      initiative:this.options.initiative||{},
      chats:[...this.targets.values()].map(c=>({id:c.id,title:c.title,mode:c.mode,owner:c.owner===true})),
      fake_options:this.options.mock||{},max_chars:this.options.maxChars||1000,
      command_timeout:this.options.commandTimeout||5};
    const answer=await this._request('initialize',{config});
    if(answer.status!=='ok'){this._stop('HANDSHAKE_FAILED');throw new Error('HANDSHAKE_FAILED');}
  }
  _request(operation,args){
    if(!this.child)throw new Error('PROCESS_UNAVAILABLE');
    if(this.pending)throw new Error('CONCURRENT_REQUEST');
    return new Promise((resolve,reject)=>{
      const id=randomUUID();
      const timer=setTimeout(()=>this._stop('RPC_TIMEOUT'),this.timeoutMs);
      this.pending={id,timer,resolve,reject};
      this.child.stdin.write(JSON.stringify({id,operation,args})+'\n',error=>{
        if(error)this._stop('RPC_WRITE_FAILED');
      });
    });
  }
  _stop(reason){
    const child=this.child;this.child=null;
    const pending=this.pending;this.pending=null;
    if(pending){clearTimeout(pending.timer);pending.reject(new Error(reason));}
    if(child){try{child.stdin.destroy();child.kill();}catch{}}
  }
  async _gracefulStop(){
    if(!this.child)return;
    try{await this._request('close',{});}catch{}
    this._stop('DRIVER_CLOSED');
  }
}
