import crypto from 'node:crypto';
const sha=s=>crypto.createHash('sha256').update(String(s)).digest('hex');
const FIELDS={input_tokens:'inputTokens',output_tokens:'outputTokens',cache_read_input_tokens:'cacheReadTokens',cache_creation_input_tokens:'cacheWriteTokens'};
export function createCaptureFetch({select=()=>false,append=()=>{},observe}={}){
 const emit=row=>{try{const pending=append(row);if(pending?.then)Promise.resolve(pending).catch(()=>{});}catch{}};
 return async function captured(baseFetch,context,url,init){
  let selected=false;try{selected=select(context)===true;}catch{}
  if(!selected)return baseFetch(url,init);
  const attempt_id=crypto.randomUUID(),started_at=new Date().toISOString();
  const meta={schema:'xq.wire-usage/v1',attempt_id,session_hash:sha(context.sessionId??''),route_hash:sha((context.provider??'')+'/'+(context.model??'')),started_at};
  let shape={bodyCaptured:false};
  if(typeof init?.body==='string'){
   meta.request_sha256=sha(init.body);
   // Bytes are diagnostics, never a token estimate or a mathematical token bound.
   shape.bodyBytesDiagnostic=Buffer.byteLength(init.body);
   if(shape.bodyBytesDiagnostic<=16*1024*1024)try{
    const body=JSON.parse(init.body);
    shape={...shape,bodyCaptured:true,systemPresent:body.system!==undefined,messageCount:Array.isArray(body.messages)?body.messages.length:null,toolCount:Array.isArray(body.tools)?body.tools.length:0,
      toolDeltaPresent:body.messages?.some(m=>Array.isArray(m.content)&&m.content.some(b=>['tool_addition','tool_removal'].includes(b.type)))??false};
    // Parsed COPY for a trusted offline observer. It cannot alter the wire string.
    if(observe)try{const pending=observe(body,{...meta});if(pending?.then){shape.counterObserverUnavailable=true;Promise.resolve(pending).catch(()=>{});}}catch{shape.counterObserverUnavailable=true;}
   }catch{shape.bodyParseUnavailable=true;}
  }
  emit({...meta,kind:'request_started',shape});
  let response;
  try{response=await baseFetch(url,init);}catch(error){emit({...meta,kind:'usage_unavailable',reason:'transport_unknown'});throw error;}
  if(!response.ok||!response.body){emit({...meta,kind:'usage_unavailable',reason:'http_or_empty_body',httpStatus:response.status});return response;}
  let usage={},invalid=false,started=false,stopped=false,finished=false,buffer='',decoder=new TextDecoder();
  const finish=reason=>{if(finished)return;finished=true;const complete=['eof','provider_terminal'].includes(reason)&&stopped&&!invalid&&Object.values(FIELDS).every(k=>Number.isSafeInteger(usage[k]));
   emit({...meta,kind:complete?'actual_usage':'usage_unavailable',complete,reason:complete?'provider_cumulative_final':reason,usage:{inputTokens:usage.inputTokens??null,outputTokens:usage.outputTokens??null,cacheReadTokens:usage.cacheReadTokens??null,cacheWriteTokens:usage.cacheWriteTokens??null},forecastPermission:false});};
  function event(line){
   if(!line.startsWith('data:'))return;
   const data=line.slice(5).trim();if(!data||data==='[DONE]')return;
   let value;try{value=JSON.parse(data);}catch{invalid=true;return;}
   if(value.type==='message_stop'){if(!started)invalid=true;stopped=true;finish('provider_terminal');return;}
   if(value.type==='error')invalid=true;
   if(!['message_start','message_delta'].includes(value.type))return;
   if(value.type==='message_start'){if(started||stopped)invalid=true;started=true;}else if(!started||stopped)invalid=true;
   const raw=value.type==='message_start'?value.message?.usage:value.usage;
   if(raw&&typeof raw==='object')for(const [wire,local]of Object.entries(FIELDS)){
    const n=raw[wire];if(n===undefined)continue;
    if(!Number.isSafeInteger(n)||n<0||(usage[local]!==undefined&&n<usage[local])){invalid=true;continue;}
    usage[local]=n; // Provider deltas contain cumulative buckets: replace, never sum.
   }
  }
  function feed(chunk){buffer+=decoder.decode(chunk,{stream:true});let i;
   while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).replace(/\r$/,'');buffer=buffer.slice(i+1);if(line.length>131072)invalid=true;else event(line);}
   if(buffer.length>131072){invalid=true;buffer='';}
  }
  const reader=response.body.getReader();
  const body=new ReadableStream({
   async pull(controller){try{const next=await reader.read();if(next.done){buffer+=decoder.decode();if(buffer.trim())invalid=true;finish('eof');controller.close();reader.releaseLock();}else{feed(next.value);controller.enqueue(next.value);}}
    catch(error){finish('stream_unknown');controller.error(error);}},
   async cancel(reason){finish('consumer_cancelled_unknown');return reader.cancel(reason);}
  },{highWaterMark:0});
  const wrapped=new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  for(const key of ['url','redirected','type'])try{Object.defineProperty(wrapped,key,{value:response[key]});}catch{}
  return wrapped;
 };
}
