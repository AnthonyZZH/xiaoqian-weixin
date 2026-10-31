"""Hash-only draft ownership, bound to a durable send operation. No UI imports."""
from pathlib import Path
import hashlib,json,os,sqlite3,time,uuid
from contextlib import closing

def hash_text(value):return hashlib.sha256(str(value).encode()).hexdigest()
def edit_id(edit):return list(edit.GetRuntimeId())

class DraftJournal:
 def __init__(self,root,db):self.root=Path(root);self.db=Path(db)
 def path(self,chat):return self.root/(chat+'.json')
 def load(self,chat):
  try:return json.loads(self.path(chat).read_text(encoding='utf-8'))
  except FileNotFoundError:return None
 def save(self,r):
  self.root.mkdir(parents=True,exist_ok=True);p=self.path(r['chat']);tmp=p.with_name(p.name+'.'+uuid.uuid4().hex+'.tmp')
  with tmp.open('w',encoding='utf-8',newline='\n') as f:json.dump(r,f,separators=(',',':'));f.flush();os.fsync(f.fileno())
  os.replace(tmp,p)
 def written(self,adapter,edit,text):
  context=getattr(adapter,'_draft_context',None)
  if not context:return
  if adapter.input_value(edit)!=text:raise RuntimeError('draft_ownership_write_unconfirmed')
  r={**context,'nonce':uuid.uuid4().hex,'phase':'written','targetHash':hash_text(adapter.mode+':'+adapter.target),'bodyHash':hash_text(text),'length':len(text),'editId':edit_id(edit),'hwnd':adapter.hwnd,'wechatPid':int(adapter.window.ProcessId),'writtenAt':time.time()}
  if not r['editId'] or r['wechatPid']<=0:raise RuntimeError('draft_identity_unavailable')
  self.save(r)
 def phase(self,adapter,phase):
  context=getattr(adapter,'_draft_context',None)
  if not context:return
  r=self.load(context['chat'])
  if r and r['operation']==context['operation']:
   r['phase']=phase;self.save(r)
 def recover(self,adapter,chat):
  r=self.load(chat)
  if not r or r.get('phase') not in ['written','click_started']:return 'no_owned_residual'
  if r.get('targetHash')!=hash_text(adapter.mode+':'+adapter.target):return 'wrong_chat'
  with closing(sqlite3.connect('file:'+self.db.as_posix()+'?mode=ro',uri=True,timeout=.5)) as db:
   row=db.execute('select s.status,o.chat,o.body from sends s join outbound_identity o on o.op=s.operation_id where s.operation_id=?',(r['operation'],)).fetchone()
  if not row or row[0] not in ['unknown','failed'] or row[1]!=chat or row[2]!=r['bodyHash']:return 'operation_not_recoverable'
  edit=adapter.validate();value=adapter.input_value(edit)
  if value=='':r['phase']='empty_observed';self.save(r);return 'already_empty'
  def same(control):
   return edit_id(control)==r['editId'] and adapter.hwnd==r['hwnd'] and int(adapter.window.ProcessId)==r['wechatPid'] and hash_text(adapter.input_value(control))==r['bodyHash'] and len(adapter.input_value(control))==r['length']
  if not same(edit):r['phase']='foreign_edit_observed';self.save(r);return 'foreign_draft_preserved'
  current=adapter.validate()
  if not same(current) or adapter.input_value(current)!=value:r['phase']='foreign_edit_observed';self.save(r);return 'draft_race_preserved'
  # Do not retry after an uncertain cleanup. Persist intent before the UI action.
  r['phase']='cleanup_started';self.save(r)
  if not same(current) or adapter.input_value(current)!=value:r['phase']='foreign_edit_observed';self.save(r);return 'draft_race_preserved'
  current.GetValuePattern().SetValue('',waitTime=0)
  r['phase']='cleared_owned' if adapter.input_value(current)=='' else 'cleanup_unconfirmed';r['recoveredAt']=time.time();self.save(r)
  return r['phase']
