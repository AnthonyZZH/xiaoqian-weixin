"""Export canonical media from the SAME signed raw read, including ACKed rows.

A pending inbox is a delivery queue, not the current native UI snapshot. Never
reconstruct a UI source key by hashing a later independently observed Name.
"""
import json,hashlib
from .protocol import digest,DriverError

def bind_current_read(state,chat,rows,receipt,*,received_witnesses=()):
    if not isinstance(receipt,dict) or not receipt.get('readId') or type(receipt.get('generation')) is not int:
        raise DriverError('NATIVE_READ_RECEIPT_REQUIRED')
    with state.lock:
        observed=state.db.execute('SELECT items FROM identity_observation WHERE chat=?',(chat.key,)).fetchone()
        if observed is None:
            observed=state.db.execute('SELECT items FROM snapshot_identity WHERE chat=?',(chat.key,)).fetchone()
        items=json.loads(observed[0]) if observed else []
        by_raw={}
        for item in items:
            if not item.get('shadow'):by_raw.setdefault(item.get('raw'),[]).append(item)
        result=[]
        for raw in rows:
            if raw.get('role')!='user':continue
            found=by_raw.get(raw['key'],[])
            transition=False
            if len(found)==1:
                canonical=digest([chat.key,found[0]['key']])
            else:
                # Legacy received-card backfill requires an independent native
                # action witness plus the exact SAME UIA instance. Never names.
                ref=raw.get('native_ref') or {}; canonical=None
                for witness in received_witnesses:
                    oldref=witness.get('nativeRef') or {}
                    if not(witness.get('nativeReceiveCompleted') is True and witness.get('nativeShowInFolderCompleted') is True and
                           witness.get('chatKey')==chat.key and ref.get('kind')=='file' and ref.get('received') is True and
                           all(ref.get(k)==oldref.get(k) for k in ('hwnd','wechatPid','runtimeId','className','nameSha256'))):continue
                    old=state.db.execute('SELECT payload FROM inbox WHERE chat_key=? AND message_id=?',(chat.key,witness.get('sourceMessageId'))).fetchone()
                    if not old:continue
                    payload=json.loads(old[0]);before=payload.get('text','')
                    if payload.get('role')!='user' or before.splitlines().count('未下载')!=1:continue
                    after='\n'.join(x for x in before.splitlines() if x!='未下载')
                    if after!=raw['text']:continue
                    expected=hashlib.sha256(json.dumps([ref.get('runtimeId'),'user',before],ensure_ascii=False).encode()).hexdigest()
                    if expected!=payload.get('source_key'):continue
                    if canonical is not None and canonical!=witness['sourceMessageId']:
                        canonical=None;break
                    canonical=witness['sourceMessageId'];transition=True
                if canonical is None:continue
            prior=state.db.execute('SELECT payload FROM inbox WHERE chat_key=? AND message_id=?',(chat.key,canonical)).fetchone()
            if not prior or json.loads(prior[0]).get('role')!='user':continue
            result.append(dict(id=canonical,sourceKey=raw['key'],role='user',text=raw['text'],sender=raw.get('sender',''),
              imageAvailable=raw.get('image_available') is True,voiceAvailable=raw.get('voice_available') is True,
              nativeRef=raw.get('native_ref'),readId=receipt['readId'],generation=receipt['generation'],
              nativeReceivedTransition=transition,rawToken=found[0]['token'] if found and not transition else __import__('xiaoqian_driver.snapshot_identity',fromlist=['token']).token(raw)))
        return result
