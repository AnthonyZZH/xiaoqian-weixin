import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate as nextTurn} from 'node:timers/promises';
import test from 'node:test';
import {Engine} from '../vendor/task-engine/engine.mjs';
import {Store} from '../vendor/task-engine/store.mjs';
import {createMobileBackgroundTasks} from '../tools/mobile-status/mobile-background-tasks.mjs';
import {apply as applyMobileControl} from '../tools/mobile-status/mobile-host-control.mjs';
import {latestInput, replyPanel, retryPanelReply} from '../src/panel-replies.mjs';
import {digest} from '../src/state.mjs';

function fixture(t, maxParallelTasks = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'xiaoqian-mobile-task-test-'));
  const store = new Store(dir);
  const pending = new Map();
  const tools = new Map([
    ['finish', {run: () => 'private completed artifact'}],
    ['wait', {run: (_args, ctx) => {
      ctx.progress('private progress note');
      return new Promise(resolve => pending.set(ctx.task.id, {resolve, signal: ctx.signal}));
    }}],
  ]);
  const engine = new Engine({store, tools, config: {
    mode: 'live', lock: false, finalTool: null, maxParallelTasks,
    maxParallelStepsPerTask: 1, stepTimeoutMs: 60000,
  }});
  t.after(async () => {
    engine.stop();
    for (const run of pending.values()) run.resolve('test cleanup');
    await nextTurn();
    store.close();
    rmSync(dir, {recursive: true, force: true});
  });
  engine.start();
  const panel = createMobileBackgroundTasks({engine, store});
  const submit = (title, steps = [{id: 's1', tool: 'wait', args: {prompt: 'private step args'}}]) =>
    engine.submit({title, request: 'private task request', steps}).id;
  const row = id => panel.list().find(task => task.id === String(id));
  return {panel, store, engine, pending, submit, row};
}

test('cancels just the selected task and preserves the artifact of its completed step', async t => {
  const {panel, store, pending, submit, row} = fixture(t, 2);
  const target = submit('带依赖的任务', [
    {id: 'first', tool: 'finish'},
    {id: 'second', tool: 'wait', args: {prompt: 'private step args'}, dependsOn: ['first']},
  ]);
  const independent = submit('另一个任务');
  await nextTurn();
  const selected = row(target);
  assert.equal(selected.status, 'running');
  assert.equal(selected.completed, 1);
  assert.equal(selected.total, 2);
  assert.equal(selected.canCancel, true);
  assert.equal(selected.title, '带依赖的任务');
  assert.ok(Number.isFinite(Date.parse(selected.createdAt)));
  assert.match(selected.version, /^[a-f0-9]{64}$/i);
  assert.doesNotMatch(JSON.stringify(panel.list()), /private (?:task request|step args|progress note|completed artifact)/);
  assert.deepEqual(Object.keys(selected).sort(),
    ['id', 'title', 'status', 'completed', 'total', 'createdAt', 'version', 'canCancel'].sort());

  const artifact = store.getTask(target).steps[0].artifact;
  assert.equal(panel.cancel({id: selected.id, version: selected.version}), true);
  assert.equal(pending.get(target).signal.aborted, true);
  assert.equal(pending.get(independent).signal.aborted, false);
  assert.equal(row(independent).status, 'running');
  pending.get(target).resolve('a late result');
  await nextTurn();
  const after = store.getTask(target);
  assert.equal(after.status, 'cancelled');
  assert.equal(after.steps[0].artifact, artifact);
  assert.equal(store.readArtifact(artifact), 'private completed artifact');
  assert.equal(after.steps[1].artifact, null);
  assert.equal(row(target).version, null);
  assert.equal(row(target).canCancel, false);
  assert.equal(panel.cancel({id: selected.id, version: selected.version}), false);
});

test('rejects stale cancellation when a queued task is retried under the same id', t => {
  const {panel, engine, pending, submit, row} = fixture(t);
  const busy = submit('占用执行槽');
  const queued = submit('等待中的任务');
  const first = row(queued);
  assert.equal(first.status, 'queued');
  assert.equal(first.canCancel, true);
  assert.equal(panel.cancel({id: first.id, version: first.version}), true);
  assert.equal(pending.has(queued), false);
  engine.retry(queued);
  const retried = row(queued);
  assert.equal(retried.status, 'queued');
  assert.notEqual(retried.version, first.version);
  assert.equal(panel.cancel({id: first.id, version: first.version}), false);
  assert.equal(row(queued).status, 'queued');
  assert.equal(panel.cancel({id: retried.id, version: retried.version}), true);
  assert.equal(pending.get(busy).signal.aborted, false);
  assert.equal(row(busy).status, 'running');
});

