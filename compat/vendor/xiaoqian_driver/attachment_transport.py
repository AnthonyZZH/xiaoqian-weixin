"""Host-only attachment IPC. Canonical identity, bounded exact-file completion.

No native provider is enabled by default. Real provider must be installed by the
trusted worker host after control acceptance; fake fixtures are fake-mode only.
"""
import base64
import hashlib
import json
import os
import stat
import time
import uuid
from pathlib import Path

COMMANDS=('attachment_inspect','attachment_save_as','attachment_completion')
CAP=256*1024*1024

class AttachmentError(ValueError):
    pass

def register_native_port(backend,port,profile):
    check(isinstance(profile,dict) and profile.get('verified') is True and profile.get('nativeAcceptance') is True and isinstance(profile.get('evidenceId'),str) and profile['evidenceId'],'NATIVE_ACCEPTANCE_REQUIRED')
    check(all(callable(getattr(port,name,None)) for name in ('inspect','saveAs','completion')),'NATIVE_PORT_INVALID')
    backend._attachment_native_port=port;backend._attachment_profile=dict(profile)

def check(ok,code):
    if not ok:raise AttachmentError(code)

def digest(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def prepare(client,chat,card,scope,deadline):
    check(chat.mode=='private' and chat in client.config.allowed_chats,'OWNER_PRIVATE_REQUIRED')
    check(isinstance(card,dict) and isinstance(scope,dict),'ATTACHMENT_ARGUMENT_INVALID')
    mid=card.get('sourceMessageId')
    check(isinstance(mid,str) and len(mid)==64,'CANONICAL_MESSAGE_ID_REQUIRED')
    check(getattr(client,'_attachment_snapshot_generation',None)==client._generation,'ATTACHMENT_FRESH_READ_REQUIRED')
    with client._state.lock:
        row=client._state.db.execute('SELECT payload FROM inbox WHERE chat_key=? AND message_id=?',(chat.key,mid)).fetchone()
        check(row is not None,'ATTACHMENT_MESSAGE_UNKNOWN')
        payload=json.loads(row[0]);check(payload.get('role')=='user','ATTACHMENT_INCOMING_REQUIRED')
        matches=[]
        for table in ('identity_observation','snapshot_identity'):
            try:found=client._state.db.execute('SELECT items FROM '+table+' WHERE chat=?',(chat.key,)).fetchone()
            except Exception:continue
            if found:
                matches=[item for item in json.loads(found[0]) if not item.get('shadow') and digest([chat.key,item['key']])==mid]
                # An existing current observation is authoritative. Never fall
                # back to an old viewport after a deferred/shadow observation.
                break
        check(len(matches)==1,'ATTACHMENT_IDENTITY_DEFERRED')
        item=matches[0]
    remaining=deadline-time.monotonic();check(remaining>0,'ATTACHMENT_DEADLINE')
    safe_scope={key:scope.get(key) for key in ('ownerBindingId','ownerChatId','destination','expectedIdentity','evidenceId','maxBytes')}
    check(isinstance(safe_scope['ownerBindingId'],str) and safe_scope['ownerBindingId'],'OWNER_BINDING_REQUIRED')
    check(type(safe_scope['maxBytes']) is int and 1<=safe_scope['maxBytes']<=CAP,'ATTACHMENT_LIMIT_INVALID')
    safe_scope['deadline']=int((time.time()+remaining)*1000)
    return {'chat':chat.to_dict(),'card':dict(card),'scope':safe_scope,'handle':{
        'verified':True,'chatKey':chat.key,'messageId':mid,'sourceKey':item['raw'],
        'token':item['token'],'generation':client._generation,'identityDeferred':False}}

def checked(root,path,*,file=False):
    root=Path(root).absolute();path=Path(path)
    check(path.is_absolute() and '..' not in path.parts and path!=root,'ATTACHMENT_PATH_DENIED')
    check(not str(path).startswith(('\\\\','//')) and ':' not in str(path)[2:],'ATTACHMENT_PATH_DENIED')
    try:relative=path.relative_to(root)
    except ValueError:raise AttachmentError('ATTACHMENT_PATH_DENIED') from None
    check(len(relative.parts)==2,'ATTACHMENT_PATH_DENIED')
    import re
    check(re.fullmatch(r'[a-f0-9-]{36}',relative.parts[0]) and re.fullmatch(r'[a-f0-9-]{36}\.(txt|docx|pdf)',relative.parts[1]),'ATTACHMENT_PATH_DENIED')
    for part in [*reversed(path.parents),path]:
        if not part.exists() and not part.is_symlink():continue
        s=part.lstat();check(not stat.S_ISLNK(s.st_mode) and not getattr(s,'st_file_attributes',0)&0x400,'ATTACHMENT_LINK_DENIED')
    if file:
        s=path.lstat();check(stat.S_ISREG(s.st_mode) and s.st_nlink==1,'ATTACHMENT_FILE_DENIED')
    return path

def verified_payload(root,proof,limit):
    check(proof.get('completed') is True and proof.get('independentCompletion') is True and proof.get('evidenceToken'),'ATTACHMENT_COMPLETION_UNVERIFIED')
    expected=proof.get('expectedBytes');check(type(expected) is int and 0<=expected<=limit,'ATTACHMENT_SIZE_LIMIT')
    path=checked(root,proof['destination'],file=True);before=path.lstat()
    check(before.st_size==expected,'ATTACHMENT_SIZE_MISMATCH')
    h=hashlib.sha256();count=0
    with os.fdopen(os.open(path,os.O_RDONLY|getattr(os,'O_BINARY',0)|getattr(os,'O_NOFOLLOW',0)),'rb') as stream:
        opened=os.fstat(stream.fileno())
        check((opened.st_dev,opened.st_ino,opened.st_size)==(before.st_dev,before.st_ino,before.st_size) and opened.st_nlink==1,'ATTACHMENT_FILE_CHANGED')
        while True:
            block=stream.read(min(1024*1024,limit+1-count))
            if not block:break
            count+=len(block);check(count<=limit,'ATTACHMENT_SIZE_LIMIT');h.update(block)
        after=os.fstat(stream.fileno())
    check(count==expected and (after.st_size,after.st_mtime_ns)==(before.st_size,before.st_mtime_ns),'ATTACHMENT_FILE_CHANGED')
    return h.hexdigest()

def parse_verified(root,proof,*,owner_binding_id,chat_id,message_id,parser,max_bytes=5*1024*1024):
    """Host parser adapter, never a model-facing arbitrary-path API.

    For larger PDF use the existing seekable read_completed_pdf handoff instead of
    base64/whole-file buffering. Parser must run in its own bounded document worker.
    """
    check(proof.get('verified') is True and proof.get('ownerBindingId')==owner_binding_id and proof.get('chatId')==chat_id and proof.get('sourceMessageId')==message_id,'ATTACHMENT_PARSE_BINDING_MISMATCH')
    check(proof['expectedBytes']<=max_bytes,'ATTACHMENT_USE_STREAMING_PARSER')
    sha=verified_payload(root,proof,max_bytes);check(sha==proof.get('sha256'),'ATTACHMENT_HASH_CHANGED')
    path=checked(root,proof['destination'],file=True)
    with path.open('rb') as stream:data=stream.read(max_bytes+1)
    check(len(data)==proof['expectedBytes'] and hashlib.sha256(data).hexdigest()==sha,'ATTACHMENT_HASH_CHANGED')
    result=parser(data,path.suffix)
    check(verified_payload(root,proof,max_bytes)==sha,'ATTACHMENT_HASH_CHANGED')
    return dict(result,sourceMessageId=message_id,sha256=sha)

class FixturePort:
    """Synthetic only; inaccessible when config.mode is real."""
    def __init__(self,fixture):self.raw=base64.b64decode(fixture['base64']);self.fixture=fixture
    def inspect(self,card,scope,profile):
        check(scope.get('verifiedHandle',{}).get('messageId')==card['sourceMessageId'],'FIXTURE_HANDLE_MISSING')
        return {'verified':True,'sourceMessageId':card['sourceMessageId'],'chatId':scope['ownerChatId'],'filename':card['displayName'],'identityToken':'synthetic-token'}
    def saveAs(self,card,scope):
        Path(scope['destination']).write_bytes(self.raw)
    def completion(self,card,scope):
        return {'completed':not self.fixture.get('incomplete',False),'independentCompletion':True,
                'sourceMessageId':card['sourceMessageId'],'chatId':scope['ownerChatId'],'destination':scope['destination'],
                'expectedBytes':len(self.raw)+self.fixture.get('sizeDelta',0),'evidenceToken':'synthetic-proof'}

def dispatch(backend,config,command,args,generation,audit_path):
    from .protocol import Chat
    from .snapshot_identity import token
    chat=Chat(**args['chat']);card=args['card'];scope=args['scope'];handle=args['handle']
    check(command in COMMANDS and chat.mode=='private' and chat in config.allowed_chats,'OWNER_PRIVATE_REQUIRED')
    check(handle.get('verified') is True and handle.get('generation')==generation and handle.get('chatKey')==chat.key and handle.get('messageId')==card.get('sourceMessageId'),'ATTACHMENT_IDENTITY_UNVERIFIED')
    check(scope['deadline']>time.time()*1000,'ATTACHMENT_DEADLINE')
    check(getattr(backend,'_attachment_chat_key',None)==chat.key,'ATTACHMENT_ROW_CHAT_MISMATCH')
    rows=getattr(backend,'_attachment_rows',{})
    row=rows.get(handle.get('sourceKey'))
    check(row is not None and token(row)==handle.get('token') and row.get('role')=='user','ATTACHMENT_ROW_STALE')
    check(type(scope.get('maxBytes')) is int and 1<=scope['maxBytes']<=CAP,'ATTACHMENT_LIMIT_INVALID')
    import re
    check(isinstance(card.get('displayName'),str) and re.fullmatch(r'[^\\/:\x00-\x1f]{1,196}\.(txt|docx|pdf)',card['displayName'],re.I),'ATTACHMENT_FORMAT_UNSUPPORTED')
    port=getattr(backend,'_attachment_native_port',None)
    if config.mode=='fake' and config.fake_options.get('attachment_fixture'):
        port=FixturePort(config.fake_options['attachment_fixture'])
    check(port is not None,'NATIVE_ACCEPTANCE_REQUIRED')
    root=Path(audit_path).parent/'attachment-downloads'
    for part in [*reversed(root.parents),root]:
        if part.exists() or part.is_symlink():
            st=part.lstat();check(not stat.S_ISLNK(st.st_mode) and not getattr(st,'st_file_attributes',0)&0x400,'ATTACHMENT_LINK_DENIED')
    root.mkdir(exist_ok=True)
    key=digest([scope['ownerBindingId'],chat.key,handle['messageId']]);journal=root/(key+'.json')
    if journal.exists():
        st=journal.lstat();check(stat.S_ISREG(st.st_mode) and st.st_nlink==1 and not journal.is_symlink() and st.st_size<16384,'ATTACHMENT_JOURNAL_INVALID')
        saved=json.loads(journal.read_text())
    else:saved=None
    if command=='attachment_inspect':
        return port.inspect(card,dict(scope,verifiedHandle=handle),getattr(backend,'_attachment_profile',{}))
    path=checked(root,scope['destination'])
    if saved:
        check(saved['destination']==str(path),'ATTACHMENT_RESERVATION_MISMATCH')
    if command=='attachment_save_as':
        check(saved is None,'ATTACHMENT_SAVE_ALREADY_ATTEMPTED')
        check(not path.exists(),'ATTACHMENT_DESTINATION_EXISTS')
        path.parent.mkdir(exist_ok=True)
        # Durable intent before any native action; an exception is unknown, never
        # permission to repeat save. Existing JS broker also keeps its reservation.
        with journal.open('x',encoding='utf-8') as out:
            json.dump({'destination':str(path),'messageId':handle['messageId'],'state':'attempted'},out);out.flush();os.fsync(out.fileno())
        port.saveAs(card,dict(scope,verifiedHandle=handle,profile=getattr(backend,'_attachment_profile',{})))
        return {'actionAttempted':True,'sourceMessageId':handle['messageId']}
    check(saved is not None,'ATTACHMENT_RESERVATION_REQUIRED')
    proof=port.completion(card,dict(scope,verifiedHandle=handle))
    if proof.get('completed') is not True:return {'completed':False}
    check(proof.get('sourceMessageId')==handle['messageId'] and proof.get('chatId')==scope['ownerChatId'] and proof.get('destination')==str(path),'ATTACHMENT_COMPLETION_BINDING_MISMATCH')
    sha=verified_payload(root,proof,scope['maxBytes'])
    if saved.get('sha256'):check(saved['sha256']==sha,'ATTACHMENT_HASH_CHANGED')
    saved.update(state='complete',sha256=sha)
    temp=journal.parent/('.'+uuid.uuid4().hex+'.tmp')
    with temp.open('x',encoding='utf-8') as out:json.dump(saved,out)
    os.replace(temp,journal)
    return dict(proof,verified=True,sha256=sha,ownerBindingId=scope['ownerBindingId'])
