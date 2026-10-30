import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePlatform} from '../src/index.mjs';

test('mock driver is portable; live desktop driver fails closed without Windows',()=>{
  for(const platform of ['win32','darwin','linux'])assert.doesNotThrow(()=>validatePlatform('mock',platform));
  assert.doesNotThrow(()=>validatePlatform('live','win32'));
  for(const platform of ['darwin','linux'])assert.throws(()=>validatePlatform('live',platform),/LIVE_DRIVER_REQUIRES_WINDOWS/);
});
