import ast,pathlib,types,unittest
R=pathlib.Path(__file__).resolve().parents[1]
D=R/'adapter'
def methods():
 s=(D/'wechat_adapter.py').read_text(encoding='utf-8');t=ast.parse(s)
 nodes=[n for n in ast.walk(t) if isinstance(n,ast.FunctionDef) and n.name in ('current_title','current','open_chat','validate')]
 c=ast.ClassDef(name='A',bases=[],keywords=[],body=nodes,decorator_list=[]);m=ast.fix_missing_locations(ast.Module(body=[c],type_ignores=[]))
 ns={'chat_title':lambda x:x,'foreground':lambda:1,'time':__import__('time'),'visible_point':lambda *a:True}
 exec(compile(m,'actual-adapter-methods','exec'),ns);return ns['A']
class Window:
 def __init__(self):self.title='target';self.single=True;self.count=0
 def TextControl(self,**kw):return types.SimpleNamespace(Exists=lambda n:self.title is not None,Name=self.title)
 def GroupControl(self,**kw):
  self.count+=1;return types.SimpleNamespace(Exists=lambda n:self.single)
 def EditControl(self,**kw):return types.SimpleNamespace(Exists=lambda n:True)
class Tests(unittest.TestCase):
 def instance(self):
  a=methods()();a.window=Window();a.check_window=lambda:None;a._native_title_control=lambda:(False,None);a._native_exact_control=lambda *args:(False,None);a.target='target';a.mode='private';return a
 def test_open_existing_does_not_scan_unused_mode(self):
  a=self.instance();a.open_chat('target');self.assertEqual(a.window.count,0)
  a.validate();self.assertEqual(a.window.count,1)
 def test_mode_checked_fresh_each_validate(self):
  a=self.instance();a.validate();a.window.single=False
  with self.assertRaises(RuntimeError):a.validate()
  self.assertEqual(a.window.count,2)
 def test_changed_title_rejected(self):
  a=self.instance();a.window.title='different'
  with self.assertRaises(RuntimeError):a.validate()
 def test_no_cache_for_absent_title(self):
  a=self.instance();a.window.title=None;self.assertEqual(a.current(),(None,None));a.window.title='target';self.assertEqual(a.current(),('target',True))
 def test_other_methods_identical(self):
  def rest(path):
   t=ast.parse(path.read_text(encoding='utf-8'))
   for n in ast.walk(t):
    if isinstance(n,ast.ClassDef):n.body=[x for x in n.body if not(isinstance(x,ast.FunctionDef) and x.name in ('current_title','current','open_chat','validate','_native_exact_control','_native_title_control'))]
   return ast.dump(t,include_attributes=False)
  self.assertEqual(rest(R/'tests'/'fixtures'/'read-phase-adapter.before.py'),rest(D/'wechat_adapter.py'))
if __name__=='__main__':unittest.main()
