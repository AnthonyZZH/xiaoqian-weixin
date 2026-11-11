"""Open only the bound incoming photo, save its full image, then restore chat.

Runs inside the existing worker/desktop lease. No network, clipboard, arbitrary
paths from a message, or viewer screenshots. Only decoded/re-encoded image
pixels leave this module; temporary originals are removed after acquisition.
"""
import copy
import hashlib
import io
import math
from pathlib import Path
import tempfile
import time
import weakref
from dataclasses import dataclass
from .native_image_surface import NativeRowImageSurface, rectangle, require

MAX_EDGE=4096
MAX_PIXELS=8_000_000
MAX_ENCODED=4*1024*1024

def encode_original(data):
    from PIL import Image, ImageOps
    require(0<len(data)<=32*1024*1024,'IMAGE_VIEWER_FILE_LIMIT')
    with Image.open(io.BytesIO(data)) as source:
        require(source.format in ('PNG','JPEG','BMP','WEBP','GIF'),'IMAGE_VIEWER_FORMAT_UNSUPPORTED')
        require(0<source.width*source.height<=40_000_000,'IMAGE_VIEWER_DECODE_LIMIT')
        source.seek(0)
        image=ImageOps.exif_transpose(source).convert('RGB')
    original=dict(width=image.width,height=image.height)
    scale=min(1,MAX_EDGE/image.width,MAX_EDGE/image.height,math.sqrt(MAX_PIXELS/(image.width*image.height)))
    if scale<1:image=image.resize((max(1,int(image.width*scale)),max(1,int(image.height*scale))),Image.Resampling.LANCZOS)
    output=io.BytesIO();image.save(output,format='PNG')
    encoded=output.getvalue();media_type='image/png'
    if len(encoded)>MAX_ENCODED:
        for quality in (92,85,75):
            output=io.BytesIO();image.save(output,format='JPEG',quality=quality)
            encoded=output.getvalue();media_type='image/jpeg'
            if len(encoded)<=MAX_ENCODED:break
    require(len(encoded)<=MAX_ENCODED,'IMAGE_VIEWER_ENCODE_LIMIT')
    return dict(encoded=encoded,mediaType=media_type,width=image.width,height=image.height,originalSize=original)

