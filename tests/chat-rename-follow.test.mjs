import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {renameCandidate,applyChatAliases,createRenameFollower,aliasFile} from '../src/chat-rename.mjs';
import {DurableDriverClient} from '../driver/durable-client.mjs';

const tmp=()=>fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'xq-rename-'));
const owner={id:'owner',title:'主人',mode:'private',owner:true},group={id:'g',title:'老群名',wechatName:'群名二',mode:'group',owner:false};
const snapshot=(current,before,shown='群名二')=>({version:1,current:{names:current},lastSeen:{[shown]:{names:before}}});
const fail={status:'error',code:'backend_error'},ok={accepted:0,duplicate:1,ackable:[]};

test('a rename is recognised only when exactly one unknown name replaced the missing one',()=>{
 const before=['主人','群名二','同事甲','文件传输助手'];
 assert.equal(renameCandidate(snapshot(['主人','群名三','同事甲','文件传输助手'],before),'群名二',['主人','群名二']),'群名三');
 assert.equal(renameCandidate(snapshot(['主人','群名三','文件传输助手'],before),'群名二',['主人','群名二']),'群名三','other chats scrolling out of view do not matter');
 assert.equal(renameCandidate(snapshot(['主人','群名二','新朋友'],before),'群名二',['主人','群名二']),null,'the group is still there');
 assert.equal(renameCandidate(snapshot(['主人','群名三','新朋友','同事甲'],before),'群名二',['主人','群名二']),null,'two new names: ambiguous');
 assert.equal(renameCandidate(snapshot(['主人','同事甲'],before),'群名二',['主人','群名二']),null,'nothing new');
 assert.equal(renameCandidate(snapshot(['主人','另一个已配置的'],before),'群名二',['主人','群名二','另一个已配置的']),null,'never takes another configured chat');
 assert.equal(renameCandidate({version:1,current:{names:['群名三']},lastSeen:{}},'群名二',[]),null,'no earlier list to compare with');
 assert.equal(renameCandidate(null,'群名二',[]),null);
});

function rig(t,names){
 const stateDir=tmp();t.after(()=>fs.rmSync(stateDir,{recursive:true,force:true}));fs.mkdirSync(path.join(stateDir,'driver'));
 const write=s=>fs.writeFileSync(path.join(stateDir,'driver','session-names.json'),JSON.stringify(s));
 const renames=[],audits=[],reports=[],wakes=[];
 const follower=createRenameFollower({chats:[owner,group],stateDir,driver:{rename:async(id,name)=>{renames.push([id,name]);}},
  audit:code=>audits.push(code),report:code=>reports.push(code),wake:async(id,ctx)=>wakes.push([id,ctx.reason,ctx.note])});
 return {stateDir,write,renames,audits,reports,wakes,follower};
}
const flush=()=>new Promise(r=>setImmediate(r));

test('follows a renamed group after a few failed reads, remembers the name, and tells the owner once',async t=>{
 const x=rig(t);x.write(snapshot(['主人','群名三','同事甲'],['主人','群名二','同事甲']));
 await x.follower.observe(owner,fail);await x.follower.observe(group,fail);await x.follower.observe(group,fail);
 assert.deepEqual(x.renames,[],'one or two failures are not enough');
 await x.follower.observe(group,fail);
 assert.deepEqual(x.renames,[['g','群名三']]);assert.equal(x.follower.shown('g'),'群名三');
 const saved=JSON.parse(fs.readFileSync(aliasFile(x.stateDir)));assert.equal(saved.g.name,'群名三');assert.equal(saved.g.over,'群名二');
 await x.follower.observe(group,ok);await flush();
 assert.deepEqual(x.audits,['CHAT_RENAME_TRIED','CHAT_RENAME_FOLLOWED']);assert.equal(x.wakes.length,1);assert.equal(x.wakes[0][1],'chat_renamed');assert.match(x.wakes[0][2],/群名二.*群名三/);
 await x.follower.observe(group,ok);await flush();assert.equal(x.wakes.length,1);
 // Next start: the learned name applies over the unchanged configuration; a later manual edit of the configuration wins.
 assert.equal(applyChatAliases([owner,group],x.stateDir)[1].wechatName,'群名三');assert.equal(applyChatAliases([owner,group],x.stateDir)[1].title,'老群名');
 assert.equal(applyChatAliases([owner,{...group,wechatName:'手工改的新名'}],x.stateDir)[1].wechatName,'手工改的新名');
 assert.deepEqual(applyChatAliases([owner,group],tmp()),[owner,group]);
});

