import importlib.util,sys,tempfile,sqlite3,unittest
from pathlib import Path
from types import SimpleNamespace
from contextlib import contextmanager
@contextmanager
def connection(path):
 d=sqlite3.connect(path)
 try:
  with d:yield d
 finally:d.close()
spec=importlib.util.spec_from_file_location('journal',str(Path(__file__).resolve().parents[1]/'compat/vendor/xiaoqian_driver/draft_journal.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Edit:
 def __init__(self):self.value='';self.id=[1,2,3];self.writes=0
 def GetRuntimeId(self):return self.id
 def GetValuePattern(self):return self
 def SetValue(self,v,**kw):self.value=v;self.writes+=1
class Adapter:
 def __init__(self):self.mode='private';self.target='SYNTHETIC';self.hwnd=22;self.window=SimpleNamespace(ProcessId=44);self.edit=Edit();self._draft_context={'operation':'op1','chat':'chat1'};self.reads=0;self.mutateAt=None
 def input_value(self,e):
  self.reads+=1
  if self.reads==self.mutateAt:e.value='manual edit'
  return e.value
 def validate(self):return self.edit
class Test(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='synthetic-draft-',dir=Path.cwd());self.root=Path(self.tmp.name);self.db=self.root/'driver.sqlite3';self.a=Adapter();self.j=m.DraftJournal(self.root/'journal',self.db)
  with connection(self.db) as d:d.executescript('create table sends(operation_id text,status text);create table outbound_identity(op text,chat text,body text)');d.execute('insert into sends values(?,?)',('op1','unknown'));d.execute('insert into outbound_identity values(?,?,?)',('op1','chat1',m.hash_text('owned')))
  self.a.edit.value='owned';self.j.written(self.a,self.a.edit,'owned');self.a.reads=0
 def tearDown(self):self.tmp.cleanup()
 def test_unknown_clear_without_resend(self):
  self.assertEqual(self.j.recover(self.a,'chat1'),'cleared_owned');self.assertEqual(self.a.edit.writes,1)
  with connection(self.db) as d:self.assertEqual(d.execute('select status from sends').fetchone()[0],'unknown')
 def test_postclick_unknown_clear(self):self.j.phase(self.a,'click_started');self.assertEqual(self.j.recover(self.a,'chat1'),'cleared_owned')
 def test_manual_edit_preserved_permanently(self):
  self.a.edit.value='manual';self.assertEqual(self.j.recover(self.a,'chat1'),'foreign_draft_preserved');self.a.edit.value='owned';self.assertEqual(self.j.recover(self.a,'chat1'),'no_owned_residual')
 def test_race_preserved(self):self.a.mutateAt=4;self.assertIn('preserved',self.j.recover(self.a,'chat1'));self.assertEqual(self.a.edit.writes,0)
 def test_edit_identity_change_preserved(self):self.a.edit.id=[9];self.assertEqual(self.j.recover(self.a,'chat1'),'foreign_draft_preserved')
 def test_other_process_preserved(self):self.a.window.ProcessId=99;self.assertEqual(self.j.recover(self.a,'chat1'),'foreign_draft_preserved')
 def test_wrong_target_preserved(self):self.a.target='OTHER';self.assertEqual(self.j.recover(self.a,'chat1'),'wrong_chat')
 def test_pending_operation_preserved(self):
  with connection(self.db) as d:d.execute("update sends set status='pending'")
  self.assertEqual(self.j.recover(self.a,'chat1'),'operation_not_recoverable')
 def test_wrong_body_in_ledger_preserved(self):
  with connection(self.db) as d:d.execute("update outbound_identity set body='other'")
  self.assertEqual(self.j.recover(self.a,'chat1'),'operation_not_recoverable')
 def test_restart_reloads_witness(self):self.j=m.DraftJournal(self.root/'journal',self.db);self.assertEqual(self.j.recover(self.a,'chat1'),'cleared_owned')
 def test_confirmed_not_cleaned(self):self.j.phase(self.a,'confirmed');self.assertEqual(self.j.recover(self.a,'chat1'),'no_owned_residual')
 def test_empty_tombstone_prevents_later_same_manual_text_clear(self):self.a.edit.value='';self.assertEqual(self.j.recover(self.a,'chat1'),'already_empty');self.a.edit.value='owned';self.assertEqual(self.j.recover(self.a,'chat1'),'no_owned_residual')
 def test_different_chat_is_separate(self):self.assertEqual(self.j.recover(self.a,'chat2'),'no_owned_residual')

if __name__=='__main__':unittest.main()
