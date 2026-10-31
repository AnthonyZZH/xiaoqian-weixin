import ast,hashlib,hmac,json,pathlib,sys,types,unittest
R=pathlib.Path(__file__).resolve().parents[1]
D=R/'compat'/'vendor'/'xiaoqian_driver'
class DriverError(Exception):pass
class Tests(unittest.TestCase):
 def run_read(self,reject=False,edit_change=False):
  source=(D/'owner_edge_controller.py').read_text(encoding='utf-8');t=ast.parse(source)
  nodes=[n for n in t.body if isinstance(n,ast.FunctionDef) and n.name in ('read_latest','encoded')]
  module=ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[]));events=[]
  control=types.SimpleNamespace(GetRuntimeId=lambda:(1,),Exists=lambda x:True,SetFocus=lambda:events.append('focus'))
  sys.modules['uiautomation']=types.SimpleNamespace(GetFocusedControl=lambda:control,SendKeys=lambda *a,**k:events.append('navigate'))
  from contextlib import nullcontext
  ns={'DriverError':DriverError,'phase':lambda *a:nullcontext(),'hashlib':hashlib,'hmac':hmac,'json':json}
  exec(compile(module,'actual-controller','exec'),ns)
  class Adapter:
   hwnd=1
   window=types.SimpleNamespace(ListControl=lambda **kw:control,SetActive=lambda **kw:None)
   def validate(self):
    events.append('validate')
    if reject and 'navigate' in events:raise DriverError('target_changed')
    return object()
   def input_value(self,edit):return 'changed' if edit_change and 'read_rows' in events else 'draft'
   def read(self):
    self.validate();events.append('read_rows');return []
  a=Adapter();chat=types.SimpleNamespace(key='synthetic');backend=types.SimpleNamespace(adapter=a,chat=chat,module=types.SimpleNamespace(foreground=lambda:1),_edge_sequence=0,_edge_epoch='synthetic',_edge_secret=b'x'*32)
  try:result=ns['read_latest'](backend,chat,selected=a)
  finally:sys.modules.pop('uiautomation',None)
  return result,events,backend
 def test_navigation_still_freshly_validated(self):
  result,e,b=self.run_read();self.assertEqual(result,[]);i=e.index('navigate');self.assertEqual(e[i+1:i+3],['validate','read_rows']);self.assertTrue(b.last_controller_receipt)
 def test_changed_target_rejected_after_navigation(self):
  with self.assertRaises(DriverError):self.run_read(reject=True)
 def test_user_draft_change_rejected(self):
  with self.assertRaises(DriverError):self.run_read(edit_change=True)
 def test_actual_adapter_read_validates_before_every_ui_access(self):
  t=ast.parse((R/'adapter'/'wechat_adapter.py').read_text(encoding='utf-8'));n=next(n for n in ast.walk(t) if isinstance(n,ast.FunctionDef) and n.name=='read');self.assertEqual(ast.unparse(n.body[0]),'self.validate()')
 def test_open_chat_starts_with_checked_live_title(self):
  t=ast.parse((R/'adapter'/'wechat_adapter.py').read_text(encoding='utf-8'));n=next(n for n in ast.walk(t) if isinstance(n,ast.FunctionDef) and n.name=='open_chat');self.assertIsInstance(n.body[1],ast.If);self.assertIn('self.current_title()',ast.unparse(n.body[1].test));title=next(n for n in ast.walk(t) if isinstance(n,ast.FunctionDef) and n.name=='current_title');self.assertEqual(ast.unparse(title.body[1]),'self.check_window()')
if __name__=='__main__':unittest.main()
