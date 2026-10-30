import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=process.env.XQ_NATIVE_PACKAGE_ROOT||'C:/xiaoqian/app/dsh/node_modules/@deepseek-ai/';

test('installed rc.4 Cordis plugin creates and resumes same Agent with offline model',t=>{
  if(!fs.existsSync(path.join(root,'cordis','lib','index.js'))){t.skip('Set XQ_NATIVE_PACKAGE_ROOT to installed Harness namespace');return;}
  const scratch=path.join(project,'.test-scratch');fs.mkdirSync(scratch,{recursive:true});
  const state=fs.mkdtempSync(path.join(scratch,'native-rc4-'));
  t.after(()=>fs.rmSync(state,{recursive:true,force:true}));
  const child=path.join(project,'tests','helpers','native-child.mjs');
  const run=mode=>{
    const p=spawnSync(process.execPath,[child,mode,state],{cwd:project,encoding:'utf8',timeout:15000,
      env:{...process.env,XQ_NATIVE_PACKAGE_ROOT:root}});
    assert.equal(p.status,0,`native ${mode}: ${p.stderr||p.error||p.stdout}`);
    const lines=p.stdout.trim().split(/\r?\n/);return JSON.parse(lines.at(-1));
  };
  const first=run('create'),second=run('resume');
  assert.equal(first.sessionId,second.sessionId);
  assert.equal(first.users,1);assert.equal(second.users,2);
  assert.deepEqual(first.errors,[]);assert.deepEqual(second.errors,[]);
  assert.equal(second.offline,true);
});
