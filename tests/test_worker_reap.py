import ast,pathlib,subprocess,sys,threading,types,unittest
D=pathlib.Path(__file__).resolve().parents[1]/'compat'/'vendor'/'xiaoqian_driver'
class DriverError(Exception):pass
class Proceed(Exception):pass
t=ast.parse((D/'client.py').read_text(encoding='utf-8'));methods=[n for n in ast.walk(t) if isinstance(n,ast.FunctionDef) and n.name in ('_ensure_worker','_stop_worker')]
ns={'DriverError':DriverError,'subprocess':subprocess};exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='Client',bases=[],keywords=[],body=methods,decorator_list=[])],type_ignores=[])),'actual-reap-methods','exec'),ns);C=ns['Client']
def client(process):
 c=C();c._process_lock=threading.RLock();c._closing=threading.Event();c._quarantined=True;c._process=process;c._events=object();c._active_job=None;c._remaining=lambda *a:(_ for _ in ()).throw(Proceed());return c
class Process:
 def __init__(self,exit=None,timeout=False):self.returncode=exit;self.stdin=None;self.stdout=None;self.timeout=timeout;self.kill_count=0
 def poll(self):return self.returncode
 def kill(self):self.kill_count+=1
 def wait(self,timeout):
  if self.timeout:raise subprocess.TimeoutExpired('synthetic',timeout)
  self.returncode=-1
class Tests(unittest.TestCase):
 def test_live_process_stays_denied(self):
  p=Process();c=client(p)
  with self.assertRaises(DriverError):c._ensure_worker(1)
  self.assertEqual(p.kill_count,0);self.assertTrue(c._quarantined)
 def test_missing_handle_stays_denied(self):
  c=client(None)
  with self.assertRaises(DriverError):c._ensure_worker(1)
  self.assertTrue(c._quarantined)
 def test_late_exit_reaped_without_another_kill(self):
  p=Process(73);c=client(p)
  with self.assertRaises(Proceed):c._ensure_worker(1)
  self.assertEqual(p.kill_count,0);self.assertIsNone(c._process);self.assertFalse(c._quarantined)
 def test_closing_never_restarts(self):
  c=client(Process(0));c._closing.set()
  with self.assertRaises(DriverError):c._ensure_worker(1)
  self.assertTrue(c._quarantined)
 def test_failed_kill_retains_handle_and_quarantine(self):
  p=Process(timeout=True);c=client(p)
  with self.assertRaises(DriverError):c._stop_worker()
  self.assertIs(c._process,p);self.assertTrue(c._quarantined)
 def test_actual_child_exit_reaped(self):
  p=subprocess.Popen([sys.executable,'-c','pass'],stdin=subprocess.PIPE,stdout=subprocess.PIPE);p.wait(timeout=5);c=client(p);c._stop_worker();self.assertIsNone(c._process);self.assertFalse(c._quarantined);self.assertTrue(p.stdin.closed);self.assertTrue(p.stdout.closed)
if __name__=='__main__':unittest.main()
