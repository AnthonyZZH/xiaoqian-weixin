"""Private owner-only native selection receipt. No filename search or document open.

prepare records the exact current UIA file control. The host's coordinated native
Show in folder action happens between prepare and selected. selected reads only
Explorer's foreground selected item; no directory enumeration. The ticket is
single-use and bound to the same signed driver read, worker, chat and UIA object.
"""
import os,re,time,secrets,json,hashlib
from pathlib import Path
from .protocol import DriverError
from .snapshot_identity import token
from .native_saved_file_location import normalize_location
from .saved_file_identity import checked_path,WindowsFile

class SavedFileError(DriverError):pass
def require(ok,code):
    if not ok:raise SavedFileError(code)

class NativeSavedFileBroker:
    def __init__(self,backend,generation,clock=time.monotonic):
        self.backend,self.generation,self.clock=backend,generation,clock
        self.entries={};self.context=None
    def begin_read(self,chat,rows,context):
        self.entries={};self.context=dict(context or {});self.chat=chat
        for raw in rows:
            ref=raw.get('native_ref')
            if raw.get('role')=='user' and isinstance(ref,dict) and ref.get('kind')=='file':
                native=getattr(self.backend,'rows',{}).get(raw['key'])
                if native is not None:
                    self.entries[raw['key']]=dict(raw=dict(raw),ref=dict(ref),control=native.native_row,state='new',canonical=None)
    def current(self,entry):
        b=self.backend;ref=entry['ref'];c=entry['control']
        try:
            return b.chat==self.chat and b.adapter.hwnd==ref['hwnd'] and b.module.window_pid(ref['hwnd'])==ref['wechatPid'] and \
              c.ClassName==ref['className'] and list(c.GetRuntimeId())==ref['runtimeId'] and \
              hashlib.sha256((c.Name or '').encode()).hexdigest()==ref['nameSha256']
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
            surface=getattr(self,'test_surface',None) or NativeFileSurface(self.backend)
            return acquire(self,entry,mid,surface=surface)
        if command=='saved_file_prepare':
            require(entry['state']=='new','SAVED_FILE_ALREADY_ATTEMPTED')
            require(entry['ref'].get('received') is True,'SAVED_FILE_NATIVE_RECEIVE_REQUIRED')
            require(self.backend.module.foreground()==entry['ref']['hwnd'],'SAVED_FILE_OWNER_NOT_FOREGROUND')
            ticket=secrets.token_urlsafe(32);entry.update(state='prepared',ticket=ticket,deadline=self.clock()+120)
            return dict(schema='xq.native-saved-file-prepared/v1',sourceMessageId=mid,readId=context['readId'],generation=self.generation,
              ticket=ticket,nativeRef=entry['ref'])
        require(command=='saved_file_selected','SAVED_FILE_OPERATION_DENIED')
        require(entry['state']=='prepared' and args.get('ticket')==entry['ticket'],'SAVED_FILE_TICKET_INVALID')
        require(self.clock()<entry['deadline'],'SAVED_FILE_TICKET_EXPIRED')
        entry['state']='unknown' # Reserve before COM; never retry an uncertain result.
        profile=getattr(self.backend.module,'NATIVE_SAVED_FILE_ROOT',None)
        require(isinstance(profile,str),'SAVED_FILE_ROOT_NOT_CONFIGURED')
        module=self.backend.module;foreground=module.foreground()
        require(module.class_name(foreground)=='CabinetWClass','SAVED_FILE_EXPLORER_NOT_FOREGROUND')
        import comtypes.client
        windows=comtypes.client.CreateObject('Shell.Application',dynamic=True).Windows()
        selected=[]
        for index in range(int(windows.Count)):
            window=windows.Item(index)
            if int(window.HWND)!=foreground:continue
            items=window.Document.SelectedItems();require(int(items.Count)==1,'SAVED_FILE_SELECTION_NOT_UNIQUE')
            item=items.Item(0);require(item.IsFileSystem and not item.IsFolder,'SAVED_FILE_SELECTION_NOT_FILE')
            selected.append(dict(path=str(item.Path),bytes=int(item.Size)))
        require(len(selected)==1,'SAVED_FILE_EXPLORER_NOT_UNIQUE');chosen=selected[0]
        relative=normalize_location(chosen['path'],profile,entry['ref']['displayName'])
        request=dict(root=profile,relativePath=relative,expectedBytes=chosen['bytes'])
        root,target=checked_path(request);locked=WindowsFile(root,target)
        try:identity=locked.identity
        finally:locked.close()
        require(self.current(entry),'SAVED_FILE_CONTROL_CHANGED')
        require(0<chosen['bytes']<=5*1024*1024,'SAVED_FILE_SIZE_LIMIT')
        entry['state']='completed'
        return dict(kind='native-saved-file',mappingMethod='native-file-id',sourceMessageId=mid,
          generation=self.generation,readId=context['readId'],nativeFileId=json.dumps(identity,sort_keys=True),
          displayName=entry['ref']['displayName'],relativePath=relative,expectedBytes=chosen['bytes'],fileIdentity=identity,completed=True,
          accountId=Path(profile).parent.parent.name,receiptKind='same-read-native-show-in-folder')
