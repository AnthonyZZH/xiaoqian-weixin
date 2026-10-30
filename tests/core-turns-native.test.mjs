import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('installed rc.4 dispatches scoped permits for queued native turns and dynamic persona with offline adapter',()=>{
 const helper=fileURLToPath(new URL('./helpers/native-core-turns-child.mjs',import.meta.url));
 const result=spawnSync(process.execPath,[helper],{encoding:'utf8',timeout:15000,env:process.env});
 assert.equal(result.status,0,result.stderr||String(result.error)||result.stdout);
 const evidence=JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
 assert.equal(evidence.actualToolDispatches,2);assert.deepEqual(evidence.deliveries,['unknown','ok']);assert.equal(evidence.personaDynamic,true);
});
