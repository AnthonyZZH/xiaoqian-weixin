import {spawn} from 'node:child_process';import path from 'node:path';
export function adviseDimensions({root,python,at,dimensions}){
 return new Promise(resolve=>{
  const child=spawn(python,['-I','-S','-X','utf8','-u',path.join(root,'calculator','live_shadow.py')],{windowsHide:true,env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,PYTHONIOENCODING:'utf-8'},stdio:['pipe','pipe','pipe']});
  let out='',done=false;const finish=v=>{if(done)return;done=true;clearTimeout(timer);resolve(v);};
  const timer=setTimeout(()=>{child.kill();finish({reason:'NUMERIC_ADVISOR_TIMEOUT',recommendation:'hold',L:null,U:null,automatic_permission:false});},3000);
  child.stdout.on('data',c=>{if(out.length<32768)out+=c.toString('utf8');});child.stderr.resume();child.stdin.on('error',()=>{});
  child.once('error',()=>finish({reason:'NUMERIC_ADVISOR_UNAVAILABLE',recommendation:'hold',L:null,U:null,automatic_permission:false}));
  child.once('close',()=>{try{finish(JSON.parse(out));}catch{finish({reason:'NUMERIC_ADVISOR_INVALID_RESULT',recommendation:'hold',L:null,U:null,automatic_permission:false});}});
  // Projection is all numbers/hash/IDs/versions, never messages or fields from a wire body.
  child.stdin.end(JSON.stringify({as_of:at,dimensions})+'\n');
 });
}
