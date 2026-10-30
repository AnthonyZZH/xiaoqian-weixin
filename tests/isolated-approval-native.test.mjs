import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const nativeRoot=process.env.XQ_NATIVE_PACKAGE_ROOT||'C:/xiaoqian/app/dsh/node_modules/@deepseek-ai/';
test('isolated owner task with global ApprovalService uses real native lifecycle with offline provider and original-session completion',t=>{
 assert.ok(fs.existsSync(path.join(nativeRoot,'cordis/lib/index.js')),'installed Harness required: native acceptance must not silently skip');
 const base=path.join(project,'.test-scratch');fs.mkdirSync(base,{recursive:true});
 const scratch=fs.mkdtempSync(path.join(base,'isolated-owner-native-'));
 assert.equal(path.dirname(scratch),base);
 t.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
 const child=path.join(project,'tests/helpers/isolated-approval-native-child.mjs');
 const p=spawnSync(process.execPath,[child,project,scratch],{cwd:project,encoding:'utf8',timeout:35000,windowsHide:true,env:{...process.env,XQ_NATIVE_PACKAGE_ROOT:nativeRoot}});
 assert.equal(p.status,0,p.stderr||p.error?.stack||p.stdout);
 const result=JSON.parse(p.stdout.trim().split(/\r?\n/).at(-1));
 for(const key of ['ok','nativeLifecycle','offlineProvider','taskIDImmediate','independentAgent','foregroundProgress','personaCAS','completionInOriginalSession','queryReadback','nativeCancellation','noDuplicate'])assert.equal(result[key],true,key);
 assert.equal(result.networkAttempts,0);assert.equal(result.wechatSends,0);assert.equal(result.paidCalls,0);
 assert.equal(result.physicalFakeRequests,2);assert.deepEqual(result.errors,[]);
});
