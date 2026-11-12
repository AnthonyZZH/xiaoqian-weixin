import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createOwnerToolkit,createEnginePacer,searchRequest} from '../vendor/owner-tools/index.mjs';
import {createOwnerPageReader,pageRequests} from '../vendor/owner-tools/page-reader.mjs';
import {OWNER_SEARCH_GUIDE} from '../src/owner-integrations.mjs';

const agent={},exec=()=>({agent,callId:'call-1'});
async function toolkit(worker,pacer){
 const kit=await createOwnerToolkit({isCurrentOwner:()=>true,searchEnabled:true,worker,...(pacer?{pacer}:{})});
 return kit.bind({agent,bindingId:'binding'});
}

test('search arguments: several queries, one query, freshness and count are validated before the worker runs',()=>{
 assert.deepEqual(searchRequest({queries:['a',' b ']}),{operation:'search',queries:['a','b']});
 assert.deepEqual(searchRequest({query:'solo',freshness:'week',count:5}),{operation:'search',queries:['solo'],freshness:'week',count:5});
 assert.deepEqual(searchRequest({queries:'as text',freshness:''}),{operation:'search',queries:['as text']});
 for(const bad of [{},{queries:[]},{queries:['a','b','c','d','e']},{queries:[1]},{queries:['x'.repeat(301)]},{query:'a',freshness:'decade'},{query:'a',count:0},{query:'a',count:16},{query:'a',count:2.5}])
  assert.throws(()=>searchRequest(bad),/ARGUMENT_INVALID/,JSON.stringify(bad));
});

test('one search call carries every query to the worker and returns its answer',async()=>{
 const seen=[],bound=await toolkit(async request=>{seen.push(request);return{results:[{url:'https://a.example/1',title:'t'}],engines:{bing:'ok',sogou:'ok'},notes:[]};});
 const out=await bound.execute('owner_search',{queries:['千问4 发布','Qwen4 release'],freshness:'week'},exec());
 assert.deepEqual(seen,[{operation:'search',queries:['千问4 发布','Qwen4 release'],freshness:'week',skip:[]}]);
 assert.equal(out.results.length,1);assert.equal(out.same_as_previous,undefined);
 await assert.rejects(bound.execute('owner_search',{queries:[]},exec()),/ARGUMENT_INVALID/);
});

test('the same pages for different words are flagged, the same words again are not',async()=>{
 const pages=['https://a.example/1','https://a.example/2'];
 const bound=await toolkit(async()=>({results:pages.map(url=>({url})),engines:{bing:'ok'},notes:['kept']}));
 const first=await bound.execute('owner_search',{query:'千问4 发布'},exec());
 assert.equal(first.same_as_previous,undefined);
 const again=await bound.execute('owner_search',{query:'千问4 发布'},exec());
 assert.equal(again.same_as_previous,undefined);
 const reworded=await bound.execute('owner_search',{query:'Qwen 4 Max preview release'},exec());
 assert.equal(reworded.same_as_previous,true);
 assert.equal(reworded.notes[0],'kept');assert.match(reworded.notes[1],/完全一样/);
});

test('Sogou is spaced out and left alone after a verification page',async()=>{
 let clock=1_000_000;const pacer=createEnginePacer({now:()=>clock,spacingMs:4000,cooldownMs:60_000});
 const skips=[];let status='ok';
 const bound=await toolkit(async request=>{skips.push(request.skip);return{results:[],engines:{bing:'ok',...(request.skip.includes('sogou')?{sogou:'cooldown'}:{sogou:status})}};},pacer);
 await bound.execute('owner_search',{query:'a'},exec());
 await bound.execute('owner_search',{query:'b'},exec());          // too soon after the first
 clock+=5000;status='challenge';
 await bound.execute('owner_search',{query:'c'},exec());          // asked, answered with a verification page
 clock+=30_000;
 await bound.execute('owner_search',{query:'d'},exec());          // cooling down
 clock+=31_000;status='ok';
 await bound.execute('owner_search',{query:'e'},exec());          // cool-down over
 assert.deepEqual(skips,[[],['sogou'],[],['sogou'],[]]);
});

test('page arguments: one page, several pages at once, focus and offset',()=>{
 assert.deepEqual(pageRequests({url:'https://a.example/'}),[{operation:'fetch_page',url:'https://a.example/',offset:0,limit:12000}]);
 assert.deepEqual(pageRequests({url:'https://a.example/',focus:' 预览 上线 ',offset:12000}),[{operation:'fetch_page',url:'https://a.example/',offset:12000,limit:12000,focus:'预览 上线'}]);
 assert.deepEqual(pageRequests({urls:['https://a.example/','https://b.example/','https://a.example/']}).map(r=>[r.url,r.limit]),[['https://a.example/',5000],['https://b.example/',5000]]);
 for(const bad of [{},{url:5},{urls:[]},{urls:['a','b','c','d']},{url:'x'.repeat(2001)},{url:'https://a.example/',offset:-1},{url:'https://a.example/',offset:1.5},{urls:['https://a.example/','https://b.example/'],offset:10},{url:'https://a.example/',focus:'x'.repeat(201)}])
  assert.throws(()=>pageRequests(bad),/URL_INVALID|FOCUS_INVALID|OFFSET_INVALID/,JSON.stringify(bad));
});

