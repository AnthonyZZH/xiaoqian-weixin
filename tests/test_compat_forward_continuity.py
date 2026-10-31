from pathlib import Path
import importlib.util,json,sqlite3,unittest,sys
from types import SimpleNamespace
p=str(Path(__file__).resolve().parents[1]/'compat/vendor/xiaoqian_driver/snapshot_identity.py');spec=importlib.util.spec_from_file_location('forward_candidate',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Test(unittest.TestCase):
 def setUp(self):
  self.db=sqlite3.connect(':memory:');m.initialize(self.db);m.recovery_initialize(self.db);self.chat=SimpleNamespace(key='owner');self.a=self.row('a');self.b=self.row('b')
 def row(self,text):return {'key':'raw-'+text,'text':text,'role':'user','sender':'synthetic'}
 def recover(self,rows,epoch='e1',seq=1,chat=None):
  chat=chat or self.chat;proof={'chat_key':chat.key,'page_digest':m.page_digest(rows),'at_live_edge':True,'controller_epoch':epoch,'viewport_generation':chat.key+':latest-native-navigation','sequence':seq}
  return m.recover_live_edge(self.db,chat,rows,proof,lambda p:p)
 def test_initial_is_shadow_future_tail_arrives(self):
  self.assertEqual(self.recover([self.a])[0],[]);r,_=self.recover([self.a,self.b],seq=2);self.assertEqual([x[0]['text'] for x in r],['b'])
 def test_restart_preserves_observation_and_emits_only_tail(self):
  self.recover([self.a]);r,_=self.recover([self.a,self.b],epoch='e2');self.assertEqual([x[0]['text'] for x in r],['b'])
 def test_restart_same_page_does_not_promote_shadow(self):
  self.recover([self.a]);self.assertEqual(self.recover([self.a],epoch='e2')[0],[])
 def test_no_overlap_stays_quarantined_then_future_recovers(self):
  self.recover([self.a]);self.assertEqual(self.recover([self.b],epoch='e2')[0],[]);r,_=self.recover([self.b,self.row('c')],epoch='e2',seq=2);self.assertEqual([x[0]['text'] for x in r],['c'])
 def test_cross_chat_separate(self):
  self.recover([self.a]);self.assertEqual(self.recover([self.a,self.b],chat=SimpleNamespace(key='group'))[0],[])
 def test_replayed_receipt_rejected(self):
  self.recover([self.a]);self.assertRaises(ValueError,self.recover,[self.a])
 def test_mismatched_receipt_rejected(self):
  self.assertRaises(ValueError,m.recover_live_edge,self.db,self.chat,[self.a],{},lambda p:{'chat_key':'other'})

if __name__=='__main__':unittest.main()
