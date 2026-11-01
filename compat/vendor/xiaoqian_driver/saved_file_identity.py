"""Read one natively bound, completed saved document. Never searches directories."""
import base64,hashlib,json,os,re,stat,sys,time
from pathlib import Path

CAP=5*1024*1024
class Rejected(ValueError):pass
def require(ok,code):
    if not ok:raise Rejected(code)
def regular(path,directory=False):
    s=path.lstat()
    require(not stat.S_ISLNK(s.st_mode) and not getattr(s,'st_file_attributes',0)&0x400,'SAVED_FILE_REPARSE_DENIED')
    require(stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode),'SAVED_FILE_TYPE_DENIED')
    if not directory:require(s.st_nlink==1,'SAVED_FILE_HARDLINK_DENIED')
    return s
def relative_parts(value):
    require(isinstance(value,str) and 0<len(value)<=1000,'SAVED_FILE_PATH_DENIED')
    require(not value.startswith(('\\','/')) and not re.search(r'[:\x00-\x1f<>"|?*]',value),'SAVED_FILE_PATH_DENIED')
    parts=re.split(r'[\\/]',value)
    require(all(p and p not in ('.','..') and p[-1] not in '. ' and not re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)',p,re.I) for p in parts),'SAVED_FILE_PATH_DENIED')
    require(Path(parts[-1]).suffix.lower() in ('.txt','.docx','.pdf'),'SAVED_FILE_FORMAT_DENIED')
    return parts
def ancestry(path):
    return [*reversed(path.parents),path]
def checked_path(request):
    root=Path(request['root'])
    require(root.is_absolute() and not str(root).startswith(('\\\\','//')),'SAVED_FILE_ROOT_DENIED')
    parts=relative_parts(request['relativePath'])
    for parent in ancestry(root):regular(parent,True)
    target=root.joinpath(*parts)
    for parent in ancestry(target.parent):regular(parent,True)
    require(target.is_relative_to(root) and target!=root,'SAVED_FILE_PATH_DENIED')
    regular(target)
    return root,target

class WindowsFile:
    """Pins ancestors against rename and denies concurrent writers to the file."""
    def __init__(self,root,target):
        import ctypes as c
        from ctypes import wintypes as w
        self.c,self.w=c,w;self.k=c.WinDLL('kernel32',use_last_error=True);self.handles=[]
        self.k.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,c.c_void_p,w.DWORD,w.DWORD,w.HANDLE]
        self.k.CreateFileW.restype=w.HANDLE
        self.k.CloseHandle.argtypes=[w.HANDLE];self.k.CloseHandle.restype=w.BOOL
        self.k.GetFinalPathNameByHandleW.argtypes=[w.HANDLE,w.LPWSTR,w.DWORD,w.DWORD];self.k.GetFinalPathNameByHandleW.restype=w.DWORD
        self.k.GetFileInformationByHandleEx.argtypes=[w.HANDLE,c.c_int,c.c_void_p,w.DWORD];self.k.GetFileInformationByHandleEx.restype=w.BOOL
        class INFO(c.Structure):
            _fields_=[('attrs',w.DWORD),('created',w.FILETIME),('access',w.FILETIME),('written',w.FILETIME),('volume',w.DWORD),('sizeHigh',w.DWORD),('sizeLow',w.DWORD),('links',w.DWORD),('idHigh',w.DWORD),('idLow',w.DWORD)]
        self.INFO=INFO
        self.k.GetFileInformationByHandle.argtypes=[w.HANDLE,c.POINTER(INFO)];self.k.GetFileInformationByHandle.restype=w.BOOL
        try:
            for parent in ancestry(target.parent):self.open(parent,True)
            self.handle=self.open(target,False)
            import msvcrt
            fd=msvcrt.open_osfhandle(int(self.handle),os.O_RDONLY|os.O_BINARY)
            self.handles.remove(self.handle) # fd now owns the HANDLE.
            self.stream=os.fdopen(fd,'rb')
        except BaseException:self.close();raise
    def open(self,path,directory):
        c,w=self.c,self.w
        h=self.k.CreateFileW('\\\\?\\'+str(path),0x80000000 if not directory else 0x80,3 if directory else 1,None,3,0x00200000|(0x02000000 if directory else 0),None)
        if h==w.HANDLE(-1).value:
            raise Rejected('SAVED_FILE_BUSY' if c.get_last_error() in (32,33) else 'SAVED_FILE_OPEN_DENIED')
        self.handles.append(h)
        info=self.INFO();require(self.k.GetFileInformationByHandle(h,c.byref(info)),'SAVED_FILE_STAT_FAILED')
        require(not info.attrs&0x400,'SAVED_FILE_REPARSE_DENIED')
        require(bool(info.attrs&0x10)==directory,'SAVED_FILE_TYPE_DENIED')
        if not directory:
            require(info.links==1,'SAVED_FILE_HARDLINK_DENIED')
            self.identity={'scheme':'windows-file-id-v1','device':str(info.volume),'inode':str((info.idHigh<<32)|info.idLow)}
        buffer=c.create_unicode_buffer(32768)
        n=self.k.GetFinalPathNameByHandleW(h,buffer,len(buffer),0)
        require(0<n<len(buffer),'SAVED_FILE_CANONICAL_UNVERIFIED')
        require(buffer.value.removeprefix('\\\\?\\').casefold()==str(path).casefold(),'SAVED_FILE_REPARSE_DENIED')
        return h
    def close(self):
        if getattr(self,'stream',None):self.stream.close();self.stream=None
        for h in reversed(self.handles):self.k.CloseHandle(h)
        self.handles=[]

