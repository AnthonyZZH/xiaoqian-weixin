import ast,pathlib,types,unittest
D=pathlib.Path(__file__).resolve().parents[1]/'adapter'
def adapter(mode='private',single=True,parentClass='mmui::ChatTitleBarChatSingleView',stale=False):
 s=(D/'wechat_adapter.py').read_text(encoding='utf-8');t=ast.parse(s);methods=[n for n in ast.walk(t) if isinstance(n,ast.FunctionDef) and n.name in ('current_title','current','validate')]
 ns={'chat_title':lambda x:x};exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='A',bases=[],keywords=[],body=methods,decorator_list=[])],type_ignores=[])),'actual-private-title-methods','exec'),ns)
 stats={'global':0,'ancestor':0,'matched':0};root=types.SimpleNamespace(ClassName=parentClass,ControlTypeName='WindowControl',GetParentControl=lambda:None)
 def parent():
  stats['ancestor']+=1
  if stale:raise RuntimeError('stale')
  return root
 title=types.SimpleNamespace(Name='same',Exists=lambda n:True,GetParentControl=parent)
 def group(**kw):stats['global']+=1;return types.SimpleNamespace(Exists=lambda n:single)
 a=ns['A']();a.mode=mode;a.target='same';a.check_window=lambda:None;a._native_title_control=lambda:(False,None);a._native_exact_control=lambda *args:(False,None);a.window=types.SimpleNamespace(TextControl=lambda **kw:title,GroupControl=group,EditControl=lambda **kw:types.SimpleNamespace(Exists=lambda n:True));a._read_phases=types.SimpleNamespace(emit=lambda stage,event:stats.update(matched=stats['matched']+int(stage=='private_mode_live_ancestor')))
 return a,stats,title
class Tests(unittest.TestCase):
 def test_private_live_positive_witness_replaces_global_scan(self):
  a,s,t=adapter();a.validate();self.assertEqual(s,{'global':0,'ancestor':1,'matched':1})
 def test_unknown_path_keeps_original_lookup(self):
  a,s,t=adapter(parentClass='Unknown');a.validate();self.assertEqual(s['global'],1)
 def test_same_named_group_cannot_pass_private_mode(self):
  a,s,t=adapter(single=False,parentClass='Unknown')
  with self.assertRaises(RuntimeError):a.validate()
 def test_group_mode_does_not_infer_from_name_or_ancestors(self):
  a,s,t=adapter(mode='group',single=False);a.validate();self.assertEqual(s['ancestor'],0);self.assertEqual(s['global'],1)
 def test_stale_parent_falls_back(self):
  a,s,t=adapter(stale=True);a.validate();self.assertEqual(s['global'],1)
 def test_changed_title_rejected_even_with_private_ancestor(self):
  a,s,t=adapter();t.Name='other'
  with self.assertRaises(RuntimeError):a.validate()
if __name__=='__main__':unittest.main()
