import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const nativeRoot=process.env.XQ_NATIVE_PACKAGE_ROOT||'C:/xiaoqian/app/dsh/node_modules/@deepseek-ai/';

test('installed rc.4 native Schedule saves future task and restores catalog after Host restart',t=>{
  if(!fs.existsSync(path.join(nativeRoot,'dsh-schedule','lib','index.js'))){
    t.skip('Set XQ_NATIVE_PACKAGE_ROOT to installed Harness namespace');return;
  }
  const scratch=path.join(project,'.test-scratch');fs.mkdirSync(scratch,{recursive:true});
  const state=fs.mkdtempSync(path.join(scratch,'native-schedule-'));
  t.after(()=>fs.rmSync(state,{recursive:true,force:true}));
  const child=path.join(project,'tests','helpers','native-schedule-child.mjs');
  const env={XQ_NATIVE_PACKAGE_ROOT:nativeRoot};
  for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
  const run=mode=>{
    const p=spawnSync(process.execPath,[child,state,mode],{cwd:project,encoding:'utf8',timeout:20000,env});
    assert.equal(p.status,0,`native schedule ${mode}: ${p.stderr||p.error||p.stdout}`);
    return JSON.parse(p.stdout.trim().split(/\r?\n/).at(-1));
  };
  const created=run('create'),restored=run('verify');
  assert.equal(created.flush,true);
  assert.equal(created.taskId,restored.taskId);
  assert.equal(created.sessionId,restored.sessionId);
  assert.equal(restored.restored,true);
});

test('due native reminder exposes producer before model and commits with no model call',t=>{
  if(!fs.existsSync(path.join(nativeRoot,'dsh-schedule','lib','index.js'))){
    t.skip('Set XQ_NATIVE_PACKAGE_ROOT to installed Harness namespace');return;
  }
  const scratch=path.join(project,'.test-scratch');fs.mkdirSync(scratch,{recursive:true});
  const state=fs.mkdtempSync(path.join(scratch,'native-schedule-due-'));
  t.after(()=>fs.rmSync(state,{recursive:true,force:true}));
  const child=path.join(project,'tests','helpers','native-schedule-child.mjs');
  const env={XQ_NATIVE_PACKAGE_ROOT:nativeRoot};
  for(const k of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[k])env[k]=process.env[k];
  const p=spawnSync(process.execPath,[child,state,'due'],{cwd:project,encoding:'utf8',timeout:15000,env});
  assert.equal(p.status,0,`native schedule due: ${p.stderr||p.error||p.stdout}`);
  const result=JSON.parse(p.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.delivered,true);
  assert.equal(result.producer,'schedule');
  assert.equal(result.presteps,1);
  assert.equal(result.modelCalls,0);
});
