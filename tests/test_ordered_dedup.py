from pathlib import Path
import sys,tempfile,json,hashlib,unittest
ROOT=Path(__file__).resolve().parent
LIVE=ROOT.parent/'vendor'
# Load changed state/helper inside actual installed protocol package, without UI.
sys.path.insert(0,str(LIVE))
import xiaoqian_driver
# Use only the repository package under test.
sys.modules.pop('xiaoqian_driver.state',None)
from xiaoqian_driver.state import StateStore
from xiaoqian_driver.protocol import Chat,SendResult,digest
A=Chat('synthetic A');B=Chat('synthetic B','group')
def row(key,text='same',role='user',sender='member',**extra):return dict(key=key,text=text,role=role,sender=sender,odd=False,text_complete=True,text_source='synthetic_complete',**extra)
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir=ROOT);self.addCleanup(self.tmp.cleanup);self.path=Path(self.tmp.name)/'state.sqlite';self.s=StateStore(self.path);self.addCleanup(lambda:self.s.close())
 def ack(self,result):self.s.ack([m.message_id for m in result.messages])
 def test_ack_then_runtime_rebuild(self):
  r=self.s.ingest(A,[row('a','anchor'),row('b')]);ids=[m.message_id for m in r.messages];self.ack(r)
  r=self.s.ingest(A,[row('x','anchor'),row('y')]);self.assertEqual(r.messages,());self.assertEqual(r.duplicate_count,2)
 def test_new_identical_text_preserved(self):
  r=self.s.ingest(A,[row('a','anchor'),row('b')]);self.ack(r)
  r=self.s.ingest(A,[row('a','anchor'),row('b'),row('c')]);self.assertEqual(len(r.messages),1);self.assertEqual(r.messages[0].source_key,'c')
 def test_A_new_B_old_then_B_new_A_old(self):
  self.ack(self.s.ingest(A,[row('a','A anchor')]));self.ack(self.s.ingest(B,[row('b','B anchor')]))
  r=self.s.ingest(A,[row('a2','A anchor'),row('a3','newA')]);self.assertEqual(len(r.messages),1);self.ack(r)
  self.assertEqual(self.s.ingest(B,[row('b2','B anchor')]).messages,())
  r=self.s.ingest(B,[row('b3','B anchor'),row('b4','newB')]);self.assertEqual(len(r.messages),1);self.ack(r)
  self.assertEqual(self.s.ingest(A,[row('a4','A anchor'),row('a5','newA')]).messages,())
 def test_restart_persistent_identity(self):
  self.ack(self.s.ingest(A,[row('a','anchor'),row('b')]));self.s.close();self.s=StateStore(self.path)
  self.assertEqual(self.s.ingest(A,[row('x','anchor'),row('y')]).messages,())
 def test_new_same_text_other_sender_and_chat(self):
  self.ack(self.s.ingest(A,[row('a','anchor')]));r=self.s.ingest(A,[row('a','anchor'),row('b',sender='other')]);self.assertEqual(len(r.messages),1)
  self.assertEqual(len(self.s.ingest(B,[row('a','anchor')]).messages),1)
 def test_outbound_echo_quarantine_not_permanent_text_blacklist(self):
  self.ack(self.s.ingest(A,[row('a','anchor')]))
  self.s.reserve('op','fp',{'chat':A.to_dict(),'text':'outgoing'});self.s.finish(SendResult('op','success','sent'))
  r=self.s.ingest(A,[row('a','anchor'),row('b','outgoing')]);self.assertEqual(r.messages,())
  r=self.s.ingest(A,[row('x','anchor'),row('y','outgoing')]);self.assertEqual(r.messages,())
  r=self.s.ingest(A,[row('x','anchor'),row('y','outgoing'),row('z','outgoing',sender='other')]);self.assertEqual(len(r.messages),1)
 def test_no_anchor_defers_instead_of_replaying_history(self):
  self.ack(self.s.ingest(A,[row('a','anchor')]))
  self.assertEqual(self.s.ingest(A,[row('x','unknown page')]).messages,());self.assertEqual(self.s.last_identity_defer,'snapshot_without_order_anchor')
 def test_same_raw_key_different_body_cannot_upgrade_preview(self):
  first=row('preview','old preview');first['text_complete']=False
  self.assertEqual(len(self.s.ingest(A,[first]).deferred),1)
  result=self.s.ingest(A,[row('preview','unrelated full text')])
  self.assertEqual(result.messages,())
  self.assertIsNotNone(self.s.last_identity_defer)
if __name__=='__main__':
 result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Tests));report={'tests':result.testsRun,'passed':result.wasSuccessful(),'failures':len(result.failures),'errors':len(result.errors),'ui':'mock-only'}
 (ROOT/'test-results.json').write_text(json.dumps(report),encoding='utf-8');print(json.dumps(report));sys.exit(not result.wasSuccessful())
