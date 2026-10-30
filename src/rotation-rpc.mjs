import {StringDecoder} from 'node:string_decoder';
import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
export function runRotationWorker(request,ports,{python,timeoutMs=120000,faultStopAfterPort}={}){
 return new Promise((resolve,reject)=>{
  const env={PYTHONIOENCODING:'utf-8'};for(const k of ['SystemRoot','WINDIR'])if(process.env[k])env[k]=process.env[k];
  const child=spawn(python,['-I','-S','-X','utf8','-u',fileURLToPath(new URL('../tools/rotation-worker.py',import.meta.url))],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const decoder=new StringDecoder('utf8');let data='',done=false,terminal,stopError,chain=Promise.resolve(),timer;const finish=(e,v)=>{if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve(v);};
  const stop=code=>{stopError??=Object.assign(Error(code),{code});child.kill();};
  timer=setTimeout(()=>stop('ROTATION_WORKER_TIMEOUT'),timeoutMs);child.stderr.resume();child.stdin.on('error',()=>{});
  child.stdout.on('data',chunk=>{data+=decoder.write(chunk);if(data.length>16*1024*1024){stop('ROTATION_RPC_LIMIT');return;}let nl;while((nl=data.indexOf('\n'))>=0){const line=data.slice(0,nl);data=data.slice(nl+1);chain=chain.then(async()=>{const row=JSON.parse(line);if(row.done){terminal=row;return;}if(!Number.isInteger(row.rpc)||!Object.hasOwn(ports,row.method))throw Error('ROTATION_PORT_DENIED');let response;try{response={rpc:row.rpc,ok:true,value:await ports[row.method](...row.args)}}catch(error){response={rpc:row.rpc,ok:false,unknown:error.uncertain===true,code:error.code||'HOST_PORT_FAILED'}}if(faultStopAfterPort===row.method){stop('SYNTHETIC_WORKER_STOP_AFTER_PORT');return;}if(!stopError)child.stdin.write(JSON.stringify(response)+'\n');}).catch(()=>stop('ROTATION_RPC_FAILED'));}});
  child.once('error',()=>finish(Object.assign(Error('ROTATION_WORKER_UNAVAILABLE'),{workerStopped:true})));child.once('close',()=>{void chain.then(()=>{if(stopError){stopError.workerStopped=true;finish(stopError);}else if(terminal&&!terminal.error)finish(null,terminal);else finish(Object.assign(Error(terminal?.error||'ROTATION_WORKER_FAILED'),{workerStopped:true}));})});
  child.stdin.write(JSON.stringify(request)+'\n');
 });
}
