import path from 'node:path';const wait=new Int32Array(new SharedArrayBuffer(4));
export function retrySharing(action,target,{observe=()=>{}}={}){
 for(let attempt=0;;attempt++){try{return action();}catch(error){
  const norm=x=>typeof x==='string'?path.resolve(x).toLowerCase():'';
  const permitted=['EPERM','EACCES','EBUSY'].includes(error?.code)&&error?.syscall==='rename'&&
   norm(error?.dest)===norm(target)&&norm(path.dirname(error?.path||''))===norm(path.dirname(target))&&
   path.basename(error?.path||'').startsWith(path.basename(target)+'.')&&String(error?.path).endsWith('.tmp');
  if(!permitted||attempt>=5)throw error;observe({code:error.code,attempt:attempt+1});Atomics.wait(wait,0,0,[5,10,20,40,80][attempt]);
 }}
}
export function safeError(error){
 const message=String(error?.message||'');const primitive=/^(?:[A-Z][A-Z0-9_]{1,79})$/;
 const code=primitive.test(error?.code||'')?error.code:primitive.test(message)?message:'UNCLASSIFIED';
 const missing=message.match(/Cannot read properties of (undefined|null) \(reading '([A-Za-z_$][A-Za-z0-9_$]{0,70})'\)/);
 const notFunction=message.match(/(?:^|\s)([A-Za-z_$][A-Za-z0-9_$.?]{0,100}) is not a function/);
 const frames=String(error?.stack||'').split('\n').slice(1,9).map(line=>{
  const file=line.match(/([^/\\():?]+\.(?:mjs|js|py)):(\d+):(\d+)\)?$/);
  const native=line.match(/node:[a-z_]+:\d+:\d+/);return file?file.slice(1).join(':'):native?native[0]:'REDACTED_FRAME';});
 return {name:/^[A-Za-z]+Error$/.test(error?.name||'')?error.name:'Error',code,
 syscall:/^(rename|open|write|unlink)$/.test(error?.syscall||'')?error.syscall:null,
 missingProperty:missing?{base:missing[1],property:missing[2]}:null,
 notFunction:notFunction?notFunction[1]:null,frames};
}