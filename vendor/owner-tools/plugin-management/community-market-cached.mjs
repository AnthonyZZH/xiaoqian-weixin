import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
export const COMMUNITY_INDEXES=['https://www.dsh-plugin.shop/registry/all.json','https://raw.githubusercontent.com/losebird/dsh-plugin-market/main/registry/all.json'].map(url=>({url,type:'existing-community-market',official:false}));
export function createCachedMarket({cacheDir,python='python',refreshTimeoutMs=110000,canonicalGithubApi=false}={}){
 if(!cacheDir||refreshTimeoutMs<1000||refreshTimeoutMs>120000)throw Error('MARKET_CONFIG_INVALID');
 const children=new Set(),flights=new Map(),last=new Map();let closed=false;
 function run(request,timeoutMs,signal){return new Promise((resolve,reject)=>{
 if(closed||signal?.aborted){reject(Error('CANCELLED'));return;}
 const env={PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'};for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
 const child=spawn(python,['-B','-u',fileURLToPath(new URL('./market_cache_worker.py',import.meta.url))],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});children.add(child);
 let done=false,size=0;const chunks=[];
 const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
 const kill=code=>{child.kill();finish(Error(code))};const abort=()=>kill('CANCELLED');const timer=setTimeout(()=>kill('MARKET_PROCESS_TIMEOUT'),timeoutMs);signal?.addEventListener('abort',abort,{once:true});
 child.stdout.on('data',chunk=>{size+=chunk.length;if(size>1024*1024)kill('MARKET_OUTPUT_LIMIT');else chunks.push(chunk)});child.stderr.resume();child.on('error',()=>{children.delete(child);finish(Error('MARKET_PROCESS_FAILED'))});child.stdin.on('error',()=>finish(Error('MARKET_WRITE_FAILED')));
 child.on('close',code=>{children.delete(child);if(done)return;if(code!==0){finish(Error('MARKET_PROCESS_FAILED'));return;}try{finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{finish(Error('MARKET_BAD_RESPONSE'))}});
 child.stdin.end(JSON.stringify({cacheDir,canonicalGithubApi:canonicalGithubApi===true,...request}));
 });}
 function validate(indexUrl){if(indexUrl&&!COMMUNITY_INDEXES.some(v=>v.url===indexUrl))throw Error('INDEX_NOT_CONFIGURED');return indexUrl||'all';}
 function refresh({query='',indexUrl,signal}={}){
 const key=validate(indexUrl);if(flights.has(key))return flights.get(key);
 const job=run({query:String(query).slice(0,300),indexUrl:indexUrl||null,refresh:true,refreshBudgetSeconds:Math.max(1,Math.floor(refreshTimeoutMs/1000)-10)},refreshTimeoutMs,signal).catch(error=>({ok:false,code:error.message,noResults:false,attempts:[]})).then(value=>{last.set(key,{at:Date.now(),ok:value.ok,code:value.code||null,attempts:value.attempts||[],catalogCount:value.catalogCount??null,fetchedAt:value.fetchedAt||null});return value;}).finally(()=>flights.delete(key));
 flights.set(key,job);return job;
 }
 return{refresh,async search({query='',indexUrl,signal,refresh:force=false}={}){
 const key=validate(indexUrl);if(force)return refresh({query,indexUrl,signal});
 const cached=await run({query:String(query).slice(0,300),indexUrl:indexUrl||null,cacheOnly:true},10000,signal);
 const previous=last.get(key),cooldown=previous&&!previous.ok&&Date.now()-previous.at<60000;
 if((!cached.ok||cached.refreshRequired)&&!flights.has(key)&&!cooldown)void refresh({query,indexUrl});
 if(cached.ok)return{...cached,refreshing:flights.has(key)};
 return{ok:false,code:flights.has(key)?'CATALOG_REFRESHING':'COMMUNITY_CATALOG_UNAVAILABLE',cacheStatus:'missing-or-expired',noResults:false,refreshing:flights.has(key),attempts:previous?.attempts||[],lastRefreshCode:previous?.code||null,instruction:'目录尚在加载或不可用，不是零条搜索结果；稍后重试或查看刷新状态。'};
 },status(){return{refreshing:flights.size,previous:[...last.values()]};},close(){closed=true;for(const child of children)child.kill();}};
}

