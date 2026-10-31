import ast,json,multiprocessing as mp,tempfile,time,unittest
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'compat'/'vendor'))
from xiaoqian_driver.read_phases import ReadPhases
R=Path(__file__).resolve().parents[1]
D=R/'.test-scratch'/'read-phases';D.mkdir(parents=True,exist_ok=True)
def hung(root):
 r=ReadPhases(root,8)
 with r.request('timeout_fixture'):
  with r.phase('adapter_read'):time.sleep(30)
class Tests(unittest.TestCase):
 def test_normal_and_exception(self):
  with tempfile.TemporaryDirectory(dir=D) as d:
   r=ReadPhases(d,1)
   with r.request('synthetic'):
    with r.phase('adapter_import'):pass
   with self.assertRaises(ValueError):
    with r.request('error_fixture'):
     with r.phase('adapter_read'):raise ValueError('private text not recorded')
   data=Path(d,'read-phases-python.jsonl').read_text(encoding='utf-8');rows=[json.loads(x) for x in data.splitlines()]
   self.assertNotIn('private',data);self.assertIsNone(r.request_id)
   self.assertEqual([x['event'] for x in rows if x['request_id']=='error_fixture'],['enter','enter','error','error'])
 def test_killed_process_retains_last_phase(self):
  with tempfile.TemporaryDirectory(dir=D) as d:
   p=mp.Process(target=hung,args=(d,));p.start()
   try:
    deadline=time.monotonic()+5;path=Path(d,'read-phases-python.jsonl')
    while time.monotonic()<deadline:
     if path.exists() and 'adapter_read' in path.read_text(encoding='utf-8'):break
     time.sleep(.02)
    else:self.fail('child did not emit')
   finally:p.terminate();p.join(3)
   self.assertFalse(p.is_alive());self.assertEqual(json.loads(path.read_text(encoding='utf-8').splitlines()[-1])['stage'],'adapter_read')
 def test_ui_call_graph_unchanged(self):
  # Strip only the added with statements, imports and recorder setup. UI expressions unchanged.
  for name in ['backends','owner_edge_controller']:
   before=ast.parse((R/'tests'/'fixtures'/('read-phase-'+name+'.before.py')).read_text(encoding='utf-8'));after=ast.parse((R/'compat'/'vendor'/'xiaoqian_driver'/(name+'.py')).read_text(encoding='utf-8'))
   def calls(t):
    return sorted(ast.dump(n,include_attributes=False) for n in ast.walk(t) if isinstance(n,ast.Call) and not(isinstance(n.func,ast.Name) and n.func.id=='phase'))
   self.assertEqual(calls(before),calls(after),name)
if __name__=='__main__':unittest.main()
