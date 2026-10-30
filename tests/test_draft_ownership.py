from pathlib import Path
import ast,sys,unittest
from types import SimpleNamespace as NS
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'adapter'))
import wechat_boundary as b
class Edit:
 def __init__(self,value=''):self.value=value;self.token=(1,);self.writes=[];self.replace_after_type=False
 def GetRuntimeId(self):return self.token
 def GetValuePattern(self):return NS(SetValue=self.set)
 def set(self,value,**kwargs):self.value=value;self.writes.append(value)
 def SendKeys(self,text,**kwargs):self.value=self.value+text if not self.replace_after_type else 'USER EDITED'
def adapter(value=''):
 source=ast.parse((ROOT/'adapter/wechat_adapter.py').read_text(encoding='utf-8'));cls=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=='WeChatAdapter');mention=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='mention')
 unit=ast.Module(body=[ast.ImportFrom(module='__future__',names=[ast.alias(name='annotations')],level=0),ast.ClassDef(name='A',bases=[],keywords=[],body=[mention],decorator_list=[])],type_ignores=[]);ns={'MENTION_CHIP':'\ufffc','begin_owned_edit':b.begin_owned_edit,'finish_owned_edit':b.finish_owned_edit};exec(compile(ast.fix_missing_locations(unit),'actual-adapter-mention','exec'),ns)
 a=ns['A']();edit=Edit(value);a.target='SYNTHETIC';a.mode='group';a.hwnd=1;a.input_value=lambda e:e.value;a.validate=lambda:edit;a.wait_for=lambda fn,*args:fn();a.window=NS(WindowControl=lambda **kwargs:NS(Exists=lambda *args:False));return a,edit
class Tests(unittest.TestCase):
 def test_actual_failed_mention_cleans_exact_owned_typed_at(self):
  a,e=adapter()
  def send(a):
   if not a.mention(e,'member',lambda:False):raise b.SendNotAttempted('mention_preparation_failed')
  with self.assertRaises(b.SendNotAttempted) as hit:b.guarded_send(send,lambda:1)(a)
  self.assertEqual((hit.exception.cleanup,e.value,e.writes),('cleared_owned','',['']))
 def test_user_edit_during_actual_mention_is_not_cleared(self):
  a,e=adapter();e.replace_after_type=True
  def send(a):
   if not a.mention(e,'member',lambda:False):raise b.SendNotAttempted()
  with self.assertRaises(b.SendNotAttempted):b.guarded_send(send,lambda:1)(a)
  self.assertEqual((e.value,e.writes),('USER EDITED',[]))
 def test_focus_change_preserves_even_owned_draft(self):
  a,e=adapter();focus=[1]
  def send(a):b.write_owned(a,e,'OWN');focus[0]=2;raise RuntimeError('SYNTHETIC')
  with self.assertRaises(b.SendNotAttempted):b.guarded_send(send,lambda:focus[0])(a)
  self.assertEqual(e.value,'OWN')
 def test_post_click_unknown_does_not_cleanup_or_retry(self):
  a,e=adapter();clicks=[]
  def send(a):b.write_owned(a,e,'OWN');b.mark_click(a);clicks.append(1);raise RuntimeError('SYNTHETIC')
  with self.assertRaises(b.SendUncertain):b.guarded_send(send,lambda:1)(a)
  self.assertEqual((clicks,e.value),([1],'OWN'))
 def test_existing_manual_whitespace_cannot_be_claimed(self):
  a,e=adapter('  ')
  def send(a):self.assertIsNone(b.begin_owned_edit(a,e));raise b.SendNotAttempted()
  with self.assertRaises(b.SendNotAttempted):b.guarded_send(send,lambda:1)(a)
  self.assertEqual((e.value,e.writes),('  ',[]))
 def test_no_click_never_becomes_success(self):
  a,e=adapter()
  with self.assertRaises(b.SendNotAttempted) as hit:b.guarded_send(lambda a:b.write_owned(a,e,'  INDENTED  '),lambda:1)(a)
  self.assertEqual(hit.exception.code,'send_not_clicked');self.assertEqual(e.writes,['  INDENTED  ',''])
 def test_confirmed_click_restore_error_does_not_become_retry(self):
  a,e=adapter()
  def send(a):b.mark_click(a);b.mark_confirmed(a);raise RuntimeError('restore failed')
  self.assertEqual(b.guarded_send(send,lambda:1)(a),[])
 def test_reused_control_identity_does_not_authorize_cleanup(self):
  a,e=adapter()
  def send(a):b.write_owned(a,e,'OWN');e.token=(2,);raise b.SendNotAttempted()
  with self.assertRaises(b.SendNotAttempted):b.guarded_send(send,lambda:1)(a)
  self.assertEqual(e.value,'OWN')
if __name__=='__main__':unittest.main(verbosity=2,testRunner=unittest.TextTestRunner(stream=sys.stdout,verbosity=2))