"""Bounded real subprocess tests with synthetic state; no UI/network/model calls."""
from pathlib import Path
import json,os,queue,subprocess,sys,tempfile,threading,time,unittest,venv
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'compat'/'vendor'))
from xiaoqian_driver.client import DriverClient,worker_argv
from xiaoqian_driver.protocol import Chat,DriverConfig
SCRATCH=ROOT/'.test-scratch'/'worker-process';SCRATCH.mkdir(parents=True,exist_ok=True)

class Tests(unittest.TestCase):
 def start(self):
  env=os.environ.copy();env['PYTHONDONTWRITEBYTECODE']='1'
  env['PYTHONPATH']=str(ROOT/'compat'/'vendor')+os.pathsep+env.get('PYTHONPATH','')
  return subprocess.Popen(worker_argv(),cwd=ROOT,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
 def cleanup(self,p):
  if p.poll() is None:p.kill();p.wait(timeout=3)
  for s in (p.stdin,p.stdout,p.stderr):
   if s and not s.closed:s.close()
 def request(self,id,command,args):return json.dumps({'v':1,'id':id,'command':command,'args':args})+'\n'
 def test_actual_worker_pid_and_normal_protocol(self):
  with tempfile.TemporaryDirectory(dir=SCRATCH) as state:
   p=self.start()
   try:
    messages=self.request('hello','hello',{'config':{'mode':'fake','allowed_chats':[]},'generation':1,'audit_path':str(Path(state)/'fake-events.jsonl')})+self.request('read','read',{'chat':{'name':'SYNTHETIC','mode':'private'}})
    stdout,stderr=p.communicate(messages,timeout=8);self.assertEqual(p.returncode,0,stderr)
    rows=[json.loads(x) for x in stdout.splitlines()];self.assertEqual(len(rows),2);self.assertTrue(all(x['ok'] for x in rows));self.assertEqual(rows[0]['result']['pid'],p.pid);self.assertEqual(rows[1]['result']['rows'],[])
   finally:self.cleanup(p)
 def test_actual_hanging_worker_is_owned_and_killable(self):
  with tempfile.TemporaryDirectory(dir=SCRATCH) as state:
   p=self.start()
   try:
    p.stdin.write(self.request('hello','hello',{'config':{'mode':'fake','allowed_chats':[],'fake_options':{'faults':{'read':{'action':'hang'}}}},'generation':2,'audit_path':str(Path(state)/'fake-events.jsonl')}));p.stdin.flush()
    q=queue.Queue();t=threading.Thread(target=lambda:q.put(p.stdout.readline()),daemon=True);t.start()
    answer=json.loads(q.get(timeout=5));self.assertTrue(answer['ok']);self.assertEqual(answer['result']['pid'],p.pid)
    p.stdin.write(self.request('read','read',{'chat':{'name':'SYNTHETIC','mode':'private'}}));p.stdin.flush();time.sleep(.15)
    self.assertIsNone(p.poll());p.kill();p.wait(timeout=3);self.assertIsNotNone(p.returncode)
   finally:self.cleanup(p)
 def test_full_client_pid_and_close(self):
  with tempfile.TemporaryDirectory(dir=SCRATCH) as state:
   client=DriverClient(state,DriverConfig(mode='fake',command_timeout=5,startup_timeout=3));child=None
   try:
    result=client.read(Chat(name='SYNTHETIC',mode='private'));child=client._process
    self.assertEqual(client._request('ping',{},time.monotonic()+2)['pid'],child.pid);self.assertEqual(len(result.messages),0);self.assertEqual(client.last_read_outcome['outcome'],'success')
   finally:client.close()
   self.assertIsNotNone(child);self.assertIsNotNone(child.poll())
 def test_actual_local_venv_keeps_sites_and_owns_worker_pid(self):
  with tempfile.TemporaryDirectory(dir=SCRATCH) as state:
   envroot=Path(state)/'venv';venv.EnvBuilder(with_pip=False).create(envroot)
   executable=envroot/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
   code="""import json,pathlib,sys,time
from xiaoqian_driver.client import DriverClient,worker_argv
from xiaoqian_driver.protocol import Chat,DriverConfig
assert sys.prefix != sys.base_prefix
assert any(pathlib.Path(p).is_dir() for p in __import__('site').getsitepackages())
c=DriverClient(sys.argv[1],DriverConfig(mode='fake',command_timeout=5,startup_timeout=3))
try:
 r=c.read(Chat(name='SYNTHETIC',mode='private'));p=c._process
 assert c._request('ping',{},time.monotonic()+2)['pid']==p.pid
 assert len(r.messages)==0 and c.last_read_outcome['outcome']=='success'
finally:c.close()
assert p.poll() is not None
print(json.dumps({'venv':True,'pidMatch':True,'exitConfirmed':True,'windows':sys.platform=='win32'}))
"""
   env=os.environ.copy();env.update(PYTHONPATH=str(ROOT/'compat'/'vendor'),PYTHONDONTWRITEBYTECODE='1')
   p=subprocess.run([str(executable),'-B','-c',code,str(Path(state)/'state')],cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf-8',timeout=18)
   self.assertEqual(p.returncode,0,p.stderr);proof=json.loads(p.stdout);self.assertTrue(proof['venv']);self.assertTrue(proof['pidMatch']);self.assertTrue(proof['exitConfirmed'])
   self.assertEqual(proof['windows'],os.name=='nt')
if __name__=='__main__':unittest.main()