test('several pages are read together and one failure does not cost the others',async()=>{
 const started=[];let release;const gate=new Promise(resolve=>{release=resolve;});
 const worker=async request=>{started.push(request.url);if(started.length===3)release();await gate;
  if(request.url.includes('broken'))throw Object.assign(new Error('PAGE_TIMEOUT'),{code:'PAGE_TIMEOUT'});
  return{status:'ok',url:request.url,text:'body of '+request.url};};
 const reader=createOwnerPageReader({isCurrentOwner:()=>true,worker}).bind(agent,'binding');
 const out=await reader.execute({urls:['https://a.example/','https://broken.example/','https://c.example/'],focus:'x'},{agent});
 assert.equal(started.length,3);   // all three were in flight before any finished
 assert.deepEqual(out.pages.map(page=>[page.status,page.url]),[['ok','https://a.example/'],['failed','https://broken.example/'],['ok','https://c.example/']]);
 assert.equal(out.pages[1].code,'PAGE_TIMEOUT');
 const single=await reader.execute({url:'https://a.example/'},{agent});
 assert.equal(single.text,'body of https://a.example/');
 await assert.rejects(reader.execute({url:'https://a.example/'},{agent:{}}),/OWNER_ONLY/);
});

test('the search guide is constant text that names both tools and the stale-result rule',()=>{
 assert.match(OWNER_SEARCH_GUIDE,/owner_search/);assert.match(OWNER_SEARCH_GUIDE,/owner_fetch/);
 assert.match(OWNER_SEARCH_GUIDE,/搜不到不等于没有/);assert.match(OWNER_SEARCH_GUIDE,/freshness/);
});

test('search engine parsing, merging, filtering and page reading (Python cases)',t=>{
 const python=process.env.XQ_TEST_PYTHON;
 if(!python){t.skip('XQ_TEST_PYTHON unavailable; Python cases remain unverified');return;}
 const result=spawnSync(python,['-X','utf8','-B',fileURLToPath(new URL('./web_search_cases.py',import.meta.url))],{encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/^ok 7/);
});

test('other chats search through the same engines: one query, five results, shared Sogou pacing',async()=>{
 const {createCapabilities}=await import('../src/capabilities.mjs');
 const seen=[];let clock=5_000_000;const pacer=createEnginePacer({now:()=>clock});
 const rows=Array.from({length:7},(_,i)=>({title:'t'+i,url:'https://a.example/'+i,date:'2026-11-11',snippet:'s'.repeat(400),engines:['bing'],site:'a.example'}));
 const search=createCapabilities({config:{searchEnabled:true},searchWorker:async request=>{seen.push(request);return{as_of:'2026-11-12 00:30 +0800',results:rows,engines:{bing:'ok',sogou:'challenge'},notes:['n']};},pacer}).search;
 const out=await search({args:{query:'今天 新闻',freshness:'day'}});
 assert.deepEqual(seen[0],{operation:'search',queries:['今天 新闻'],count:5,freshness:'day',skip:[]});
 assert.equal(out.results.length,5);assert.deepEqual(Object.keys(out.results[0]),['title','url','date','snippet']);assert.equal(out.results[0].snippet.length,300);
 assert.equal(out.as_of,'2026-11-12 00:30 +0800');assert.deepEqual(out.notes,['n']);
 await search({args:{query:'再搜一次'}});
 assert.deepEqual(seen[1].skip,['sogou']);   // the verification page above put Sogou on hold for everyone
 await assert.rejects(search({args:{query:''}}),/SEARCH_QUERY_INVALID/);
 assert.equal(createCapabilities({config:{}}).search,undefined);
});

test('the Harness repeat-call reminder leaves wechat_skip alone, and saving settings keeps it that way',async()=>{
 const {applySettings,DEFAULT_SETTINGS,REPEAT_REMINDER}=await import('../src/panel-settings.mjs');
 const base=[{id:'repeat-tool-reminder',name:'stale',config:{thresholds:[2]}},{insert:[{id:'xiaoqian-wechat-native',name:'x',config:{}}]}];
 const once=applySettings(base,DEFAULT_SETTINGS),twice=applySettings(once,DEFAULT_SETTINGS);
 for(const patch of [once,twice]){
  const entries=patch.filter(entry=>entry.id==='repeat-tool-reminder');
  assert.equal(entries.length,1);assert.deepEqual(entries[0],REPEAT_REMINDER);
 }
 assert.deepEqual(REPEAT_REMINDER.config.exclude,['wechat_skip']);
});
