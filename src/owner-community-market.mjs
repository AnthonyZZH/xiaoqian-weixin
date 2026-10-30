import {Worker} from 'node:worker_threads';
export const COMMUNITY_INDEXES=['https://www.dsh-plugin.shop/registry/all.json','https://raw.githubusercontent.com/losebird/dsh-plugin-market/main/registry/all.json'].map(url=>({url,type:'existing-community-market',official:false,sourcePackage:'@ace-zone/dsh-market@0.1.66'}));
export function searchCommunityMarket({query,indexUrl,signal}={}){
 if(indexUrl&&!COMMUNITY_INDEXES.some(v=>v.url===indexUrl))return Promise.reject(Error('INDEX_NOT_CONFIGURED'));
 if(signal?.aborted)return Promise.reject(Error('CANCELLED'));
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./community-market-worker.mjs',import.meta.url),{workerData:{query:String(query||'').slice(0,300),indexUrl},resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16}});
  let done=false;const finish=async(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);await worker.terminate();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>void finish(Error('MARKET_TOTAL_TIMEOUT')),20000),abort=()=>void finish(Error('CANCELLED'));
  signal?.addEventListener('abort',abort,{once:true});
  worker.once('message',value=>void finish(null,value));worker.once('error',()=>void finish(Error('MARKET_WORKER_FAILED')));worker.once('exit',()=>{if(!done)void finish(Error('MARKET_WORKER_EXITED'));});
 });
}
