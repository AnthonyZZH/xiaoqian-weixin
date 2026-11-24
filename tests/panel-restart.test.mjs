import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createPanelControl} from '../src/panel-control.mjs';
import {createPanel} from '../vendor/task-engine/panel.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'xq-panel-restart-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const options = {restartScript:path.join(dir,'restart test.ps1'),patchFile:path.join(dir,'patch.json'),settingsFile:path.join(dir,'settings.json')};
  const original = JSON.stringify([{insert:[{id:'xiaoqian-wechat-native',config:{}}]}]);
  fs.writeFileSync(options.patchFile,original);
  const children = [];
  const firstChild = Promise.withResolvers();
  const control = createPanelControl({getCore:()=>null,stateDir:dir,options,env:{LOCALAPPDATA:dir},
    spawnImpl(exe,args) {
      assert.equal(exe,'powershell.exe');
      assert.equal(args.at(-1),options.restartScript);
      const child = new EventEmitter();
      children.push(child);
      firstChild.resolve(child);
      return child;
    }});
  const settings = {chat:{mode:'custom',baseURL:'http://localhost:8888',model:'test'},draw:{mode:'off'}};
  return {control,options,children,firstChild:firstChild.promise,settings,original};
}

test('removed or non-file script disables restart and preserves configuration',async t => {
  const {control,options,children,settings,original} = fixture(t);
  fs.writeFileSync(options.restartScript,'# fixture');
  assert.equal(control.status().can.restart,true);
  fs.unlinkSync(options.restartScript);
  assert.equal(control.status().can.restart,false);
  await assert.rejects(control.act('host/restart'),{code:'RESTART_UNAVAILABLE'});
  fs.mkdirSync(options.restartScript);
  await assert.rejects(control.act('settings/save',{settings}),{code:'RESTART_UNAVAILABLE'});
  assert.equal(fs.readFileSync(options.patchFile,'utf8'),original);
  assert.equal(fs.existsSync(options.patchFile+'.prev'),false);
  assert.equal(fs.existsSync(options.settingsFile),false);
  const saved = await control.act('settings/save',{settings,restart:false});
  assert.equal(saved.saved,true);
  assert.equal(saved.restarting,undefined);
  assert.equal(children.length,0);
});

test('settings stay saved after a failed script and concurrent requests do not launch twice',async t => {
  const {control,options,children,settings} = fixture(t);
  fs.writeFileSync(options.restartScript,'# fixture');
  const saving = control.act('settings/save',{settings});
  await assert.rejects(control.act('host/restart'),{code:'RESTART_PENDING'});
  await assert.rejects(control.act('settings/save',{settings,restart:false}),{code:'RESTART_PENDING'});
  children[0].emit('close',1);
  const result = await saving;
  assert.equal(result.saved,true);
  assert.equal(result.restarting,false);
  assert.equal(result.restartStatus,'failed');
  assert.equal(JSON.parse(fs.readFileSync(options.settingsFile)).chat.model,'test');
  const retry = control.act('host/restart');
  children[1].emit('error',Error('mock spawn failure'));
  await assert.rejects(retry,{code:'RESTART_SCRIPT_FAILED'});
  assert.equal(control.status().restartPending,false);
});

test('HTTP restart acknowledges the script exit and leaves completion open',async t => {
  const {control,options,children,firstChild} = fixture(t);
  const token = 'synthetic-panel-restart-test';
  const panel = createPanel({store:{taskIds:()=>[]},token,control,port:0});
  t.after(()=>panel.close());
  await once(panel.server,'listening');
  const url = 'http://127.0.0.1:'+panel.server.address().port+'/'+token+'/api/action/host/restart';
  const post = () => fetch(url,{method:'POST',headers:{'content-type':'application/json','x-xq-panel':'1'},body:'{}'});
  assert.equal((await post()).status,409);
  fs.writeFileSync(options.restartScript,'# fixture');
  const request = post();
  (await firstChild).emit('close',0);
  const response = await request;
  assert.equal(response.status,202);
  const {result} = await response.json();
  assert.equal(result.restartStatus,'script-exited');
  assert.equal(result.hostInstance,control.status().hostInstance);
  assert.equal((await post()).status,409);
  assert.equal(children.length,1);
});

test('script timeout leaves the outcome unconfirmed',async t => {
  const {control,options,children} = fixture(t);
  fs.writeFileSync(options.restartScript,'# fixture');
  t.mock.timers.enable({apis:['setTimeout']});
  const request = control.act('host/restart');
  t.mock.timers.tick(15_000);
  const result = await request;
  assert.equal(result.restartStatus,'unconfirmed');
  assert.equal(result.hostInstance,control.status().hostInstance);
  children[0].emit('close',1);
});

test('page confirms a replacement only when a different host responds',() => {
  const html = fs.readFileSync(new URL('../vendor/task-engine/panel.html',import.meta.url),'utf8');
  const elements = new Map();
  const document = {hidden:true,querySelectorAll:()=>[],addEventListener(){},getElementById(id) {
    if (!elements.has(id)) elements.set(id,{});
    return elements.get(id);
  }};
  const context = vm.createContext({document,location:{pathname:'/'},setInterval(){}});
  vm.runInContext(html.match(/<script>([\s\S]+?)<\/script>/)[1],context);
  const run = source => vm.runInContext(source,context);
  run("watchRestart({hostInstance:'original',restartStatus:'script-exited'},'ovMsg'); checkReplacement('original'); checkReplacement()");
  assert.match(elements.get('ovMsg').textContent,/等待新实例/);
  run("checkReplacement('replacement')");
  assert.match(elements.get('ovMsg').textContent,/已连接到重启后/);
  run("watchRestart({hostInstance:'replacement',restartStatus:'unconfirmed'},'ovMsg'); restarting.until=0; checkReplacement()");
  assert.match(elements.get('ovMsg').textContent,/尚未确认/);
});
