import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {NativeTasks} from '../src/native-tasks.mjs';

const scratch=path.resolve('.test-scratch');fs.mkdirSync(scratch,{recursive:true});

test('owner task uses native Agent, flushes durable input and records only idle assistant result',async t=>{
  const root=fs.mkdtempSync(path.join(scratch,'native-task-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let owner=true,guard;const messages=[];
  const agents={async create(options){
    await options.setup({tools:{restrict(){},guard(fn){guard=fn;}}});
    const session={deriveMessages:()=>[...messages,{role:'assistant',content:[{type:'text',text:'synthetic work done'}]}]};
    return {agent:{session,followup(m){messages.push(m);},async whenIdle(){}},async dispose(){}};
  }};
  const sessions={async flush(){return true;}};
  const manager=new NativeTasks({root,agents,sessions,model:{provider:'offline',model:'offline'},
    tools:['shell'],isOwner:id=>owner&&id==='owner',isPaused:()=>false});
  const submitted=await manager.submit({chatId:'owner',owner:true,args:{task:'synthetic job'}});
  assert.equal(messages[0].role,'user');assert.equal(typeof messages[0].id,'string');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(manager.status({chatId:'owner',owner:true,args:{jobId:submitted.jobId}}).status,'completed');
  assert.equal(guard({name:'shell'}),undefined);
  owner=false;assert.equal(guard({name:'shell'}),'TASK_OWNER_REVOKED');
  await assert.rejects(manager.submit({chatId:'owner',owner:true,args:{task:'untrusted'}}),/TASK_OWNER_REQUIRED/);
  await manager.close();
  const reopened=new NativeTasks({root,agents,sessions,tools:['shell'],isOwner:()=>true});
  assert.equal(reopened.status({chatId:'owner',owner:true,args:{jobId:submitted.jobId}}).result,'synthetic work done');
  await reopened.close();
});
