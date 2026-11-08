"""Owner-only native file acquisition bound to the current driver read."""
import re,hashlib
from .protocol import DriverError
from .snapshot_identity import token

class SavedFileError(DriverError):pass
def require(ok,code):
    if not ok:raise SavedFileError(code)

class NativeSavedFileBroker:
    def __init__(self,backend,generation):
        self.backend,self.generation=backend,generation
        self.entries={};self.context=None
    def begin_read(self,chat,rows,context):
        self.entries={};self.context=dict(context or {});self.chat=chat
        for raw in rows:
            ref=raw.get('native_ref')
            if raw.get('role')=='user' and isinstance(ref,dict) and ref.get('kind')=='file':
                native=getattr(self.backend,'rows',{}).get(raw['key'])
                if native is not None:
                    self.entries[raw['key']]=dict(raw=dict(raw),ref=dict(ref),control=native.native_row,state='new',canonical=None)
    def current(self,entry,*,check_name=True):
        b=self.backend;ref=entry['ref'];c=entry['control']
        try:
            return b.chat==self.chat and b.adapter.hwnd==ref['hwnd'] and b.module.window_pid(ref['hwnd'])==ref['wechatPid'] and \
              c.ClassName==ref['className'] and list(c.GetRuntimeId())==ref['runtimeId'] and \
              (not check_name or hashlib.sha256((c.Name or '').encode()).hexdigest()==ref['nameSha256'])
        except Exception:return False
    def dispatch(self,chat,command,args):
        require(chat==self.chat and chat.mode=='private' and chat==getattr(self.backend,'_edge_owner',None),'SAVED_FILE_OWNER_REQUIRED')
        h=args.get('handle',{});context=self.context
        require(context and args.get('readId')==context.get('readId'),'SAVED_FILE_READ_STALE')
        require(args.get('generation')==self.generation and h.get('generation')==self.generation,'SAVED_FILE_GENERATION_STALE')
        require(h.get('chatKey')==chat.key,'SAVED_FILE_CHAT_CHANGED')
        entry=self.entries.get(h.get('sourceKey'));require(entry,'SAVED_FILE_CONTROL_UNAVAILABLE')
        require(token(entry['raw'])==h.get('token'),'SAVED_FILE_ROW_STALE')
        mid=h.get('messageId');require(isinstance(mid,str) and re.fullmatch('[a-f0-9]{64}',mid),'SAVED_FILE_CANONICAL_REQUIRED')
        require(entry['canonical'] in (None,mid),'SAVED_FILE_CANONICAL_CHANGED')
        require(self.current(entry),'SAVED_FILE_CONTROL_REDRAWN')
        entry['canonical']=mid
        if command=='saved_file_acquire':
            from .saved_file_acquire import acquire
            from .saved_file_surface import NativeFileSurface
            return acquire(self,entry,mid,surface=NativeFileSurface(self.backend))
        raise SavedFileError('SAVED_FILE_COMMAND_DENIED')
