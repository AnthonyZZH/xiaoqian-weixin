"""Bounded metadata-only stages inside an existing serial read, never UI calls."""
import contextlib,datetime,json,os,time
from pathlib import Path

class ReadPhases:
 def __init__(self,root,generation):
  self.path=Path(root)/'read-phases-python.jsonl';self.generation=generation;self.request_id=None
 def emit(self,stage,event,elapsed=None):
  if self.request_id is None:return
  row={'schema':'xq.read-phases/v1','request_id':self.request_id,'generation':self.generation,'worker_pid':os.getpid(),'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'stage':stage,'event':event}
  if elapsed is not None:row['elapsed_ms']=round(elapsed*1000,2)
  try:
   if self.path.exists() and self.path.stat().st_size>1048576:self.path.replace(self.path.with_suffix('.previous.jsonl'))
   with self.path.open('a',encoding='utf-8') as stream:stream.write(json.dumps(row,separators=(',',':'))+'\n');stream.flush()
  except OSError:pass
 @contextlib.contextmanager
 def request(self,request_id):
  self.request_id=request_id
  try:
   with self.phase('read_total'):yield
  finally:self.request_id=None
 @contextlib.contextmanager
 def phase(self,name):
  self.emit(name,'enter');start=time.monotonic()
  try:yield
  except BaseException:
   self.emit(name,'error',time.monotonic()-start);raise
  else:self.emit(name,'complete',time.monotonic()-start)

def phase(backend,name):
 recorder=getattr(backend,'_read_phases',None)
 return recorder.phase(name) if recorder else contextlib.nullcontext()
