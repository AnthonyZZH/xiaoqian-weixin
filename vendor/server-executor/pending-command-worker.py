"""UNENABLED: generic host-identity PowerShell, Job lifecycle; NOT a sandbox.
No production invocation is authorized by the presence of this source file.
"""
import base64, ctypes, json, os, sys, threading, time
from ctypes import wintypes as W

def run(req, cancel=None):
    if os.name!='nt': raise ValueError('WINDOWS_REQUIRED')
    script=req['script']; cwd=req['cwd']; timeout=req['timeoutMs']/1000
    # EncodedCommand must also fit Windows' 32767-character process command line.
    if not isinstance(script,str) or not 0<len(script.encode('utf-8'))<=10000: raise ValueError('SCRIPT_INVALID')
    if not os.path.isabs(cwd) or not os.path.isdir(cwd): raise ValueError('CWD_INVALID')
    if not 0.1<=timeout<=120: raise ValueError('TIMEOUT_INVALID')
    K=ctypes.WinDLL('kernel32',use_last_error=True)
    SIZE=ctypes.c_size_t
    class SA(ctypes.Structure): _fields_=[('length',W.DWORD),('descriptor',W.LPVOID),('inherit',W.BOOL)]
    class SI(ctypes.Structure):
        _fields_=[('cb',W.DWORD),('reserved',W.LPWSTR),('desktop',W.LPWSTR),('title',W.LPWSTR),('x',W.DWORD),('y',W.DWORD),('xs',W.DWORD),('ys',W.DWORD),('xc',W.DWORD),('yc',W.DWORD),('fill',W.DWORD),('flags',W.DWORD),('show',W.WORD),('reserved2',W.WORD),('reservedp',W.LPBYTE),('stdin',W.HANDLE),('stdout',W.HANDLE),('stderr',W.HANDLE)]
    class SX(ctypes.Structure): _fields_=[('si',SI),('attributes',W.LPVOID)]
    class PI(ctypes.Structure): _fields_=[('process',W.HANDLE),('thread',W.HANDLE),('pid',W.DWORD),('tid',W.DWORD)]
    class BASIC(ctypes.Structure):
        _fields_=[('processTime',ctypes.c_longlong),('jobTime',ctypes.c_longlong),('flags',W.DWORD),('minWorking',SIZE),('maxWorking',SIZE),('activeLimit',W.DWORD),('affinity',SIZE),('priority',W.DWORD),('scheduling',W.DWORD)]
    class IO(ctypes.Structure): _fields_=[(n,ctypes.c_ulonglong) for n in ['reads','writes','other','readBytes','writeBytes','otherBytes']]
    class LIMITS(ctypes.Structure): _fields_=[('basic',BASIC),('io',IO),('processMemory',SIZE),('jobMemory',SIZE),('peakProcess',SIZE),('peakJob',SIZE)]
    class ACCOUNTING(ctypes.Structure): _fields_=[('ut',ctypes.c_longlong),('kt',ctypes.c_longlong),('put',ctypes.c_longlong),('pkt',ctypes.c_longlong),('faults',W.DWORD),('total',W.DWORD),('active',W.DWORD),('terminated',W.DWORD)]
    def bind(name,args,result=W.BOOL):
        f=getattr(K,name);f.argtypes=args;f.restype=result;return f
    close=bind('CloseHandle',[W.HANDLE]);jobCreate=bind('CreateJobObjectW',[W.LPVOID,W.LPCWSTR],W.HANDLE)
    setJob=bind('SetInformationJobObject',[W.HANDLE,ctypes.c_int,W.LPVOID,W.DWORD])
    assign=bind('AssignProcessToJobObject',[W.HANDLE,W.HANDLE]);terminate=bind('TerminateJobObject',[W.HANDLE,W.UINT])
    query=bind('QueryInformationJobObject',[W.HANDLE,ctypes.c_int,W.LPVOID,W.DWORD,W.LPVOID])
    pipe=bind('CreatePipe',[ctypes.POINTER(W.HANDLE),ctypes.POINTER(W.HANDLE),ctypes.POINTER(SA),W.DWORD])
    info=bind('SetHandleInformation',[W.HANDLE,W.DWORD,W.DWORD])
    createFile=bind('CreateFileW',[W.LPCWSTR,W.DWORD,W.DWORD,ctypes.POINTER(SA),W.DWORD,W.DWORD,W.HANDLE],W.HANDLE)
    init=bind('InitializeProcThreadAttributeList',[W.LPVOID,W.DWORD,W.DWORD,ctypes.POINTER(SIZE)])
    update=bind('UpdateProcThreadAttribute',[W.LPVOID,W.DWORD,SIZE,W.LPVOID,SIZE,W.LPVOID,W.LPVOID])
    delete=bind('DeleteProcThreadAttributeList',[W.LPVOID],None)
    create=bind('CreateProcessW',[W.LPCWSTR,W.LPWSTR,W.LPVOID,W.LPVOID,W.BOOL,W.DWORD,W.LPVOID,W.LPCWSTR,ctypes.POINTER(SX),ctypes.POINTER(PI)])
    resume=bind('ResumeThread',[W.HANDLE],W.DWORD);killProcess=bind('TerminateProcess',[W.HANDLE,W.UINT])
    read=bind('ReadFile',[W.HANDLE,W.LPVOID,W.DWORD,ctypes.POINTER(W.DWORD),W.LPVOID])
    getCode=bind('GetExitCodeProcess',[W.HANDLE,ctypes.POINTER(W.DWORD)])
    def check(ok):
        if not ok: raise ValueError('WINDOWS_JOB_FAILED')
    handles=[];attrs=None;attrsInitialized=False;pi=PI();job=None;assigned=False
    try:
        job=jobCreate(None,None);check(job);handles.append(job)
        limits=LIMITS();limits.basic.flags=0x2000|0x8|0x200 # kill-on-close, active-process, total-job-memory
        limits.basic.activeLimit=16;limits.jobMemory=512*1024*1024
        check(setJob(job,9,ctypes.byref(limits),ctypes.sizeof(limits)))
        sa=SA(ctypes.sizeof(SA),None,True);r=W.HANDLE();w=W.HANDLE()
        check(pipe(ctypes.byref(r),ctypes.byref(w),ctypes.byref(sa),0));handles.extend([r.value,w.value]);check(info(r,1,0))
        null=createFile('NUL',0x80000000,3,ctypes.byref(sa),3,0,None)
        check(null and null!=ctypes.c_void_p(-1).value);handles.append(null)
        needed=SIZE();init(None,2,0,ctypes.byref(needed));attrs=ctypes.create_string_buffer(needed.value)
        check(init(attrs,2,0,ctypes.byref(needed)))
        attrsInitialized=True
        allowed=(W.HANDLE*2)(w.value,null)
        check(update(attrs,0,0x20002,ctypes.cast(allowed,W.LPVOID),ctypes.sizeof(allowed),None,None))
        # Atomic job assignment at creation, eliminating the suspended-child orphan gap.
        jobs=(W.HANDLE*1)(job)
        check(update(attrs,0,0x2000d,ctypes.cast(jobs,W.LPVOID),ctypes.sizeof(jobs),None,None))
        sx=SX();sx.si.cb=ctypes.sizeof(SX);sx.si.flags=0x100;sx.si.stdin=null;sx.si.stdout=w.value;sx.si.stderr=w.value;sx.attributes=ctypes.cast(attrs,W.LPVOID)
        exe=os.path.join(os.environ['SystemRoot'],'System32','WindowsPowerShell','v1.0','powershell.exe')
        script="$ProgressPreference='SilentlyContinue'\n$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)\n"+script
        encoded=base64.b64encode(script.encode('utf-16-le')).decode('ascii')
        cmd=ctypes.create_unicode_buffer(f'"{exe}" -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}')
        check(create(exe,cmd,None,None,True,0x4|0x80000|0x08000000,None,cwd,ctypes.byref(sx),ctypes.byref(pi)))
        handles.extend([pi.process,pi.thread])
        assigned=True
        close(w.value);handles.remove(w.value);close(null);handles.remove(null)
        chunks=[];captured=0;total=0
        def drain():
            nonlocal captured,total
            while True:
                buf=ctypes.create_string_buffer(4096);n=W.DWORD()
                if not read(r,buf,len(buf),ctypes.byref(n),None) or not n.value: return
                total+=n.value
                remaining=32768-captured
                if remaining>0:
                    b=buf.raw[:min(remaining,n.value)];chunks.append(b);captured+=len(b)
        reader=threading.Thread(target=drain,daemon=True);reader.start()
        check(resume(pi.thread)!=0xffffffff)
        deadline=time.monotonic()+timeout;timedOut=False;cancelled=False;confirmed=False
        while True:
            accounting=ACCOUNTING();check(query(job,1,ctypes.byref(accounting),ctypes.sizeof(accounting),None))
            if accounting.active==0: confirmed=True;break
            if cancel is not None and cancel.is_set():
                cancelled=True;check(terminate(job,125));break
            if time.monotonic()>=deadline:
                timedOut=True;check(terminate(job,124));break
            time.sleep(.025)
        if timedOut or cancelled:
            end=time.monotonic()+2
            while time.monotonic()<end:
                accounting=ACCOUNTING();check(query(job,1,ctypes.byref(accounting),ctypes.sizeof(accounting),None))
                if accounting.active==0: confirmed=True;break
                time.sleep(.025)
        reader.join(1)
        code=W.DWORD();check(getCode(pi.process,ctypes.byref(code)))
        if not confirmed: raise ValueError('TERMINATION_UNCONFIRMED')
        return {'exitCode':code.value,'timedOut':timedOut,'cancelled':cancelled,'jobExitConfirmed':confirmed,'output':b''.join(chunks).decode('utf-8',errors='replace'),'outputBytes':total,'truncated':total>captured,'untrusted':True}
    finally:
        if pi.process and not assigned: killProcess(pi.process,125)
        if job: terminate(job,125)
        if attrsInitialized: delete(attrs)
        for h in reversed(handles): close(h)

if __name__=='__main__':
    try:
        # Read control bytes without a buffered-reader daemon lock at shutdown.
        raw=sys.stdin.buffer.raw.readline(150000)
        if len(raw)>=150000: raise ValueError('REQUEST_LIMIT')
        cancelled=threading.Event()
        def control():
            try:
                data=b''
                while True:
                    part=os.read(sys.stdin.fileno(),1024)
                    if not part: cancelled.set();return
                    data+=part
                    if len(data)>1000: cancelled.set();return
                    if b'\n' in data:
                        if json.loads(data.split(b'\n',1)[0]).get('cancel') is True: cancelled.set()
                        return
            except Exception: cancelled.set()
        threading.Thread(target=control,daemon=True).start()
        result=run(json.loads(raw),cancelled);print(json.dumps({'ok':True,'result':result},ensure_ascii=True))
    except Exception as e:
        code=str(e) if isinstance(e,ValueError) and str(e).replace('_','').isalpha() and str(e).isupper() else 'COMMAND_FAILED'
        print(json.dumps({'ok':False,'code':code}));sys.exit(1)
