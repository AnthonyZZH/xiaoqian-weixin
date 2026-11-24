import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const renderer = fileURLToPath(new URL('../tools/render-owner-deployment.mjs', import.meta.url));

test('mobile status attaches to the same bridge and owner tasks can be enabled independently', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xiaoqian-panel-registration-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  function render(file, ...flags) {
    const output = path.join(dir, file);
    execFileSync(process.execPath, [renderer, '--state-root', dir, '--python', process.execPath,
      '--owner-title', 'Fixture', '--native-package-root', dir, '--adapter-root', dir,
      '--output', output, ...flags]);
    return JSON.parse(readFileSync(output, 'utf8'))[0].insert;
  }
  const defaults = render('default.json');
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].config.ownerTasks, undefined);
  const statusOnly = render('status.json', '--mobile-status', 'true');
  assert.equal(statusOnly[0].config.ownerTasks, undefined);
  const [bridge, control] = render('tasks.json', '--mobile-status', 'true', '--owner-tasks', 'true');
  assert.equal(bridge.id, 'xiaoqian-wechat-native');
  assert.equal(bridge.config.ownerTasks.enabled, true);
  const plugin = await import(control.name);
  assert.equal(control.id, plugin.name);
  assert.ok(plugin.inject.includes('xiaoqianBridge'));
});
