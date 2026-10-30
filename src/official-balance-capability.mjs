const failure=code=>Object.assign(Error(code),{code});
export function officialConnection(connection){
 try{const u=new URL(connection.baseURL);return u.protocol==='https:'&&u.hostname==='api.deepseek.com'&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&['/','/v1','/v1/','/anthropic','/anthropic/'].includes(u.pathname);}catch{return false;}
}
export function createOfficialBalance({options,resolveApiKey,fetchImpl=fetch,tlsVerified=()=>process.env.NODE_TLS_REJECT_UNAUTHORIZED!=='0'}){
 const describe=()=>{const c=options();return {kind:'deepseek-official',officialOrigin:officialConnection(c),tlsVerification:tlsVerified(),baseURL:officialConnection(c)?'https://api.deepseek.com/':null,requestPath:'/user/balance'};};
 return Object.freeze({describe,async requestOfficialBalance(request){
  if(request?.method!=='GET'||request?.path!=='/user/balance'||request?.redirect!=='error')throw failure('BALANCE_OPERATION_DENIED');
  const connection=options();if(!officialConnection(connection))throw failure('OFFICIAL_PROVIDER_REQUIRED');if(!tlsVerified())throw failure('TLS_VERIFICATION_REQUIRED');
  if(request.signal?.aborted)throw failure('TOOL_CANCELLED');
  // This callback is the existing provider's private resolver. No credential-returning method is exposed.
  const credential=await resolveApiKey(connection);
  try{
   const signal=request.signal?AbortSignal.any([request.signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000);
   const response=await fetchImpl('https://api.deepseek.com/user/balance',{method:'GET',headers:{Authorization:'Bearer '+credential,Accept:'application/json'},redirect:'error',signal});
   if(!response.ok)throw failure('BALANCE_HTTP_'+response.status);
   let bytes=0;const chunks=[];for await(const chunk of response.body){bytes+=chunk.length;if(bytes>65536)throw failure('BALANCE_RESPONSE_LIMIT');chunks.push(chunk);}
   return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch(error){if(/^[A-Z0-9_]{1,80}$/.test(error?.code||''))throw failure(error.code);throw failure('BALANCE_REQUEST_FAILED');}
 }});
}
export function attachOfficialBalance(ctx,dependencies){ctx.reflect.provide('xiaoqianOfficialBalance',createOfficialBalance(dependencies));}