def read_saved(request):
    expected=request.get('expectedBytes');limit=request.get('maxBytes',CAP)
    require(type(limit) is int and 0<limit<=CAP,'SAVED_FILE_LIMIT_INVALID')
    require(type(expected) is int and 0<=expected<=limit,'SAVED_FILE_SIZE_LIMIT')
    stable_ms=request.get('stableMs',75)
    require(type(stable_ms) is int and 20<=stable_ms<=250,'SAVED_FILE_STABILITY_INVALID')
    expected_hash=request.get('expectedSha256')
    require(expected_hash is None or isinstance(expected_hash,str) and re.fullmatch('[a-f0-9]{64}',expected_hash),'SAVED_FILE_HASH_INVALID')
    root,target=checked_path(request)
    locked=None;stream=None
    try:
        if os.name=='nt':
            locked=WindowsFile(root,target);stream=locked.stream
        else:
            # POSIX is useful for isolated fixtures; production is Windows only.
            stream=os.fdopen(os.open(target,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)),'rb')
            import fcntl
            try:fcntl.flock(stream,fcntl.LOCK_SH|fcntl.LOCK_NB)
            except BlockingIOError:raise Rejected('SAVED_FILE_BUSY') from None
        initial=os.fstat(stream.fileno());before=regular(target)
        require((initial.st_dev,initial.st_ino)==(before.st_dev,before.st_ino),'SAVED_FILE_CHANGED')
        actual_identity=locked.identity if locked else {'scheme':'posix-stat-v1','device':str(initial.st_dev),'inode':str(initial.st_ino)}
        expected_identity=request.get('fileIdentity')
        require(expected_identity==actual_identity,'SAVED_FILE_IDENTITY_MISMATCH')
        require(initial.st_nlink==1 and initial.st_size==expected,'SAVED_FILE_SIZE_MISMATCH')
        def sample():
            stream.seek(0);parts=[];total=0;h=hashlib.sha256()
            while True:
                block=stream.read(min(1024*1024,limit+1-total))
                if not block:break
                total+=len(block);require(total<=limit,'SAVED_FILE_SIZE_LIMIT');parts.append(block);h.update(block)
            s=os.fstat(stream.fileno())
            require(total==expected and (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns)==(initial.st_dev,initial.st_ino,initial.st_size,initial.st_mtime_ns),'SAVED_FILE_CHANGED')
            return b''.join(parts),h.hexdigest()
        raw,sha=sample();time.sleep(stable_ms/1000);again,second=sample()
        require(sha==second and raw==again,'SAVED_FILE_CHANGED')
        require(expected_hash is None or sha==expected_hash,'SAVED_FILE_HASH_MISMATCH')
        checked_path(request)
        last=regular(target)
        require((last.st_dev,last.st_ino,last.st_size,last.st_mtime_ns)==(initial.st_dev,initial.st_ino,initial.st_size,initial.st_mtime_ns),'SAVED_FILE_CHANGED')
        return {'base64':base64.b64encode(raw).decode(),'bytes':len(raw),'sha256':sha,'extension':target.suffix.lower(),'fileIdentity':actual_identity,'exclusiveRead':os.name=='nt'}
    finally:
        if locked:locked.close()
        elif stream:stream.close()

def main():
    try:
        raw=sys.stdin.buffer.read(16385);require(len(raw)<=16384,'SAVED_FILE_REQUEST_LIMIT')
        request=json.loads(raw);result=read_saved(request)
        print(json.dumps({'ok':True,'result':result}))
    except Rejected as error:print(json.dumps({'ok':False,'code':str(error)}))
    except Exception:print(json.dumps({'ok':False,'code':'SAVED_FILE_READ_FAILED'}))
if __name__=='__main__':main()