class WindowsViewerPort:
    def __init__(self,backend):
        self.backend=backend

    def acquire(self,row,thumb,current):
        backend=self.backend;adapter=backend.adapter;auto=backend.module.auto
        import ctypes
        from ctypes import wintypes as w
        user=ctypes.WinDLL('user32',use_last_error=True)
        user.PostMessageW.argtypes=[w.HWND,w.UINT,w.WPARAM,w.LPARAM]
        user.IsWindow.argtypes=[w.HWND]
        user.SetWindowPos.argtypes=[w.HWND,w.HWND,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_int,w.UINT]
        main=int(adapter.hwnd);pid=backend.module.window_pid(main)
        previews=lambda:[c for c in auto.GetRootControl().GetChildren() if c.ProcessId==pid and c.ClassName=='mmui::PreviewWindow' and not c.IsOffscreen]
        require(not previews(),'IMAGE_VIEWER_ALREADY_OPEN')
        require(current(),'IMAGE_SNAPSHOT_STALE')
        edit=adapter.validate();draft=adapter.input_value(edit)
        box=rectangle(row.native_row);b=thumb['imageBounds']
        viewer=dialog=None
        try:
            row.native_row.DoubleClick(b['x']-box['x']+b['width']//2,b['y']-box['y']+b['height']//2,simulateMove=False,waitTime=.15)
            deadline=time.monotonic()+2
            while time.monotonic()<deadline:
                found=previews()
                if len(found)==1:viewer=found[0];break
                require(len(found)<=1,'IMAGE_VIEWER_AMBIGUOUS')
                time.sleep(.1)
            require(viewer is not None,'IMAGE_VIEWER_OPEN_FAILED')
            hwnd=int(viewer.NativeWindowHandle);viewer_id=tuple(viewer.GetRuntimeId())
            # The chat window may be pinned. Raise only this newly opened viewer;
            # its topmost state disappears when it is closed below.
            require(user.SetWindowPos(hwnd,w.HWND(-1),0,0,0,0,3),'IMAGE_VIEWER_ACTIVATION_FAILED')
            viewer.SetActive(waitTime=.1)
            save=viewer.ButtonControl(Name='保存',searchDepth=7)
            require(save.Exists(.3) and save.IsEnabled,'IMAGE_VIEWER_SAVE_UNAVAILABLE')
            # This common dialog is an owned UIA child of PreviewWindow, not a
            # child of the desktop root. Never search another application's dialog.
            save.Click(simulateMove=False,waitTime=.15)
            candidate=viewer.WindowControl(ClassName='#32770',searchDepth=2)
            deadline=time.monotonic()+2
            while time.monotonic()<deadline:
                if candidate.Exists(.1):dialog=candidate;break
                time.sleep(.1)
            require(dialog is not None and dialog.ProcessId==pid,'IMAGE_VIEWER_SAVE_DIALOG_MISSING')
            filename=dialog.EditControl(AutomationId='1001',searchDepth=8)
            confirm=dialog.ButtonControl(AutomationId='1',searchDepth=2)
            require(filename.Exists(.2) and confirm.Exists(.2),'IMAGE_VIEWER_SAVE_DIALOG_INVALID')
            value=filename.GetValuePattern()
            suffix=Path(value.Value).suffix.lower()
            require(suffix in ('.png','.jpg','.jpeg','.bmp','.webp','.gif'),'IMAGE_VIEWER_FORMAT_UNSUPPORTED')
            with tempfile.TemporaryDirectory(prefix='xq-viewer-') as directory:
                target=Path(directory)/('photo'+suffix)
                require(not target.exists(),'IMAGE_VIEWER_SAVE_TARGET_EXISTS')
                value.SetValue(str(target))
                require(value.Value==str(target),'IMAGE_VIEWER_SAVE_PATH_CHANGED')
                require(tuple(viewer.GetRuntimeId())==viewer_id and int(viewer.NativeWindowHandle)==hwnd,'IMAGE_VIEWER_CHANGED')
                confirm.GetInvokePattern().Invoke()
                deadline=time.monotonic()+4;previous=None;data=None
                while time.monotonic()<deadline:
                    try:
                        stat=target.stat()
                        require(0<stat.st_size<=32*1024*1024,'IMAGE_VIEWER_FILE_LIMIT')
                        signature=(stat.st_size,stat.st_mtime_ns)
                        if signature==previous:
                            data=target.read_bytes();break
                        previous=signature
                    except (FileNotFoundError,PermissionError):pass
                    time.sleep(.15)
                require(data is not None,'IMAGE_VIEWER_SAVE_TIMEOUT')
                require(tuple(viewer.GetRuntimeId())==viewer_id,'IMAGE_VIEWER_CHANGED')
                result=encode_original(data)
            return result
        finally:
            if dialog is not None and dialog.Exists(.1):
                cancel=dialog.ButtonControl(AutomationId='2',searchDepth=2)
                if cancel.Exists(.1):cancel.GetInvokePattern().Invoke()
            if viewer is not None:
                hwnd=int(viewer.NativeWindowHandle)
                require(backend.module.window_pid(hwnd)==pid,'IMAGE_VIEWER_CHANGED')
                user.PostMessageW(hwnd,0x10,0,0)  # Close only the viewer we opened.
                deadline=time.monotonic()+1
                while user.IsWindow(hwnd) and time.monotonic()<deadline:time.sleep(.05)
                require(not user.IsWindow(hwnd),'IMAGE_VIEWER_CLOSE_FAILED')
                adapter.window.SetActive(waitTime=.1)
            fresh=adapter.validate()
            require(adapter.input_value(fresh)==draft,'IMAGE_VIEWER_DRAFT_CHANGED')

@dataclass(frozen=True,eq=False)
class ViewerMeasurement:
    _state: dict
    _base: object
    @property
    def state(self):return copy.deepcopy(self._state)

class NativeViewerImageSurface(NativeRowImageSurface):
    def __init__(self,backend,profile,api=None,viewer=None):
        super().__init__(backend,profile,api)
        self.viewer=viewer if viewer is not None else WindowsViewerPort(backend)
        self._viewer_frames=weakref.WeakKeyDictionary()
        self._viewer_issued=weakref.WeakSet()

    def resolve(self,observation):
        base=super().resolve(observation)
        chat=getattr(base,'_chat',None) or base.chat
        if chat.mode!='private' or base.state.get('mediaKind')!='photo_static_frame':return base
        row=getattr(base,'_row',None) or base.row
        result=self.viewer.acquire(row,base.state,lambda:super(NativeViewerImageSurface,self).current(base))
        require(super().current(base),'IMAGE_VIEWER_CONTEXT_CHANGED')
        state=base.state
        bounds=dict(x=0,y=0,width=result['width'],height=result['height'])
        state.update(imageBounds=bounds,viewportBounds=dict(bounds),sourceKind='wechat_viewer_original',
                     pixelEncoding='encoded-image/v1',mediaType=result['mediaType'],originalSize=result['originalSize'],
                     boundaryMethod='bound-photo-viewer-save/v1',encodedSHA256=hashlib.sha256(result['encoded']).hexdigest())
        proof=ViewerMeasurement(state,base)
        self._viewer_frames[proof]=result['encoded'];self._viewer_issued.add(proof)
        return proof

    def current(self,proof):
        if isinstance(proof,ViewerMeasurement):return proof in self._viewer_issued and super().current(proof._base)
        return super().current(proof)

    def capture(self,proof):
        if not isinstance(proof,ViewerMeasurement):return super().capture(proof)
        require(self.current(proof),'IMAGE_SNAPSHOT_STALE')
        data=self._viewer_frames.pop(proof,None)
        require(data is not None,'IMAGE_CAPTURE_ALREADY_ATTEMPTED')
        return dict(bounds=proof.state['imageBounds'],encoded=data,mediaType=proof.state['mediaType'])
