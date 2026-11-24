import assert from 'node:assert/strict';
import {execFileSync, execSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';

test('the npm archive loads the plugin and the documented compatibility driver', async t => {
  const repo = path.dirname(import.meta.dirname);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoqian-package-'));
  t.after(() => fs.rmSync(scratch, {recursive: true, force: true}));

  const options = {
    cwd: repo,
    encoding: 'utf8',
    env: {...process.env, npm_config_pack_destination: scratch, npm_config_update_notifier: 'false'},
  };
  const args = ['pack', '--offline', '--ignore-scripts', '--json'];
  const output = process.env.npm_execpath
    ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], options)
    : execSync('npm pack --offline --ignore-scripts --json', options);
  const [archive] = JSON.parse(output);
  const paths = archive.files.map(file => file.path);
  for (const required of [
    'NOTICE.md', 'SOURCE.json', 'docs/PROVENANCE.md', 'compat/adapter/wechat_adapter.py',
    'compat/vendor/calendar-2026.json', 'vendor/owner-tools/pdf-deps.zip',
    'vendor/owner-tools/PYPDF-LICENSE', 'tools/mobile-status/mobile_status_server.pyw',
  ]) assert.ok(paths.includes(required), 'missing ' + required);
  assert.deepEqual(paths.filter(file =>
    /(^|\/)(__pycache__|tests?|node_modules)\/|(^|\/)(test_.*\.py|test\.mjs)$|\.test\.|\.bak|\.pyc$|^docs\/.+source.*\.json$/i.test(file)), []);

  execFileSync('tar', ['-xzf', path.join(scratch, archive.filename), '-C', scratch]);
  const unpacked = path.join(scratch, 'package');
  const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'package.json'), 'utf8'));
  const entry = await import(pathToFileURL(path.join(unpacked, manifest.exports['.'])).href);
  assert.equal(entry.name, 'xiaoqian-wechat-native');
  await entry.apply({}, {enabled: false});

  const config = {
    mode: 'fake', allow_real: false, chats: [{id: 'owner', title: 'SYNTHETIC', mode: 'private', owner: true}],
    adapter_root: path.join(unpacked, 'compat/adapter'), state_dir: path.join(scratch, 'state'),
    media_root: path.join(scratch, 'media'), schedule_path: path.join(scratch, 'schedule.db'),
    time_zone: 'UTC', initiative: {initiative_enabled: false},
  };
  const frames = [
    {id: 'init', operation: 'initialize', args: {config}},
    {id: 'health', operation: 'health'},
    {id: 'close', operation: 'close'},
  ];
  const python = process.env.XQ_TEST_PYTHON || 'python';
  const result = execFileSync(python, ['-I', '-B', path.join(unpacked, 'compat/driver/bridge_rpc.py')], {
    cwd: scratch,
    input: frames.map(frame => JSON.stringify(frame)).join('\n') + '\n',
    encoding: 'utf8',
    timeout: 20000,
  });
  const replies = result.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(replies.map(({id, status, code}) => [id, status, code]), [
    ['init', 'ok', 'DRIVER_READY'], ['health', 'ok', 'HEALTHY'], ['close', 'ok', 'CLOSED'],
  ]);
});
