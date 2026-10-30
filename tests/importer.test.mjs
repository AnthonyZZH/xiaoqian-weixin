import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {FeatureStore} from '../src/features.mjs';
import {LegacyImporter} from '../src/importer.mjs';

const chats=[{id:'owner',title:'Synthetic owner',mode:'private',owner:true},
  {id:'group',title:'Synthetic group',mode:'group',owner:false}];
const scratch=path.resolve('.test-scratch');fs.mkdirSync(scratch,{recursive:true});
const setup=t=>{
  const root=fs.mkdtempSync(path.join(scratch,'legacy-plan-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const features=new FeatureStore({stateDir:path.join(root,'features'),chats});
  const media={async importOriginal(){return {media_id:'synthetic'};}};
  const importer=new LegacyImporter({features,media,archiveRoot:path.join(root,'archive'),chats});
  return {root,features,importer};
};

test('operator-only migration plans safe facts, quarantines credentials, archives history without replay',async t=>{
  const {features,importer,root}=setup(t);
  const plan=importer.plan({chatId:'group',memory:{facts:['likes cats','API key: synthetic-secret'],style:'brief'},
    persona:'Friendly',history:[{role:'user',text:'old untrusted conversation'}]});
  assert.equal(plan.summary.facts,1);assert.equal(plan.summary.quarantined,1);
  assert.equal(plan.summary.willReplayMessages,false);
  await assert.rejects(importer.apply(plan,{confirmedDigest:'wrong'}),/IMPORT_PLAN_UNCONFIRMED/);
  const result=await importer.apply(plan,{confirmedDigest:plan.digest});
  assert.equal(result.status,'imported');
  assert.deepEqual(features.readMemory('group').facts,['likes cats']);
  assert.deepEqual(features.readMemory('owner').facts,[]);
  assert.equal(await importer.apply(plan,{confirmedDigest:plan.digest}).then(x=>x.status),'already_imported');
  assert.equal(fs.readdirSync(path.join(root,'archive')).some(x=>x.endsWith('-history.json')),true);
});

test('interrupted media import requires review instead of replaying partial writes',async t=>{
  const {root,features}=setup(t);
  const importRoot=path.join(root,'imports');fs.mkdirSync(importRoot);
  const file=path.join(importRoot,'synthetic.gif');fs.writeFileSync(file,Buffer.from('GIF89a'));
  const media={async importOriginal(){throw new Error('synthetic media failure');}};
  const importer=new LegacyImporter({features,media,archiveRoot:path.join(root,'archive2'),
    chats,allowedMediaRoot:importRoot});
  const plan=importer.plan({chatId:'group',memory:{facts:['safe note']},
    stickers:[{sourcePath:file,description:'synthetic'}]});
  await assert.rejects(importer.apply(plan,{confirmedDigest:plan.digest}),/synthetic media failure/);
  await assert.rejects(importer.apply(plan,{confirmedDigest:plan.digest}),/IMPORT_INCOMPLETE_REQUIRES_REVIEW/);
});
