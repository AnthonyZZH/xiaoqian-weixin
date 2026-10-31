"""Metadata-only read lifecycle. Never receives a chat title, message or exception text."""
from pathlib import Path
import datetime,json,os,re,threading,time
SAFE=re.compile(r'^[A-Za-z0-9_]{1,80}$')
CODES=set('client_closed queue_full queue_timeout command_timeout worker_crashed invalid_read_response owner_edge_receipt_unverified ipc_response_mismatch invalid_error_response invalid_response backend_error worker_start_failed worker_unavailable worker_not_ready worker_stop_unconfirmed handshake_mismatch read_selection_mismatch owner_edge_selection_mismatch state_unavailable real_driver_requires_windows adapter_not_found dispatcher_failed request_abandoned'.split())
class ReadAudit:
 def __init__(self,root):self.file=Path(root)/'read-outcomes-python.jsonl';self.lock=threading.Lock();self.failures=0
 def append(self,row):
  try:
   with self.lock:
    if self.file.exists() and self.file.stat().st_size>1048576:self.file.replace(self.file.with_suffix('.previous.jsonl'))
    with self.file.open('a',encoding='utf-8') as stream:stream.write(json.dumps(row,separators=(',',':'))+'\n');stream.flush()
   return True
  except OSError:self.failures+=1;return False
 def start(self,job):
  self.append({'schema':'xq.read-outcome/python-v1','phase':'queued','request_id':job.request_id,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'controller_pid':os.getpid()})
 def finish(self,job,result,error,generation):
  raw=getattr(error,'code',None);code=raw if isinstance(raw,str) and raw in CODES else ('completed' if error is None else 'python_exception')
  outcome='success' if error is None else 'timeout' if code in ('command_timeout','queue_timeout') else 'cancelled' if code in ('client_closed','client_closed_before_dispatch') else 'error'
  row={'schema':'xq.read-outcome/python-v1','phase':'terminal','request_id':job.request_id,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'controller_pid':os.getpid(),'outcome':outcome,'code':code,'last_stage':job.stage,'failure_stage':job.failure_stage,'elapsed_ms':round((time.monotonic()-job.queued_at)*1000),'queue_ms':job.queue_ms,'generation':job.generation,'worker_pid':job.worker_pid,'worker_exit_code':job.worker_exit_code,'row_count':len(result.messages) if result is not None and hasattr(result,'messages') else None}
  row['persisted']=self.append(row);return row
