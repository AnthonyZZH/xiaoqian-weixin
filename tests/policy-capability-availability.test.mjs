import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedTools} from '../src/policy.mjs';

const owner={id:'synthetic-owner',mode:'private',owner:true};
const background=['owner_long_task','owner_long_task_status','owner_long_task_cancel'];

test('unconfigured legacy submission is hidden while status and isolated tools remain',()=>{
 const tools=allowedTools(owner,{taskManager:{tools:[]},ownerNativeTools:background});
 assert.equal(tools.has('wechat_task'),false);
 assert.equal(tools.has('wechat_task_status'),true);
 for(const name of background)assert.equal(tools.has(name),true);
});
test('configured legacy executor retains its submit and status tools',()=>{
 const tools=allowedTools(owner,{taskManager:{tools:['synthetic_scoped_tool']}});
 assert.equal(tools.has('wechat_task'),true);
 assert.equal(tools.has('wechat_task_status'),true);
});
test('custom capabilities without a built-in task manager retain previous behavior',()=>{
 const tools=allowedTools(owner,{});
 assert.equal(tools.has('wechat_task'),true);
 assert.equal(tools.has('wechat_task_status'),true);
});
test('group never inherits private shell, file, library or isolated-task tools',()=>{
 const tools=allowedTools({id:'synthetic-group',mode:'group',owner:false},{taskManager:{tools:[]},ownerNativeTools:[...background,'owner_powershell','owner_file_read','owner_file_write','xiaoqian_library_search']});
 assert.equal([...tools].some(name=>/^(owner_|xiaoqian_library)/.test(name)),false);
});
