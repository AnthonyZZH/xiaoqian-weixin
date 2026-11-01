"""Code-owned native row metadata included in the controller's signed page."""
import hashlib,re,os

def observe(backend,row):
    if row.role!='user':return None
    control=getattr(row,'native_row',None)
    if control is None:return None
    try:
        name=control.Name or ''
        files=[x.strip() for x in name.splitlines() if re.fullmatch(r'[^\\/:\x00-\x1f]{1,196}\.(txt|docx|pdf)',x.strip(),re.I)]
        kind='file' if control.ClassName=='mmui::ChatBubbleItemView' and len(files)==1 else 'image' if getattr(row,'native_image_available',False) else None
        if kind is None:return None
        adapter=backend.adapter;module=backend.module
        return dict(schema='xq.native-row/v1',kind=kind,workerPid=os.getpid(),generation=backend._attachment_generation,
          hwnd=adapter.hwnd,wechatPid=module.window_pid(adapter.hwnd),runtimeId=list(control.GetRuntimeId()),className=control.ClassName,
          nameSha256=hashlib.sha256(name.encode()).hexdigest(),displayName=files[0] if files else None,
          received=('未下载' not in name) if kind=='file' else None)
    except Exception:return None
