/** Prepared source only: arbitrary host-identity PowerShell. NOT an OS sandbox. */
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const error=code=>Object.assign(new Error(code),{code});
const check=(v,c)=>{if(!v)throw error(c);};
const digest=v=>crypto.createHash('sha256').update(v).digest('hex');

function invoke(request,{python,signal,onQuarantine}){
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(error('TOOL_CANCELLED'));return;}
    const env={PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8'};
    for(const key of ['SystemRoot','WINDIR'])if(process.env[key])env[key]=process.env[key];
    env.PATH=process.env.PATH||[path.dirname(python),path.join(env.SystemRoot||'C:\\Windows','System32')].join(path.delimiter);
    env.PATHEXT=process.env.PATHEXT||'.COM;.EXE;.BAT;.CMD';
    env.ComSpec=path.join(env.SystemRoot||'C:\\Windows','System32','cmd.exe');
    env.TEMP=os.tmpdir();env.TMP=env.TEMP;
    const child=spawn(python,['-I','-B','-u',path.join(here,'pending-command-worker.py')],{cwd:request.cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output=[],bytes=0,done=false,stopCode,killTimer;
    const finish=(e,r)=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(killTimer);signal.removeEventListener('abort',abort);e?reject(e):resolve(r);};
    const stop=code=>{
      if(stopCode)return;stopCode=code;
      // Ask the worker to terminate and observe its Job before killing it.
      // Forced termination still closes the sole Job handle, but is uncertain.
      child.stdin.write('{"cancel":true}\n',()=>{});
      killTimer=setTimeout(()=>{onQuarantine();child.kill();finish(error('TERMINATION_UNCONFIRMED'));},3500);
    };
    const abort=()=>stop('TOOL_CANCELLED');
    const timer=setTimeout(()=>stop('WORKER_DEADLINE'),request.timeoutMs+5000);
    signal.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',b=>{bytes+=b.length;if(bytes>512*1024)stop('WORKER_OUTPUT_LIMIT');else output.push(b);});
    child.stderr.resume();child.stdin.on('error',()=>{if(!done&&!stopCode)stop('WORKER_INPUT_FAILED');});
    child.on('error',()=>finish(error('WORKER_UNAVAILABLE')));
    child.on('close',()=>{
      try{
        const row=JSON.parse(Buffer.concat(output).toString('utf8'));
        check(row.ok===true,/^[A-Z_]{1,80}$/.test(row.code)?row.code:'COMMAND_FAILED');
        check(row.result?.jobExitConfirmed===true,'TERMINATION_UNCONFIRMED');
        const result=row.result;
        if(stopCode){finish(Object.assign(error(stopCode),{jobExitConfirmed:true,cancelled:result.cancelled===true,exitCode:result.exitCode,outputBytes:result.outputBytes}));return;}
        while(Buffer.byteLength(JSON.stringify(result))>65536&&result.output?.length){result.output=result.output.slice(0,-1024);result.truncated=true;}
        check(Buffer.byteLength(JSON.stringify(result))<=65536,'OUTPUT_LIMIT');finish(null,result);
      }catch(e){if(stopCode||e.code==='TERMINATION_UNCONFIRMED')onQuarantine();finish(error(stopCode?'TERMINATION_UNCONFIRMED':e.code||'COMMAND_FAILED'));}
    });
    child.stdin.write(JSON.stringify(request)+'\n');
  });
}

