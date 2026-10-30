"""Reuse the reviewed Python coordinator; host ports are a bounded JSONL channel."""
import sys,json,os
from pathlib import Path
from dataclasses import asdict,is_dataclass,replace
from datetime import date
from decimal import Decimal
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'vendor/session-rotation'))
from xq_session_rotation.cost import Amount,Tokens,Usage,RateCard,Charge,Forecast,compare
from xq_session_rotation.rotation import Snapshot,Summary,Agent,Switch,RotationJournal,RotationCoordinator,REQUIRED,OutcomeUnknown
def encode(v):
 if is_dataclass(v):return asdict(v)
 if isinstance(v,Decimal):return str(v)
 if isinstance(v,(set,frozenset,tuple)):return list(v)
 raise TypeError(type(v).__name__)
def emit(v):print(json.dumps(v,ensure_ascii=False,default=encode,separators=(',',':')),flush=True)
counter=0
def rpc(method,*args):
 global counter
 counter+=1;emit({'rpc':counter,'method':method,'args':args})
 row=json.loads(sys.stdin.readline())
 if row.get('rpc')!=counter:raise RuntimeError('RPC_SEQUENCE')
 if row.get('unknown'):raise OutcomeUnknown('HOST_OUTCOME_UNKNOWN')
 if not row.get('ok'):raise RuntimeError(row.get('code','HOST_PORT_FAILED'))
 return row.get('value')
def snapshot(raw):
 for k in ('transcript','dedup_map'):raw[k]=tuple(tuple(v) for v in raw[k])
 for k in ('owner_permissions','unfinished_tasks','recent_handoff'):raw[k]=tuple(raw[k])
 return Snapshot(**raw)
def forecast(s,c):
 verified=date.fromisoformat(c['verified_on']);today=date.fromisoformat(c['as_of']);source=c['source']
 rates=RateCard('deepseek-official',c['model'],'CNY',source,verified,c['summary_rates']['uncached'],c['summary_rates']['cached'],c['summary_rates']['output'])
 first_rates=RateCard('deepseek-official',c['model'],'CNY',source,verified,'2','0.04','8')
 def tokens(pair):return None if pair is None else Tokens(*pair)
 def usage(row):return Usage(*(tokens(row.get(k)) for k in ('uncached','cached','output')))
 def free(stage):return Charge.free(stage,'Existing local basic-memory FTS; no metered API/embedding call, zero marginal API CNY; measured operations included', 'CNY','live local FTS deployment and native process operations',verified)
 continuation=Charge('conversation','Observed billing buckets and conservative next-call amount bounds; future cache/output uncertainty retained',fixed=Amount(*c['keep_amount']),currency='CNY',source=source,verified_on=verified)
 if not c.get('usage_known') or c.get('model')!='deepseek-flash':
  continuation=Charge('conversation','Missing exact cached/uncached/output or unsupported current model',usage=Usage(None,None,None),rates=rates)
 setup=(Charge('summary','Complete snapshot scan plus native summary prompt overhead; cold input and output cap priced',usage=usage(c['summary_usage']),rates=rates),*[free(k) for k in ('archive_write','archive_readback','summary_write','summary_readback','write_embedding','agent_create')])
 new=(Charge('conversation','Full serialized new request including all handoff fields and complete tools; cold-prefix upper bound',usage=usage(c['first_usage']),rates=first_rates),free('retrieval'),free('retrieval_embedding'))
 f=Forecast(s.digest,c['transcript_tokens'],Tokens(*c['summary_input']),Tokens(*c['cache_loss']),c['cache_assumptions'],c['future_assumptions'],(continuation,),setup,new,new,horizon=100,first_request_tokens=Tokens(*c['first_tokens']),first_request_components=('persona','owner_permissions','unfinished_tasks','recent_handoff','dedup','tool_schema','current_message','summary','serialization'))
 return compare(f,as_of=today,max_quote_age_days=30)
class Library:
 connected=True
 def write(self,*args):return rpc('library.write',*args)
 def read(self,*args):return rpc('library.read',*args)
class Summarizer:
 def build(self,s,a,k):
  v=rpc('summary.build',asdict(s),a,k);v['evidence_ids']=tuple(v['evidence_ids']);return Summary(**v)
class Sessions:
 capabilities=REQUIRED
 def acquire_safe_point(self,s,o):return rpc('session.acquire_safe_point',{**asdict(s),'snapshot_digest':s.digest},o)
 def is_current(self,l,s):return rpc('session.is_current',l,{**asdict(s),'snapshot_digest':s.digest})
 def create_dormant(self,p,k):return Agent(**rpc('session.create_dormant',p,k))
 def lookup_created(self,k):
  v=rpc('session.lookup_created',k);return None if v is None else Agent(**v)
 def read_agent(self,k):return Agent(**rpc('session.read_agent',k))
 def commit_rotation(self,l,s,a,o):return Switch(**rpc('session.commit_rotation',l,{**asdict(s),'snapshot_digest':s.digest},a,o))
 def lookup_switch(self,k):
  v=rpc('session.lookup_switch',k);return None if v is None else Switch(**v)
 def current_agent(self,k):return rpc('session.current_agent',k)
 def release_safe_point(self,*a):return rpc('session.release_safe_point',*a)
 def release_operation_fence(self,*a):return rpc('session.release_operation_fence',*a)
 def contain_uncertain(self,*a):return rpc('session.contain_uncertain',*a)
 def clear_uncertain(self,*a):return rpc('session.clear_uncertain',*a)
try:
 req=json.loads(sys.stdin.readline());s=snapshot(req['snapshot'])
 if req['mode']=='reconcile':
  engine=RotationCoordinator(journal=RotationJournal(req['journal']),library=Library(),summarizer=Summarizer(),sessions=Sessions())
  emit({'done':True,'result':engine.reconcile(s,execution_stopped=True),'snapshot_digest':s.digest});sys.exit(0)
 decision=forecast(s,req['costing'])
 budget={'continueNextUpper':str(decision.continuation_next.high) if decision.continuation_next else None,'rotateNextUpper':str(decision.rotation_next.high) if decision.rotation_next else None,'setupUpper':str(decision.setup.high) if decision.setup else None}
 if req['costing'].get('bounds_verified') is not True:decision=replace(decision,recommendation='indeterminate',continuation_next=None,rotation_next=None,setup=None,savings_next_lower=None,raw_break_even_turns=None,protected_break_even_turns=None,reason='Full-transcript/new-request token bounds are unverified; byte-based budget ceilings are not economic permission')
 if req['mode']=='cost':emit({'done':True,'decision':decision,'snapshot_digest':s.digest,'budgetCeilings':budget})
 else:
  engine=RotationCoordinator(journal=RotationJournal(req['journal']),library=Library(),summarizer=Summarizer(),sessions=Sessions())
  result=engine.reconcile(s,execution_stopped=True) if req['mode']=='reconcile' else engine.rotate(s,decision)
  emit({'done':True,'decision':decision,'result':result,'snapshot_digest':s.digest})
except Exception as e:emit({'done':True,'error':type(e).__name__})
