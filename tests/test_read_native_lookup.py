import ast,pathlib,re,sys,types,unittest
D=pathlib.Path(__file__).resolve().parents[1]/'adapter'
def build(elements,unsupported=False):
 source=(D/'wechat_adapter.py').read_text(encoding='utf-8');names=('_native_exact_control','_native_title_control','current_title','current','validate')
 nodes=[n for n in ast.walk(ast.parse(source)) if isinstance(n,ast.FunctionDef) and n.name in names];stats={'conditions':[],'legacy':0}
 def prop(k,v):stats['conditions'].append((k,v));return (k,v)
 holder=types.SimpleNamespace(UIAutomationCore=types.SimpleNamespace(TreeScope_Descendants=4),IUIAutomation=types.SimpleNamespace(CreatePropertyCondition=prop,CreateAndCondition=lambda a,b:[a,b]))
 sys.modules['uiautomation.uiautomation']=types.SimpleNamespace(_AutomationClient=types.SimpleNamespace(instance=lambda:holder))
 def matching(e,c):
  return all(matching(e,x) for x in c) if isinstance(c,list) else getattr(e,c[0],None)==c[1]
 class Root:
  def FindFirst(self,scope,c):
   assert scope==4
   if unsupported:raise RuntimeError('unsupported')
   return next((e for e in elements if matching(e,c)),None)
  def FindAll(self,scope,c):
   assert scope==4
   if unsupported:raise RuntimeError('unsupported')
   found=[e for e in elements if matching(e,c)];return types.SimpleNamespace(Length=len(found),GetElement=lambda i:found[i])
 auto=types.SimpleNamespace(PropertyId=types.SimpleNamespace(ControlTypeProperty='ControlType',AutomationIdProperty='AutomationId',ClassNameProperty='ClassName'),ControlType=types.SimpleNamespace(TextControl='TextControl',EditControl='EditControl',GroupControl='GroupControl'),Control=types.SimpleNamespace(CreateControlFromElement=lambda x:x))
 ns={'auto':auto,'re':re,'chat_title':lambda x:x};exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='Adapter',bases=[],keywords=[],body=nodes,decorator_list=[])],type_ignores=[])),'actual-native-predicates','exec'),ns)
 a=ns['Adapter']();a.window=types.SimpleNamespace(Element=Root());a.check_window=lambda:None;a.mode='private';a.target='owner';return a,stats
def element(kind,id='',name='',cls=''):
 return types.SimpleNamespace(ControlType=kind,ControlTypeName=kind,AutomationId=id,CurrentAutomationId=id,Name=name,ClassName=cls,GetParentControl=lambda:None)
class Tests(unittest.TestCase):
 def tearDown(self):sys.modules.pop('uiautomation.uiautomation',None)
 def base(self):return [element('TextControl','big_title_line_h_view','owner'),element('GroupControl',cls='mmui::ChatTitleBarChatSingleView'),element('EditControl','chat_input_field')]
 def test_same_private_target_and_mode_validates(self):
  rows=self.base();a,s=build(rows);self.assertIs(a.validate(),rows[-1]);self.assertIn(('AutomationId','chat_input_field'),s['conditions'])
 def test_wrong_title_never_passes(self):
  rows=self.base();rows[0].Name='other';a,_=build(rows)
  with self.assertRaises(RuntimeError):a.validate()
 def test_wrong_mode_same_title_rejected(self):
  a,_=build([self.base()[0],self.base()[-1]])
  with self.assertRaises(RuntimeError):a.validate()
 def test_group_absence_is_exact_type_and_class_query(self):
  a,_=build([self.base()[0],self.base()[-1]]);a.mode='group';a.validate()
 def test_wrong_control_type_cannot_be_input(self):
  a,_=build(self.base()[:-1]+[element('TextControl','chat_input_field')])
  with self.assertRaises(RuntimeError):a.validate()
 def test_ambiguous_titles_fall_back_to_original(self):
  a,_=build(self.base()+[element('TextControl','other_big_title_line_h_view','hidden')]);self.assertEqual(a._native_title_control(),(False,None))
 def test_unsupported_provider_falls_back(self):
  a,_=build(self.base(),unsupported=True);self.assertEqual(a._native_exact_control('EditControl','AutomationId','chat_input_field'),(False,None));self.assertEqual(a._native_title_control(),(False,None))
if __name__=='__main__':unittest.main()
