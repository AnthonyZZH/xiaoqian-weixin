"""Commit the exact native receive-only state transition after authenticated IPC."""
import json,hashlib
from .protocol import digest,DriverError
from .snapshot_identity import token

def commit_received_transition(state,chat,result,handle):
 transition=result.get('nativeTransition')
 if transition is None:return
 def need(ok):
  if not ok:raise DriverError('SAVED_FILE_RECEIVE_ALIAS_UNVERIFIED')
 need((result.get('completed') is True or result.get('nativeReceiveVerified') is True and result.get('kind')=='native-file-receive-only') and result.get('sourceMessageId')==handle['messageId'] and result.get('generation')==handle['generation'])
 before,after=transition.get('beforeText'),transition.get('afterText')
 need(isinstance(before,str) and isinstance(after,str) and before.splitlines().count('未下载')==1 and '\n'.join(x for x in before.splitlines() if x!='未下载')==after)
 before_key=hashlib.sha256(json.dumps([transition.get('runtimeId'),'user',before],ensure_ascii=False).encode()).hexdigest()
 after_key=hashlib.sha256(json.dumps([transition.get('runtimeId'),'user',after],ensure_ascii=False).encode()).hexdigest()
 need(before_key==transition.get('beforeSourceKey')==handle['sourceKey'] and after_key==transition.get('afterSourceKey'))
 with state.lock,state.db:
  updated=0
  for table in ('identity_observation','snapshot_identity'):
   found=state.db.execute('SELECT items FROM '+table+' WHERE chat=?',(chat.key,)).fetchone()
   if not found:continue
   items=json.loads(found[0]);matches=[i for i in items if not i.get('shadow') and i.get('raw')==before_key and digest([chat.key,i['key']])==handle['messageId']]
   need(len(matches)<=1)
   if matches:
    item=matches[0];need(item['token']==handle['token'])
    item.update(raw=after_key,token=token(dict(text=after,role='user',sender='')))
    state.db.execute('UPDATE '+table+' SET items=? WHERE chat=?',(json.dumps(items),chat.key));updated+=1
  need(updated>0)
