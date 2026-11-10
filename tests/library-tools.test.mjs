import test from 'node:test';
import assert from 'node:assert/strict';
import {registerOwnerLibraryTools,isRotationArchive} from '../vendor/library-adapter/index.mjs';
import {OWNER_LIBRARY_GUIDE} from '../src/owner-integrations.mjs';

const note=i=>({title:'笔记'+i,permalink:'main/20-偏好/笔记'+i,file_path:'20-偏好/笔记'+i+'.md'});
const arch=i=>({title:'xqrotation abc part '+i,permalink:'main/xiaoqian-session-archive/xqrotation-abc-part-'+i,file_path:'xiaoqian-session-archive/xqrotation-abc-part-'+i+'.md'});
function rig(results){
  const calls=[],tools={},agent={};
  const adapter={isOwner:()=>true,health:async()=>({ok:true}),call:async(chatId,op,args)=>{calls.push([op,args]);return {ok:true,project:'main',operation:op,data:{results,page:args.page??1,page_size:args.page_size,total:results.length}};}};
  registerOwnerLibraryTools({agentCtx:{tools:{register:t=>{tools[t.name]=t;}}},agent,chatId:'owner',adapter,defineTool:d=>d,isActive:()=>true});
  return {calls,tools,run:(name,args)=>tools[name].execute(args,{agent})};
}
test('owner search hides rotation archives and returns up to 8 notes by default',async()=>{
  const x=rig([arch(1),note(1),arch(2),note(2),arch(3),...Array.from({length:10},(_,i)=>note(i+3))]);
  const r=await x.run('xiaoqian_library_search',{query:'主人'});
  assert.equal(r.ok,true);assert.equal(r.data.results.length,8);assert.equal(r.data.hiddenArchive,3);
  assert.ok(r.data.results.every(v=>!isRotationArchive(v)));
  assert.deepEqual(x.calls[0],['search',{query:'主人',page:undefined,page_size:20}]);
});
test('page_size is honoured and validated',async()=>{
  const x=rig([note(1),note(2),note(3)]);
  assert.equal((await x.run('xiaoqian_library_search',{query:'a',page_size:2})).data.results.length,2);
  const bad=await x.run('xiaoqian_library_search',{query:'a',page_size:99});assert.equal(bad.ok,false);assert.equal(bad.code,'LIBRARY_ARGUMENT_INVALID');
  const extra=await x.run('xiaoqian_library_search',{query:'a',url:'http://x'});assert.equal(extra.code,'LIBRARY_ARGUMENT_DENIED');
});
test('archive detection matches rotation notes only',()=>{
  assert.equal(isRotationArchive(arch(1)),true);assert.equal(isRotationArchive(note(1)),false);
  assert.equal(isRotationArchive({title:'xqrotation 1 manifest',permalink:null,file_path:null}),true);
});
test('tool descriptions and guide tell her when to look things up',()=>{
  const x=rig([]);assert.match(x.tools.xiaoqian_library_search.description,/关键词/);
  for(const k of ['先查再答','记不记得','关键词','不用查','不要编','群'])assert.ok(OWNER_LIBRARY_GUIDE.includes(k),k);
});
