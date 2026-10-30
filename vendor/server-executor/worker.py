"""Bounded Windows project data operations. No shell, eval or model execution."""
import contextlib, ctypes, hashlib, json, os, stat, sys, uuid
from pathlib import Path
from ctypes import wintypes as W

LIMIT = 65536
EXTENSIONS = {'.txt','.md','.json','.csv','.log','.py','.js','.mjs','.html','.css','.xml','.yaml','.yml'}
DENIED = {'.git','.ssh','.aws','.codex','.agents','credentials','secrets','private','node_modules','__pycache__'}

def require(value, code):
    if not value: raise ValueError(code)

if os.name == 'nt':
    K = ctypes.WinDLL('kernel32', use_last_error=True)
    class INFO(ctypes.Structure):
        _fields_ = [('attributes',W.DWORD),('created',W.FILETIME),('accessed',W.FILETIME),('written',W.FILETIME),('volume',W.DWORD),('sizeHigh',W.DWORD),('sizeLow',W.DWORD),('links',W.DWORD),('indexHigh',W.DWORD),('indexLow',W.DWORD)]
    K.CreateFileW.argtypes=[W.LPCWSTR,W.DWORD,W.DWORD,ctypes.c_void_p,W.DWORD,W.DWORD,W.HANDLE]
    K.CreateFileW.restype=W.HANDLE
    K.GetFileInformationByHandle.argtypes=[W.HANDLE,ctypes.POINTER(INFO)]
    K.GetFinalPathNameByHandleW.argtypes=[W.HANDLE,W.LPWSTR,W.DWORD,W.DWORD]
    K.CloseHandle.argtypes=[W.HANDLE]

@contextlib.contextmanager
def pin(p, directory=False):
    """Deny delete sharing while held; reject reparse points at actual open."""
    require(os.name == 'nt','WINDOWS_REQUIRED')
    h=K.CreateFileW(str(p),0 if directory else 0x80000000,3,None,3,0x02200000,None)
    require(h != ctypes.c_void_p(-1).value,'OPEN_DENIED')
    try:
        info=INFO()
        require(K.GetFileInformationByHandle(h,ctypes.byref(info)),'FILE_INFO_FAILED')
        require(not info.attributes & 0x400,'REPARSE_DENIED')
        require(bool(info.attributes & 0x10)==directory,'FILE_TYPE_DENIED')
        if not directory: require(info.links == 1,'HARDLINK_DENIED')
        buf=ctypes.create_unicode_buffer(32768)
        n=K.GetFinalPathNameByHandleW(h,buf,len(buf),0)
        require(0 < n < len(buf),'REALPATH_FAILED')
        final=buf.value
        if final.startswith('\\\\?\\'): final=final[4:]
        require(os.path.normcase(final)==os.path.normcase(str(p)),'REALPATH_MISMATCH')
        yield h,info
    finally: K.CloseHandle(h)

def relative(value, allow_empty=False):
    require(isinstance(value,str) and len(value)<=512,'PATH_INVALID')
    if allow_empty and value=='': return []
    parts=value.split('/')
    require(all(x and x not in {'.','..'} and x.lower() not in DENIED and not x.startswith('.') and not x.endswith((' ','.')) and not any(c in x for c in '\\:\x00<>"|?*') and x.split('.')[0].upper() not in {'CON','PRN','AUX','NUL',*[f'COM{i}' for i in range(10)],*[f'LPT{i}' for i in range(10)]} for x in parts),'PATH_INVALID')
    return parts

def read_handle(h, info, maximum=LIMIT):
    size=(info.sizeHigh<<32)|info.sizeLow
    require(size<=maximum,'FILE_LIMIT')
    data=ctypes.create_string_buffer(size+1); count=W.DWORD()
    K.ReadFile.argtypes=[W.HANDLE,ctypes.c_void_p,W.DWORD,ctypes.POINTER(W.DWORD),ctypes.c_void_p]
    require(K.ReadFile(h,data,size+1,ctypes.byref(count),None),'READ_FAILED')
    require(count.value==size,'FILE_CHANGED')
    return data.raw[:size]

def perform(req):
    require(os.name=='nt','WINDOWS_REQUIRED')
    root=Path(req['root'])
    require(root.is_absolute() and str(root)==os.path.abspath(root) and not str(root).startswith('\\\\'),'ROOT_INVALID')
    operation=req['operation']; parts=relative(req.get('path',''),operation=='list')
    require(operation in {'read','write','stat','list','sha256'},'COMMAND_UNSUPPORTED')
    target=root.joinpath(*parts)
    with contextlib.ExitStack() as stack:
        # Pin every ancestor, including root and all project subdirectories.
        ancestors=list(reversed(root.parents))+[root]
        for p in ancestors: stack.enter_context(pin(p,True))
        for i in range(1,len(parts)): stack.enter_context(pin(root.joinpath(*parts[:i]),True))
        if operation=='list':
            if parts: stack.enter_context(pin(target,True))
            rows=[]
            with os.scandir(target) as entries:
                for item in entries:
                    if len(rows)>=100: return {'entries':rows,'truncated':True}
                    try:
                        relative(item.name)
                        is_dir=item.is_dir(follow_symlinks=False)
                        if not is_dir and Path(item.name).suffix.lower() not in EXTENSIONS: continue
                        with pin(Path(item.path),is_dir) as (_,info):
                            rows.append({'name':item.name,'directory':is_dir,'bytes':(info.sizeHigh<<32)|info.sizeLow})
                    except (ValueError,OSError): continue
            return {'entries':rows,'truncated':False}
        require(target.suffix.lower() in EXTENSIONS,'FILE_TYPE_DENIED')
        if operation=='write':
            data=req.get('text'); require(isinstance(data,str),'TEXT_INVALID'); data=data.encode('utf-8'); require(len(data)<=LIMIT,'FILE_LIMIT')
            original=None
            try:
                with pin(target) as (h,info): original=read_handle(h,info)
            except ValueError as e:
                if str(e)!='OPEN_DENIED' or os.path.lexists(target): raise
            backup=None
            if original is not None:
                backup=f'{target.stem}.backup-{uuid.uuid4().hex}{target.suffix}'
                with open(target.with_name(backup),'xb') as f: f.write(original); f.flush(); os.fsync(f.fileno())
            temp=target.with_name(f'.server-executor-{uuid.uuid4().hex}.tmp')
            # Preserve all originals/backups. Failed temporary writes are left for diagnosis.
            with open(temp,'xb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
            os.replace(temp,target)
            return {'writtenBytes':len(data),'backup':backup,'sha256':hashlib.sha256(data).hexdigest()}
        with pin(target) as (h,info):
            size=(info.sizeHigh<<32)|info.sizeLow
            if operation=='stat': return {'bytes':size,'links':info.links}
            data=read_handle(h,info)
            if operation=='sha256': return {'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
            require(b'\x00' not in data,'BINARY_DENIED')
            return {'text':data.decode('utf-8-sig'),'bytes':len(data),'untrusted':True}

if __name__=='__main__':
    try:
        raw=sys.stdin.buffer.read(150000)
        require(len(raw)<150000,'REQUEST_LIMIT')
        result=perform(json.loads(raw))
        print(json.dumps({'ok':True,'result':result},ensure_ascii=True))
    except Exception as e:
        code=str(e) if isinstance(e,ValueError) and str(e).replace('_','').isalnum() and str(e).isupper() else 'OPERATION_FAILED'
        print(json.dumps({'ok':False,'code':code})); sys.exit(1)
