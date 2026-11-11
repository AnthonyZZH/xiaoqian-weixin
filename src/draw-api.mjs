// Image generation over HTTP: an OpenAI-compatible images endpoint (hosted or local) or a Stable Diffusion WebUI.
// Returns PNG/JPEG bytes. The API key comes from the environment variable named in the config, never from model input.
const fail=code=>{throw Object.assign(new Error(code),{code});};
const MAX=12*1024*1024;

export async function generateImage({kind,baseURL,model,size='1024x1024',apiKeyEnv},prompt,{signal,fetchImpl=fetch,env=process.env}={}){
 const key=apiKeyEnv&&env[apiKeyEnv],headers={'content-type':'application/json',...(key?{authorization:'Bearer '+key}:{})};
 const [width,height]=size.split('x').map(Number),timeout=AbortSignal.timeout(300000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
 const post=async(path,body)=>{
  let res;try{res=await fetchImpl(baseURL+path,{method:'POST',headers,body:JSON.stringify(body),signal:combined,redirect:'error'});}catch(e){fail(signal?.aborted?'DRAW_CANCELLED':'DRAW_ENDPOINT_UNREACHABLE');}
  if(!res.ok)fail('DRAW_HTTP_'+res.status);
  try{return await res.json();}catch{fail('DRAW_BAD_RESPONSE');}
 };
 let b64,link;
 if(kind==='sdwebui'){
  const out=await post('/sdapi/v1/txt2img',{prompt,width,height,steps:24,...(model?{override_settings:{sd_model_checkpoint:model}}:{})});
  b64=out?.images?.[0];
 }else if(kind==='openai'){
  const out=await post('/images/generations',{model,prompt,size,n:1});
  b64=out?.data?.[0]?.b64_json;link=out?.data?.[0]?.url;
 }else fail('DRAW_KIND_INVALID');
 let bytes;
 if(typeof b64==='string'&&b64)bytes=Buffer.from(b64.replace(/^data:image\/\w+;base64,/,''),'base64');
 else if(typeof link==='string'&&/^https?:\/\//.test(link)){
  let res;try{res=await fetchImpl(link,{signal:combined});}catch{fail('DRAW_DOWNLOAD_FAILED');}
  if(!res.ok)fail('DRAW_DOWNLOAD_HTTP_'+res.status);
  bytes=Buffer.from(await res.arrayBuffer());
 }else fail('DRAW_NO_IMAGE_IN_RESPONSE');
 if(bytes.length<64||bytes.length>MAX)fail('DRAW_IMAGE_SIZE_INVALID');
 const png=bytes.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),jpeg=bytes[0]===0xff&&bytes[1]===0xd8,webp=bytes.subarray(8,12).toString()==='WEBP';
 if(!png&&!jpeg&&!webp)fail('DRAW_NOT_AN_IMAGE');
 return {bytes,extension:png?'png':jpeg?'jpg':'webp'};
}

/** Cheap reachability check for the settings page; never generates (and never bills for) an image. */
export async function probeDraw({kind,baseURL,apiKeyEnv},{fetchImpl=fetch,env=process.env}={}){
 const key=apiKeyEnv&&env[apiKeyEnv];
 const res=await fetchImpl(baseURL+(kind==='sdwebui'?'/sdapi/v1/sd-models':'/models'),{headers:key?{authorization:'Bearer '+key}:{},signal:AbortSignal.timeout(15000)});
 return {ok:res.ok,status:res.status};
}
