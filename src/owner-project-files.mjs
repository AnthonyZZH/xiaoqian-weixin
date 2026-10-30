import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createServerExecutor} from '../vendor/server-executor/index.mjs';
export function createOwnerProjectFiles({projects,python,isCurrentOwner,operationRoot}){
 fs.mkdirSync(operationRoot,{recursive:true});
 const kit=createServerExecutor({projects,python,isCurrentOwner});
 return {available:()=>kit.available(),bind({agent,bindingId}){
  const bound=kit.bind({agent,bindingId});let revoked=false;
  const auth=async exec=>{if(revoked||exec?.agent!==agent||!await isCurrentOwner({agent,bindingId}))throw Error('OWNER_ONLY');if(typeof exec.callId!=='string'||!exec.callId||exec.callId.length>256)throw Error('CALL_ID_REQUIRED');};
  const execute=async(name,args,exec)=>{
   await auth(exec);
   const id=crypto.createHash('sha256').update(bindingId+'\0'+exec.callId).digest('hex'),file=path.join(operationRoot,id+'.json');
   const requestHash=crypto.createHash('sha256').update(JSON.stringify([name,args])).digest('hex');
   try{fs.writeFileSync(file,JSON.stringify({status:'pending',requestHash,at:new Date().toISOString()}),{flag:'wx'});}
   catch(error){if(error.code!=='EEXIST')throw error;const old=JSON.parse(fs.readFileSync(file,'utf8'));if(old.requestHash!==requestHash)throw Error('OPERATION_ARGUMENT_MISMATCH');return old.result?{...old.result,cached:true}:{ok:false,outcome:'unknown',code:'PRIOR_OPERATION_UNCONFIRMED',cached:true};}
   let result;
   try{result=await bound.execute(name,args,exec);await auth(exec);}
   catch(error){result={ok:false,outcome:'unconfirmed',code:error.code||error.message||'PROJECT_OPERATION_FAILED'};}
   const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify({status:'done',requestHash,at:new Date().toISOString(),result}));fs.renameSync(tmp,file);
   await auth(exec);return result;
  };
  return {execute,revoke(){revoked=true;bound.revoke();},register(ctx,defineTool){bound.register(ctx,definition=>defineTool({...definition,execute:(args,exec)=>execute(definition.name,args,exec)}));}};
 }};
}
