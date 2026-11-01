import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {createBridge} from '../../src/index.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
test('default host wiring shares registry and configures native files without images or a model',async t=>{
 const folder=fs.mkdtempSync(path.join(here,'temporary-'));let bridge;t.after(async()=>{await bridge?.core.close();assert.equal(path.dirname(path.resolve(folder)),here);fs.rmSync(folder,{recursive:true,force:true});});
 const fileRoot=path.join(folder,'xwechat_files','fixture-account','msg','file');fs.mkdirSync(fileRoot,{recursive:true});
 const nativeProfile={verified:true,evidenceId:'SYNTHETIC_TEST_PROFILE',allowNativeReceive:true,hwnd:99,wechatPid:44,fileRoot,accountId:'fixture-account'};
 const config={mode:'mock',enabled:true,stateDir:path.join(folder,'state'),chats:[{id:'owner',title:'TEST_OWNER',mode:'private',owner:true}],attachments:{savedFilesEnabled:true,spoolDirectory:'owner-attachment-spool-r9',fileRoot,accountId:'fixture-account',nativeProfile}};
 bridge=await createBridge({agents:{create(){throw Error('MODEL_OR_AGENT_NOT_EXPECTED');},resume(){throw Error('MODEL_OR_AGENT_NOT_EXPECTED');}},sessions:{async flush(){return true;}}},config,{defineTool:d=>d});
 assert.equal(bridge.driver.options.nativeSavedFilesEnabled,true);assert.deepEqual(bridge.driver.options.nativeSavedFileProfile,nativeProfile);
 assert.equal(bridge.ownerSupplements.available().includes('owner_attachment_read'),true);assert.equal(typeof bridge.ownerAttachments.attachments.read,'function');assert.equal(bridge.core.imageInput,null);assert.equal(bridge.driver.child,null);assert.equal(fs.existsSync(path.join(config.stateDir,'owner-attachment-spool-r9')),true);
});
