import sys,unittest,tempfile,json,threading,time,importlib.util,hashlib
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'compat'/'vendor'))
from xiaoqian_driver import DriverClient,DriverConfig,Chat,DriverError
SCRATCH=Path(__file__).resolve().parents[1]/'.test-scratch'/'read-audit-python';SCRATCH.mkdir(parents=True,exist_ok=True)
CHAT=Chat(name='SYNTHETIC OWNER',mode='private')
class Cases(unittest.TestCase):
 def make(self,t,fault=None):
  options={'snapshots':{CHAT.key:[{'key':'synth-1','role':'user','text':'PRIVATE_SYNTHETIC_BODY'}]}}
  if fault:options['faults']={'read':fault}
  c=DriverClient(t,DriverConfig(mode='fake',startup_timeout=4,command_timeout=1,fake_options=options));c.health(timeout=4);return c
 def terminal(self,t):
  rows=[json.loads(x) for x in (Path(t)/'read-outcomes-python.jsonl').read_text().splitlines()];self.assertNotIn('PRIVATE_SYNTHETIC_BODY',str(rows));return [r for r in rows if r['phase']=='terminal']
 def test_real_worker_success_and_request_binding(self):
  with tempfile.TemporaryDirectory(dir=SCRATCH) as t:
   c=self.make(t)
   try:r=c.read(CHAT,timeout=2,request_id='1'*32);self.assertEqual(len(r.messages),1);a=self.terminal(t);self.assertEqual(len(a),1);self.assertEqual(a[0]['outcome'],'success');self.assertEqual(a[0]['request_id'],'1'*32);self.assertEqual(a[0]['last_stage'],'done')
   finally:c.close()
 def test_real_worker_timeout_and_following_read_recovers(self):
  with tempfile.TemporaryDirectory(dir=SCRATCH) as t:
   c=self.make(t,{'action':'hang','generations':[1]})
   try:
    with self.assertRaises(DriverError):c.read(CHAT,timeout=.25)
    a=self.terminal(t)[0];self.assertEqual(a['outcome'],'timeout');self.assertEqual(a['failure_stage'],'backend_read_wait');self.assertIsNotNone(a['worker_exit_code']);self.assertEqual(len(c.read(CHAT,timeout=4).messages),1);self.assertEqual(len(self.terminal(t)),2)
   finally:c.close()
 def test_real_worker_exit_has_terminal(self):
  with tempfile.TemporaryDirectory(dir=SCRATCH) as t:
   c=self.make(t,{'action':'crash'})
   try:
    with self.assertRaises(DriverError):c.read(CHAT,timeout=2)
    a=self.terminal(t)[0];self.assertEqual(a['code'],'worker_crashed');self.assertEqual(a['outcome'],'error');self.assertIsNotNone(a['worker_exit_code'])
   finally:c.close()
 def test_backend_exception_has_terminal_without_raw_error(self):
  with tempfile.TemporaryDirectory(dir=SCRATCH) as t:
   c=self.make(t,{'action':'error'})
   try:
    with self.assertRaises(DriverError):c.read(CHAT,timeout=2)
    a=self.terminal(t)[0];self.assertEqual(a['outcome'],'error');self.assertNotIn('fake_private_error',str(a))
   finally:c.close()
 def test_close_cancels_inflight_and_queued_read(self):
  with tempfile.TemporaryDirectory(dir=SCRATCH) as t:
   c=self.make(t,{'action':'hang'});results=[]
   def run():
    try:c.read(CHAT,timeout=4)
    except Exception as e:results.append(type(e).__name__)
   a=threading.Thread(target=run);b=threading.Thread(target=run);a.start();time.sleep(.1);b.start();time.sleep(.1);c.close();a.join(2);b.join(2);self.assertFalse(a.is_alive() or b.is_alive());self.assertEqual(len(results),2);self.assertEqual([v['outcome'] for v in self.terminal(t)],['cancelled','cancelled'])
 def test_dispatcher_base_exception_also_completes_future(self):
  with tempfile.TemporaryDirectory(dir=SCRATCH) as t:
   c=self.make(t);old=c._ensure_worker
   try:
    def fail(*a):raise SystemExit('PRIVATE_ERROR')
    c._ensure_worker=fail
    with self.assertRaises(DriverError):c.read(CHAT,timeout=2)
    self.assertEqual(self.terminal(t)[0]['code'],'dispatcher_failed')
   finally:c._ensure_worker=old;c.close()
 def test_original_consumed_without_completion_paths_are_reproduced(self):
  original=Path(__file__).parent/'fixtures'/'read-outcomes-legacy-probe.fixture.py';spec=importlib.util.spec_from_file_location('old_probe',original);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
  with tempfile.TemporaryDirectory(dir=SCRATCH) as t:
   m.BASE=Path(t)
   class A:
    mode='private';target='SYNTHETIC OWNER'
    def read(self):pass
   A.read._owner_card_probe=True;a=A();scope={'_owner_card_original_read':A.read}
   def arm(expiry):(Path(t)/'armed.json').write_text(json.dumps({'targetHash':hashlib.sha256((a.mode+':'+a.target).encode()).hexdigest(),'expiresAt':expiry}))
   arm(time.time()-1);self.assertIsNone(m.begin(a,scope));self.assertTrue((Path(t)/'consumed.json').exists());self.assertFalse((Path(t)/'sample.private.json').exists())
   (Path(t)/'consumed.json').unlink();arm(time.time()+10);capture=m.begin(a,scope);self.assertIsNotNone(capture)
   try:raise RuntimeError('normal_read_failed_before_finish')
   except RuntimeError:pass
   self.assertTrue((Path(t)/'consumed.json').exists());self.assertFalse((Path(t)/'sample.private.json').exists())
if __name__=='__main__':unittest.main()