test('a wrong guess is undone and never tried again; private chats and paused polls are left alone',async t=>{
 const x=rig(t);x.write(snapshot(['主人','不是这个群'],['主人','群名二']));
 for(let i=0;i<3;i++)await x.follower.observe(group,fail);
 assert.deepEqual(x.renames,[['g','不是这个群']]);
 for(let i=0;i<7;i++)await x.follower.observe(group,fail);assert.equal(x.renames.length,1,'still giving the new name a chance');
 await x.follower.observe(group,fail);
 assert.deepEqual(x.renames.at(-1),['g','群名二']);assert.equal(x.follower.shown('g'),'群名二');assert.equal(fs.existsSync(aliasFile(x.stateDir))&&'g' in JSON.parse(fs.readFileSync(aliasFile(x.stateDir))),false);
 for(let i=0;i<20;i++)await x.follower.observe(group,fail);
 assert.equal(x.renames.length,2,'the rejected name is not tried again');assert.deepEqual(x.audits,['CHAT_RENAME_TRIED','CHAT_RENAME_REVERTED']);assert.equal(x.wakes.length,0);
 const y=rig(t);y.write(snapshot(['新名字'],['主人'],'主人'));
 for(let i=0;i<10;i++){await y.follower.observe(owner,fail);await y.follower.observe(group,{status:'paused'});}
 assert.deepEqual(y.renames,[]);
});

test('the driver client restarts its process with the new name',async t=>{
 const stateDir=tmp();t.after(()=>fs.rmSync(stateDir,{recursive:true,force:true}));
 const client=new DurableDriverClient({mode:'mock',python:process.env.XQ_TEST_PYTHON||'python',targets:[owner,group],stateDir:path.join(stateDir,'driver'),mediaRoot:path.join(stateDir,'media'),
  schedulePath:path.join(stateDir,'schedule.sqlite3'),mock:{}});
 t.after(()=>client.close());
 let stops=0;client._gracefulStop=async()=>{stops++;};
 await client.rename('g','群名三');
 assert.equal(client.targets.get('g').wechatName,'群名三');assert.equal(client.targets.get('g').title,'老群名');assert.equal(stops,1);
 await client.rename('g','老群名');assert.equal('wechatName' in client.targets.get('g'),false,'back to the identity name needs no alias');
 await assert.rejects(client.rename('nope','x'),/DRIVER_TARGET_DENIED/);await assert.rejects(client.rename('g',''),/CHAT_WECHAT_NAME_INVALID/);
});

test('driver side: the list watcher records what the conversation list showed when each chat was last in it',t=>{
 const python=process.env.XQ_TEST_PYTHON;assert.ok(python,'XQ_TEST_PYTHON required');
 const dir=tmp();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const module=fileURLToPath(new URL('../vendor/xiaoqian_driver/session_watch.py',import.meta.url));
 const script=`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('session_watch',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Adapter:
    def __init__(self):self.names=['主人','群名二','同事甲'];self.calls=0
    def sessions(self):
        self.calls+=1
        if self.names is None:raise RuntimeError('no list')
        return list(self.names)
class Backend:pass
b=Backend();b.adapter=Adapter();now=[0.0]
w=m.SessionWatch(sys.argv[2],['主人','群名二'],clock=lambda:now[0])
w.note(b);w.note(b);assert b.adapter.calls==1,'throttled'
now[0]=30;b.adapter.names=['主人','群名三','同事甲'];w.note(b)
b.adapter.names=None;w.note(b,force=True)
b.adapter=None;w.note(b,force=True)
again=m.SessionWatch(sys.argv[2],['主人','群名二'])
print(json.dumps(again.state,ensure_ascii=False))
`;
 const file=path.join(dir,'session-names.json'),run=spawnSync(python,['-X','utf8','-B','-c',script,module,file],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
 const state=JSON.parse(run.stdout);
 assert.deepEqual(state.current.names,['主人','同事甲','群名三']);
 assert.deepEqual(state.lastSeen['群名二'].names,['主人','同事甲','群名二'],'the list as it was while the old name was still there');
 assert.deepEqual(state.lastSeen['主人'].names,['主人','同事甲','群名三']);
 assert.equal(renameCandidate(state,'群名二',['主人','群名二']),'群名三');
});
