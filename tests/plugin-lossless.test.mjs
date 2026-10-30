import test from 'node:test';
import assert from 'node:assert/strict';
import {pluginListDto,optionalJson} from '../vendor/owner-tools/plugin-management/lossless-data.mjs';

test('native plugin DTO retains all rows and omits absent optional fields',()=>{
  const bundles=[{name:'synthetic-a',version:undefined,error:undefined,installed:true,enabled:false,availability:'profile'},{name:'synthetic-b',version:'1.0.0',error:undefined,availability:'installation'}];
  const plugins=[{entryId:'synthetic-1',moduleName:'synthetic-module',status:'active',disabled:false,state:{count:0}},{entryId:'synthetic-2',moduleName:'synthetic-other',state:undefined}];
  const value=pluginListDto(bundles,plugins);
  assert.equal(value.bundles.length,2);assert.equal(value.plugins.length,2);
  assert.equal(Object.hasOwn(value.bundles[0],'version'),false);assert.equal(Object.hasOwn(value.bundles[0],'error'),false);
  assert.equal(value.bundles[0].enabled,false);assert.deepEqual(value.plugins[0].state,{count:0});
  assert.deepEqual(JSON.parse(JSON.stringify(value)),value);
  assert.deepEqual(value.counts,{listedBundles:2,profileInstalled:1,availableBundles:2,pluginEntries:2});
});

test('incompatible retained values fail rather than becoming empty registries',()=>{
  for(const value of [BigInt(1),NaN,Infinity,-0,()=>{},Symbol('synthetic'),new Map(),new Date()])assert.throws(()=>optionalJson({retained:value}));
  assert.throws(()=>optionalJson([undefined]));assert.throws(()=>optionalJson(new Array(1)));
  const cyclic={};cyclic.self=cyclic;assert.throws(()=>optionalJson(cyclic));
  const accessor={};Object.defineProperty(accessor,'secret',{enumerable:true,get(){throw Error('MUST_NOT_INVOKE')}});assert.throws(()=>optionalJson(accessor),/ACCESSOR_DATA/);
  assert.throws(()=>pluginListDto(null,[]),/LIST_NOT_ARRAY/);
});
