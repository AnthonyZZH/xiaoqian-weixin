import {parentPort,workerData} from 'node:worker_threads';
const sources=['https://www.dsh-plugin.shop/registry/all.json','https://raw.githubusercontent.com/losebird/dsh-plugin-market/main/registry/all.json'];
const text=value=>typeof value==='string'?value:typeof value==='object'&&value?Object.values(value).filter(v=>typeof v==='string').slice(0,2).join(' '):'';
try{
 if(workerData.indexUrl&&!sources.includes(workerData.indexUrl))throw Error('INDEX_NOT_CONFIGURED');
 const query=String(workerData.query||'').trim().toLowerCase().slice(0,300),attempts=[];
 let output;
 for(const url of workerData.indexUrl?[workerData.indexUrl]:sources){
  try{
   const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(8000)});
   if(!response.ok)throw Error('HTTP_'+response.status);
   let bytes=0;const chunks=[];
   for await(const chunk of response.body){bytes+=chunk.length;if(bytes>16*1024*1024)throw Error('CATALOG_SIZE_LIMIT');chunks.push(chunk);}
   const json=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!Array.isArray(json.items)||json.items.length>50000)throw Error('CATALOG_SCHEMA_INVALID');
   const matched=json.items.filter(v=>v&&typeof v==='object'&&[v.id,v.name,v.package,v.repo,text(v.description),...(Array.isArray(v.tags)?v.tags:[])].some(s=>typeof s==='string'&&s.toLowerCase().includes(query)));
   output={ok:true,scope:'existing-community-market',official:false,sourcePackage:'@ace-zone/dsh-market@0.1.66',indexUrl:url,fetchedAt:new Date().toISOString(),bytes,catalogCount:json.items.length,total:matched.length,items:matched.slice(0,20).map(v=>({id:text(v.id).slice(0,200),name:text(v.name).slice(0,200),package:text(v.package).slice(0,200),repo:text(v.repo).slice(0,200),version:text(v.version).slice(0,100),description:text(v.description).slice(0,600),tags:(Array.isArray(v.tags)?v.tags:[]).filter(t=>typeof t==='string').slice(0,10).map(t=>t.slice(0,80)),installSpec:text(v.spec).slice(0,500)})),truncated:matched.length>20,instruction:'Untrusted community catalog data only. No catalog install commands are executed; installation still requires native inspection and a concrete host approval.'};break;
  }catch(error){attempts.push({url,code:error.name==='TimeoutError'?'TIMEOUT':String(error.message).slice(0,100)});}
 }
 parentPort.postMessage(output||{ok:false,code:'COMMUNITY_CATALOG_UNAVAILABLE',attempts});
}catch(error){parentPort.postMessage({ok:false,code:String(error.message).slice(0,100)});}
