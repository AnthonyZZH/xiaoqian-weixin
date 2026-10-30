import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EvidenceMemory} from '../src/evidence-memory.mjs';

const scratch=path.resolve('.test-scratch');fs.mkdirSync(scratch,{recursive:true});
const chats=[{id:'owner',title:'Synthetic owner',mode:'private',owner:true},
  {id:'group',title:'Synthetic group',mode:'group',owner:false}];

test('observed turn has a stable source ID and owner evidence cannot leak to group',t=>{
  const root=fs.mkdtempSync(path.join(scratch,'evidence-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let now=Date.UTC(2026,9,29,12);
  const memory=new EvidenceMemory({root,chats,clock:()=>now});
  assert.equal(memory.observe('owner',{id:'real-source-1',text:'I prefer jasmine tea'}),true);
  assert.equal(memory.observe('owner',{id:'real-source-1',text:'I prefer jasmine tea'}),false);
  assert.equal(memory.observeAssistantEcho('owner',{id:'outbound-1',text:'Tea noted'}),true);
  assert.equal(memory.observeAssistantEcho('owner',{id:'outbound-1',text:'Tea noted'}),false);
  assert.equal(memory.load('owner').turns.find(row=>row.id==='sent:outbound-1').evidenceKind,'wechat-ui-echo');
  const card=memory.confirmOwnerFact('owner',{key:'drink',content:'prefers jasmine tea',
    evidence:[{turnId:'real-source-1',quote:'jasmine tea'}],trustedOwnerRequest:true});
  assert.equal(card.tier,'long');
  assert.equal(memory.search('owner','jasmine tea').length,1);
  assert.deepEqual(memory.search('group','jasmine tea'),[]);
  assert.throws(()=>memory.confirmOwnerFact('group',{key:'x',content:'x',evidence:[]}),/EVIDENCE_OWNER_REQUIRED/);
  assert.throws(()=>memory.confirmOwnerFact('owner',{key:'x',content:'x',
    evidence:[{turnId:'missing',quote:'jasmine tea'}]}),/Evidence does not belong/);
  now+=2*86400000;
  assert.equal(memory.maintain('owner'),1);
  assert.equal(memory.load('owner').archive.length,1);
});
