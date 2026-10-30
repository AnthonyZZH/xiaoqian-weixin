import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const fail=code=>Object.assign(new Error(code),{code});
const check=(v,c)=>{if(!v)throw fail(c);};

// Host API only. Roots, executable and authority never come from model arguments.
export function createServerExecutor({projects,isCurrentOwner,python,timeoutMs=5000,maxOutputBytes=65536}={}) {
  check(typeof isCurrentOwner==='function','OWNER_AUTHORITY_REQUIRED');
  check(path.isAbsolute(python||''),'ABSOLUTE_PYTHON_REQUIRED');
  check(Number.isInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=10000,'TIMEOUT_INVALID');
  check(Number.isInteger(maxOutputBytes)&&maxOutputBytes>=1024&&maxOutputBytes<=65536,'OUTPUT_LIMIT_INVALID');
  const roots=new Map(Object.entries(projects||{}));
  check(roots.size>0&&[...roots.values()].every(r=>typeof r==='string'&&path.isAbsolute(r)&&!r.startsWith('\\\\')),'ROOTS_REQUIRED');
  const used=new Set(); let queue=Promise.resolve(),quarantined=false;
  const names=['owner_command','owner_file_read','owner_file_write'];
  function worker(request,signal) {
    return new Promise((resolve,reject)=>{
      if(signal.aborted){reject(fail('TOOL_CANCELLED'));return;}
      const env={PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8'};
      for(const k of ['SystemRoot','WINDIR'])if(process.env[k])env[k]=process.env[k];
      const child=spawn(python,['-I','-B','-u',path.join(here,'worker.py')],{cwd:request.root,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
      let bytes=0,output=[],stopCode,settled=false,killTimer;
      const stop=code=>{if(stopCode)return;stopCode=code;child.kill();killTimer=setTimeout(()=>{quarantined=true;finish(fail('TERMINATION_UNCONFIRMED'));},1000);};
      const abort=()=>stop('TOOL_CANCELLED');
      const timer=setTimeout(()=>stop('EXECUTOR_TIMEOUT'),timeoutMs);
      signal.addEventListener('abort',abort,{once:true});
      const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);signal.removeEventListener('abort',abort);error?reject(error):resolve(result);};
      child.stdout.on('data',b=>{bytes+=b.length;if(bytes>512*1024)stop('OUTPUT_LIMIT');else output.push(b);});
      child.stderr.resume();
      child.on('error',()=>finish(fail('WORKER_UNAVAILABLE')));
      child.on('close',()=>{
        if(stopCode){finish(fail(stopCode));return;}
        try {
          const value=JSON.parse(Buffer.concat(output).toString('utf8'));
          if(value.ok!==true)throw fail(/^[A-Z_]{1,80}$/.test(value.code)?value.code:'WORKER_FAILED');
          const result=value.result;
          if(typeof result.text==='string'&&Buffer.byteLength(JSON.stringify(result))>maxOutputBytes){
            result.originalCharacters=result.text.length;result.truncated=true;
            while(Buffer.byteLength(JSON.stringify(result))>maxOutputBytes)result.text=result.text.slice(0,Math.max(0,result.text.length-1024));
          }
          check(Buffer.byteLength(JSON.stringify(result))<=maxOutputBytes,'OUTPUT_LIMIT');
          finish(null,result);
        }catch(e){finish(fail(e.code||'WORKER_FAILED'));}
      });
      child.stdin.on('error',()=>stop('WORKER_INPUT_FAILED'));
      child.stdin.end(JSON.stringify(request));
    });
  }
  return Object.freeze({
    available:()=>[...names],
    // Deliberately cannot satisfy owner-tools arbitrary-shell isolation gate.
    verifyIsolation:async()=>({verified:false,boundary:'structured-operations-only',reason:'NO_VERIFIED_RESTRICTED_OS_ACCOUNT'}),
    bind({agent,bindingId}) {
      check(agent&&typeof agent==='object'&&typeof bindingId==='string'&&bindingId,'BINDING_INVALID');
      let revoked=false; const scope=new AbortController();
      async function authorize(exec){
        check(!quarantined,'EXECUTOR_QUARANTINED');
        check(!revoked&&exec?.agent===agent,'OWNER_AGENT_MISMATCH');
        check(typeof exec.callId==='string'&&exec.callId.length>0&&exec.callId.length<=256,'CALL_ID_REQUIRED');
        check(await isCurrentOwner({agent,bindingId})===true,'OWNER_AUTHORITY_REVOKED');
        check(!scope.signal.aborted&&!exec.signal?.aborted,'TOOL_CANCELLED');
      }
      async function execute(name,args,exec){
        await authorize(exec);check(names.includes(name),'TOOL_NOT_CONFIGURED');
        check(roots.has(args?.projectId),'PROJECT_NOT_AUTHORIZED');
        check(!used.has(exec.callId),'OPERATION_ALREADY_CONSUMED');check(used.size<10000,'EXECUTOR_ROTATION_REQUIRED');used.add(exec.callId);
        const signal=exec.signal?AbortSignal.any([scope.signal,exec.signal]):scope.signal;
        const run=async()=>{
          await authorize(exec);
          const req={root:roots.get(args.projectId),operation:name==='owner_file_write'?'write':'read',path:args.path};
          if(name==='owner_command'){
            let command;try{command=JSON.parse(args.command);}catch{throw fail('STRUCTURED_COMMAND_REQUIRED');}
            check(command&&['list','stat','sha256'].includes(command.operation),'COMMAND_UNSUPPORTED');
            check(Object.keys(command).every(k=>['operation','path'].includes(k)),'COMMAND_ARGUMENT_INVALID');
            req.operation=command.operation;req.path=command.path??'';
          }
          if(name==='owner_file_write'){check(typeof args.text==='string'&&Buffer.byteLength(args.text)<=65536,'FILE_LIMIT');req.text=args.text;}
          check(Buffer.byteLength(JSON.stringify(req))<150000,'REQUEST_LIMIT');
          const result=await worker(req,signal);await authorize(exec);return result;
        };
        const pending=queue.then(run,run);queue=pending.catch(()=>{});return pending;
      }
      return Object.freeze({execute,revoke(){revoked=true;scope.abort();},register(agentCtx,defineTool){
        check(agentCtx?.tools?.register&&typeof defineTool==='function','REGISTRATION_INVALID');
        const field=description=>({type:'string',required:true,description});
        for(const name of names){
          const parameters={projectId:field('Host configured work-data project ID')};
          if(name==='owner_command')parameters.command=field('JSON object: {"operation":"list|stat|sha256","path":"relative/path"}. No shell syntax.');
          else parameters.path=field('Relative slash-separated UTF-8 work-data file path');
          if(name==='owner_file_write')parameters.text=field('UTF-8 text, at most 64 KiB');
          agentCtx.tools.register(defineTool({name,description:'Owner project data operation with fixed root; commands are structured, not arbitrary shell.',parameters,output:{schema:{type:'json'},render:(_a,r)=>[{type:'text',text:JSON.stringify(r)}]},execute:(a,e)=>execute(name,a,e)}));
        }
      }});
    }
  });
}
