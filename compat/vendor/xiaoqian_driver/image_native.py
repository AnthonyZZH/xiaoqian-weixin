"""Worker-owned short-lived image capabilities. No network, files or document opens."""
import base64,json,re,secrets,time,uuid
from types import SimpleNamespace
from .protocol import DriverError
from .snapshot_identity import token

COMMANDS=('image_inspect','image_capture','image_current')
MAX_RGBA=512*512*4
class ImageError(DriverError):pass
def require(ok,code):
    if not ok:raise ImageError(code)

def register_native_image_profile(backend,profile):
    """Trusted Python startup API, never dispatched from JSON/model arguments."""
    require(isinstance(profile,dict) and profile.get('verified') is True and profile.get('evidenceId'),'IMAGE_NATIVE_PROFILE_REQUIRED')
    backend._native_image_profile=dict(profile)

class SyntheticSurface:
    """Only instantiated for mode=fake; caller JSON cannot activate this in real mode."""
    def __init__(self,fixture):self.fixture=fixture;self.serial=0
    def measure(self,chat,row):
        bounds=dict(self.fixture.get('bounds',{'x':10,'y':20,'width':2,'height':2}))
        return SimpleNamespace(state={'imageBounds':bounds,'viewportBounds':dict(bounds),'window':{'hwnd':1,'pid':1,'runtimeId':[1]},'rowRuntimeId':[2],'imageRuntimeId':[3],'draftHash':'SYNTHETIC'})
    def current(self,proof):return not self.fixture.get('stale',False)
    def capture(self,proof):
        if self.fixture.get('captureError'):raise ImageError('IMAGE_SYNTHETIC_CAPTURE_ERROR')
        b=proof.state['imageBounds'];n=b['width']*b['height']*4
        require(0<n<=MAX_RGBA,'IMAGE_FRAME_LIMIT')
        self.serial+=1
        return {'bounds':dict(b),'rgba':bytes(self.fixture.get('pixel',[0,255,0,255]))*(n//4)}

class NativeImageBroker:
    def __init__(self,backend,generation,*,mode,fixture=None,surface=None,clock=time.monotonic,wall=time.time,ttl=8):
        require(type(generation) is int and generation>0,'IMAGE_GENERATION_REQUIRED')
        require(0<ttl<=15,'IMAGE_TTL_INVALID')
        self.backend,self.generation,self.mode=backend,generation,mode
        self.clock,self.wall,self.ttl=clock,wall,ttl
        self.surface=surface if surface is not None else SyntheticSurface(fixture) if mode=='fake' and fixture else None
        self.entries={};self.read_id=None;self.chat_key=None;self.rows={};self.errors={}
    def before_read(self,chat):
        # _load only binds existing adapter objects; it never focuses/selects a chat.
        if self.mode=='real':
            adapter=self.backend._load(chat)
            profile=getattr(self.backend,'_native_image_profile',None)
            if profile is None:profile=getattr(self.backend.module,'NATIVE_IMAGE_PROFILE',None)
            if profile is not None and self.surface is None:
                from .native_image_surface import NativeUIASurface,NativeRowImageSurface
                surface_type=NativeRowImageSurface if profile.get('boundaryMode') in ('pure-photo-row/v1','photo-sticker-row/v2') else NativeUIASurface
                self.surface=surface_type(self.backend,profile)
            adapter.native_image_enabled=self.surface is not None
    def begin_read(self,chat,rows):
        self.entries={};self.errors={};self.rows={r['key']:dict(r) for r in rows}
        self.read_id=uuid.uuid4().hex;self.chat_key=chat.key
        issued=self.clock();expires_ms=int((self.wall()+self.ttl)*1000)
        for raw in rows:
            if raw.get('role')!='user' or raw.get('image_available') is not True:continue
            if self.surface is None:self.errors[raw['key']]='IMAGE_NATIVE_PROFILE_REQUIRED';continue
            try:
                native=getattr(self.backend,'rows',{}).get(raw['key'])
                if native is None and self.mode=='fake':native=SimpleNamespace(native_image_available=True,image=None)
                deferred=callable(getattr(self.surface,'observe',None)) and callable(getattr(self.surface,'resolve',None))
                proof=self.surface.observe(chat,native) if deferred else self.surface.measure(chat,native)
                if not deferred:self._bounds(proof)
                capability=secrets.token_urlsafe(32)
                self.entries[raw['key']]={'ticket':capability,'proof':proof,'fingerprint':token(raw),'issued':issued,
                    'expiresAt':expires_ms,'state':'ready','canonical':None,'deferred':deferred}
            except Exception as error:
                code=getattr(error,'code',None) or str(error)
                self.errors[raw['key']]=code if re.fullmatch(r'[A-Z0-9_]{1,100}',code or '') else 'IMAGE_SURFACE_UNAVAILABLE'
        return {'schema':'xq.native-image-read/v1','readId':self.read_id,'generation':self.generation}
    @staticmethod
    def _bounds(proof):
        b=proof.state['imageBounds'];v=proof.state['viewportBounds']
        require(b==v and all(type(b[k]) is int for k in ('x','y','width','height')),'IMAGE_BOUNDS_INVALID')
        require(0<b['width']<=512 and 0<b['height']<=512 and b['width']*b['height']*4<=MAX_RGBA,'IMAGE_FRAME_LIMIT')
    def _entry(self,chat,args):
        handle=args.get('handle',{});raw_key=handle.get('sourceKey')
        require(chat.key==self.chat_key and handle.get('chatKey')==chat.key,'IMAGE_CHAT_CHANGED')
        require(args.get('generation')==self.generation and handle.get('generation')==self.generation,'IMAGE_GENERATION_STALE')
        require(args.get('readId')==self.read_id,'IMAGE_READ_STALE')
        raw=self.rows.get(raw_key)
        require(raw and raw.get('role')=='user' and raw.get('image_available') is True and token(raw)==handle.get('token'),'IMAGE_ROW_STALE')
        require(re.fullmatch(r'[a-f0-9]{64}',handle.get('messageId','')),'IMAGE_CANONICAL_REQUIRED')
        entry=self.entries.get(raw_key)
        if entry is None:raise ImageError(self.errors.get(raw_key,'IMAGE_CONTROL_UNAVAILABLE'))
        require(self.clock()-entry['issued']<self.ttl,'IMAGE_CAPABILITY_EXPIRED')
        require(entry['canonical'] in (None,handle['messageId']),'IMAGE_CANONICAL_CHANGED')
        require(entry['state']!='unknown','IMAGE_CAPTURE_UNKNOWN')
        require(self.surface.current(entry['proof']) is True,'IMAGE_SNAPSHOT_STALE')
        if entry['canonical'] is None:entry['canonical']=handle['messageId']
        return entry,raw_key
    def dispatch(self,chat,command,args):
        require(command in COMMANDS,'IMAGE_COMMAND_DENIED')
        entry,raw_key=self._entry(chat,args)
        if command!='image_inspect':require(args.get('ticket')==entry['ticket'],'IMAGE_CAPABILITY_INVALID')
        if entry.get('deferred'):
            require(command=='image_inspect','IMAGE_INSPECT_REQUIRED')
            entry['state']='unknown'
            try:
                proof=self.surface.resolve(entry['proof']);self._bounds(proof)
                require(self.clock()-entry['issued']<self.ttl,'IMAGE_CAPABILITY_EXPIRED')
                entry.update(proof=proof,deferred=False,state='ready')
            except Exception as error:
                code=getattr(error,'code',None)
                raise ImageError(code if isinstance(code,str) and re.fullmatch(r'[A-Z0-9_]{1,100}',code) else 'IMAGE_MEASUREMENT_CAPTURE_UNKNOWN') from None
        state=entry['proof'].state
        data={'schema':'xq.native-image/v1','ticket':entry['ticket'],'readId':self.read_id,'generation':self.generation,
              'sourceKey':raw_key,'messageId':entry['canonical'],'expiresAt':entry['expiresAt'],
              'imageBounds':dict(state['imageBounds']),'viewportBounds':dict(state['viewportBounds'])}
        if command=='image_inspect':return data
        if command=='image_current':return dict(data,current=True)
        require(entry['state']=='ready','IMAGE_CAPTURE_ALREADY_ATTEMPTED')
        entry['state']='unknown' # Reserve before any screenshot. Unknown is never retried.
        try:
            frame=self.surface.capture(entry['proof'])
            raw=frame.get('rgba');bounds=frame.get('bounds')
            require(bounds==data['imageBounds'] and isinstance(raw,bytes) and len(raw)==bounds['width']*bounds['height']*4 and len(raw)<=MAX_RGBA,'IMAGE_FRAME_INVALID')
            require(self.clock()-entry['issued']<self.ttl and self.surface.current(entry['proof']) is True,'IMAGE_SNAPSHOT_STALE')
            entry['state']='captured'
            return dict(data,rgba=base64.b64encode(raw).decode('ascii'))
        except ImageError:raise
        except Exception:raise ImageError('IMAGE_CAPTURE_UNKNOWN') from None