export function createPendingOwnerPowerShell({enabled=false,approvalId,isCurrentOwner,authorizeOrigin,python,auditRoot,runner=invoke}={}){
  check(typeof enabled==='boolean','HOST_ENABLE_FLAG_INVALID');
  check(typeof isCurrentOwner==='function'&&typeof authorizeOrigin==='function','TRUSTED_AUTHORITY_REQUIRED');
  check(path.isAbsolute(python||'')&&path.isAbsolute(auditRoot||''),'ABSOLUTE_HOST_PATHS_REQUIRED');
  if(enabled)check(typeof approvalId==='string'&&approvalId.trim(),'HOST_APPROVAL_RECORD_REQUIRED');
  let quarantine=false,queue=Promise.resolve();
  return Object.freeze({available:()=>enabled?['owner_powershell']:[],bind({agent,bindingId}){
    check(agent&&typeof agent==='object'&&typeof bindingId==='string'&&bindingId,'BINDING_INVALID');
    let revoked=false;const scope=new AbortController();
    async function auth(exec){
      check(enabled,'HOST_SHELL_DISABLED');check(!quarantine,'EXECUTOR_QUARANTINED');
      check(!revoked&&exec?.agent===agent,'OWNER_AGENT_MISMATCH');
      check(typeof exec.callId==='string'&&exec.callId.length>0&&exec.callId.length<=256,'CALL_ID_REQUIRED');
      check(!scope.signal.aborted&&!exec.signal?.aborted,'TOOL_CANCELLED');
      check(await isCurrentOwner({agent,bindingId})===true,'OWNER_AUTHORITY_REVOKED');
      check(!revoked&&!scope.signal.aborted&&!exec.signal?.aborted,'TOOL_CANCELLED');
    }
    async function execute(args,exec){
      await auth(exec);
      check(typeof args?.script==='string'&&args.script.trim()&&Buffer.byteLength(args.script)<=10000,'SCRIPT_INVALID');
      check(typeof args.cwd==='string'&&path.isAbsolute(args.cwd),'CWD_INVALID');
      const timeoutMs=args.timeoutMs??30000;check(Number.isInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=120000,'TIMEOUT_INVALID');
      const request={script:args.script,cwd:path.resolve(args.cwd),timeoutMs};
      const commandHash=digest(JSON.stringify(request));
      // Trusted host maps callId to an authenticated owner-origin request/task.
      // Model-supplied message text, owner booleans, group/web quotes cannot mint it.
      const origin=await authorizeOrigin({agent,bindingId,callId:exec.callId,commandHash});
      check(origin?.kind==='authenticated-owner-request'&&origin.canExecuteHostShell===true&&typeof origin.requestId==='string'&&origin.requestId,'OWNER_ORIGIN_REQUIRED');
      await auth(exec);
      check(fs.statSync(request.cwd).isDirectory(),'CWD_INVALID');
      fs.mkdirSync(auditRoot,{recursive:true});
      const filename=path.join(auditRoot,digest(bindingId+'\0'+exec.callId)+'.json');
      const record={approvalId,commandHash,requestIdHash:digest(origin.requestId),at:new Date().toISOString(),status:'pending'};
      try{fs.writeFileSync(filename,JSON.stringify(record),{flag:'wx'});}catch(e){throw error(e.code==='EEXIST'?'OPERATION_ALREADY_CONSUMED':'AUDIT_UNAVAILABLE');}
      const signal=exec.signal?AbortSignal.any([scope.signal,exec.signal]):scope.signal;
      const run=async()=>{
        try{
          await auth(exec);
          const current=await authorizeOrigin({agent,bindingId,callId:exec.callId,commandHash});
          check(current?.kind==='authenticated-owner-request'&&current.canExecuteHostShell===true&&current.requestId===origin.requestId,'OWNER_ORIGIN_REQUIRED');
          await auth(exec);
          const result=await runner(request,{python,signal,onQuarantine:()=>{quarantine=true;}});
          await auth(exec);
          record.status='finished';record.exitCode=result.exitCode;record.timedOut=result.timedOut===true;
          record.outputBytes=result.outputBytes;record.jobExitConfirmed=result.jobExitConfirmed===true;
          persist();return result;
        }catch(e){record.status=e.jobExitConfirmed===true?'cancelled-confirmed':'failed-or-unconfirmed';record.jobExitConfirmed=e.jobExitConfirmed===true;record.code=/^[A-Z_]{1,80}$/.test(e.code)?e.code:'COMMAND_FAILED';persist();throw Object.assign(error(record.code),{jobExitConfirmed:record.jobExitConfirmed});}
      };
      function persist(){const tmp=filename+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify({...record,finishedAt:new Date().toISOString()}),{flag:'wx'});fs.renameSync(tmp,filename);}
      const p=queue.then(run,run);queue=p.catch(()=>{});return p;
    }
    return Object.freeze({execute,revoke(){revoked=true;scope.abort();},register(ctx,defineTool){
      if(!enabled)return;
      ctx.tools.register(defineTool({name:'owner_powershell',description:'Authenticated owner only: arbitrary PowerShell as the server service identity. No project-root restriction. Commands may access and modify all resources available to that identity.',parameters:{script:{type:'string',required:true,description:'PowerShell script'},cwd:{type:'string',required:true,description:'Absolute server working directory'},timeoutMs:{type:'number',description:'100鈥?20000 ms, default 30000'}},output:{schema:{type:'json'},render:(_a,r)=>[{type:'text',text:JSON.stringify(r)}]},execute}));
    }});
  }});
}