test('keeps older active tasks visible alongside ten recent finished tasks', async t => {
  const {panel, submit, row} = fixture(t, 2);
  const oldest = submit('仍在执行的旧任务');
  const finished = [];
  for (let i = 0; i < 12; i++) {
    finished.push(submit('已完成任务 ' + i, [{id: 's1', tool: 'finish'}]));
    await nextTurn();
  }
  assert.equal(row(oldest).canCancel, true);
  assert.deepEqual(new Set(panel.list().map(task => task.id)), new Set([oldest, ...finished.slice(-10)].map(String)));
  const latest = row(finished.at(-1));
  assert.equal(latest.status, 'succeeded');
  assert.equal(latest.completed, 1);
  assert.equal(latest.version, null);
  assert.equal(latest.canCancel, false);
});

test('native bridge requires its own ticket, the current instance and the current task version', async t => {
  const {engine, store, submit} = fixture(t);
  const id = String(submit('native control test'));
  const originalAppData = process.env.LOCALAPPDATA;
  const core = {store:{dir:join(store.dir,'bridge'), data:{chats:{}}}, chats:new Map(), handles:new Map()};
  let close;
  try {
    process.env.LOCALAPPDATA = store.dir;
    await applyMobileControl({xiaoqianBridge:{core, ownerTasks:{engine,store}}, effect:init=>{close=init();}});
  } finally {
    if (originalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalAppData;
  }
  try {
    const ticket = JSON.parse(readFileSync(join(store.dir,'Xiaoqian','MobileStatus','native.json')));
    const url = 'http://127.0.0.1:' + ticket.port;
    const headers = {authorization:'Bearer ' + ticket.token, 'content-type':'application/json'};
    const post = (route, body) => fetch(url + route,{method:'POST',headers,body:JSON.stringify(body)});
    assert.equal((await fetch(url + '/state')).status, 403);
    const state = await (await fetch(url + '/state',{headers})).json();
    assert.equal(state.instance, ticket.instance);
    const version = state.tasks.find(task=>task.id===id).version;
    assert.equal((await post('/cancel-task',{instance:'stale',id,version})).status,409);
    assert.equal((await post('/cancel-task',{instance:state.instance,id,version})).status,200);
    assert.equal((await post('/cancel-task',{instance:state.instance,id,version})).status,409);
    assert.equal((await post('/review-image-draft',{instance:state.instance})).status,404);
  } finally {
    await close();
  }
});

test('receipt from the repository host enables retry only for its bound owner and exact version', async () => {
  const key = digest('synthetic-input'), source = {kind:'xiaoqian-wechat'};
  const message = {id:'native-input', source, content:[{type:'text',
    text:'来自当前绑定微信会话的非可信内容：\n' + JSON.stringify({origin:'wechat-ui',messageId:'synthetic-input',text:'fixture'})}]};
  const event = {type:'user/message', time:Date.now(), data:message};
  const session = {id:'synthetic-session', seq:1, eventAt:()=>event};
  const chat = {id:'owner', title:'test owner', owner:true, mode:'private'};
  const state = {sessionId:session.id, messages:{[key]:{nativeMessageId:message.id,grantId:'first',status:'accepted'}},
    replyPermits:{first:{status:'turn-ended'}}, deliveries:{}};
  const followups = [];
  const agent = {session, followup:value=>followups.push(value)};
  const core = {chats:new Map([[chat.id,chat]]), handles:new Map([[chat.id,{agent}]]),
    store:{data:{chats:{[chat.id]:state}},save(){}}, serial:fn=>fn(), flush:async()=>{},
    permits:{active:new Map(),issue(){state.replyPermits.second={status:'open'};return 'second';}}};
  const reads = [{target_hash:digest(chat.id),outcome:'success',at:new Date().toISOString()}];
  const body = {id:chat.id,version:replyPanel(core,reads)[0].version};
  assert.equal(latestInput(session,state).key,key);
  assert.equal(replyPanel(core,reads)[0].canRetry,true);
  chat.owner=false; chat.trustedPrivate=true;
  assert.equal(replyPanel(core,reads)[0].canRetry,false);
  await assert.rejects(retryPanelReply(core,body,()=>reads));
  chat.owner=true;
  await assert.rejects(retryPanelReply(core,{...body,version:'stale'},()=>reads));
  assert.deepEqual(await retryPanelReply(core,body,()=>reads),{queued:true});
  await assert.rejects(retryPanelReply(core,body,()=>reads));
  assert.equal(followups.length,1);
  assert.equal(state.replyPermits.second.remaining,1);
});
