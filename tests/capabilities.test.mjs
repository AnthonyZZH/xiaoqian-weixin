import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCapabilities} from '../src/capabilities.mjs';
import {allowedTools,authorize} from '../src/policy.mjs';

const scratch=path.resolve('.test-scratch');fs.mkdirSync(scratch,{recursive:true});
const workerPath=path.join(path.dirname(fileURLToPath(import.meta.url)),'helpers','fake-capability-worker.py');
const group={id:'group',title:'Synthetic',mode:'group',owner:false,drawEnabled:true,webSearch:true};

test('configured group search and local drawing run outside UI queue with a persisted quota',async t=>{
  const root=fs.mkdtempSync(path.join(scratch,'capability-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const imported=[],approved=[];
  const media={async importOriginal(scope,file){imported.push({scope,file});return {media_id:'m_'+String(imported.length).padStart(32,'0')};},
    async approve(id,{scope}){approved.push({id,scope});},
    async previewForVision(){return {base64:'c3ludGhldGlj',label:'静态截图；原始动画未知'};}};
  const config={chats:[group],searchEnabled:true,forge:{enabled:true,url:'http://127.0.0.1:7860',model:'synthetic'},
    vision:{enabled:true,url:'http://127.0.0.1:1234/v1/chat/completions',model:'synthetic'},
    drawDailyLimit:1,timeZone:'UTC'};
  const caps=createCapabilities({config,media,generatedRoot:root,workerPath});
  assert.ok(allowedTools(group,caps).has('wechat_search'));
  assert.ok(allowedTools(group,caps).has('wechat_draw'));
  authorize(group,'wechat_draw');
  assert.equal((await caps.search({args:{query:'offline'}}))[0].title,'Synthetic');
  const described=await caps.describeImage({chatId:'group',args:{id:'m_'+'0'.repeat(32)}});
  assert.equal(described.description,'Synthetic image description');
  assert.equal(described.animationFramesAnalyzed,false);
  const made=await caps.draw({chatId:'group',args:{prompt:'synthetic square'}});
  assert.equal(made.status,'ready_to_send');
  assert.equal(imported.length,1);assert.equal(approved.length,1);
  await assert.rejects(caps.draw({chatId:'group',args:{prompt:'another'}}),/DRAW_DAILY_LIMIT/);
  assert.equal(imported.length,1);
  const denied={...group,drawEnabled:false,webSearch:false};
  assert.equal(allowedTools(denied,caps).has('wechat_draw'),false);
  assert.throws(()=>authorize(denied,'wechat_draw'),/TOOL_SCOPE_DENIED/);
});
