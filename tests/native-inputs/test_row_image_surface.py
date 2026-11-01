import hashlib
from pathlib import Path
import sys
import types
import unittest
from PIL import Image, ImageDraw

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'compat/vendor'))
from xiaoqian_driver.native_image_surface import NativeRowImageSurface, SurfaceError
from xiaoqian_driver.row_image_geometry import pure_photo_row, search_bounds
from test_native_image_surface import Control


def fixture(dpi=96, offset=(-400,100), zoom=1.0):
    scale=dpi/96; s=lambda n:round(n*scale)
    x,y=offset
    width,height=s(640),s(200)
    window=Control(1,'WindowControl',box=(x-20,y-80,x+width+20,y+height+100));window.NativeWindowHandle=99
    listing=Control(2,'ListControl',box=(x,y-20,x+width,y+height+40),parent=window)
    listing.Exists=lambda _:True;window.ListControl=lambda **_:listing
    row=Control(3,'ListItemControl','mmui::ChatImageItemView',box=(x,y,x+width,y+height),name='[图片]',parent=listing)
    canvas=Image.new('RGBA',(width,height),(245,245,245,255));draw=ImageDraw.Draw(canvas)
    zs=lambda n:round(n*scale*zoom)
    draw.rectangle((zs(20),zs(10),zs(56)-1,zs(46)-1),fill=(255,0,0,255)) # private avatar, must never be captured
    size=zs(128)
    photo=Image.new('RGBA',(size,size))
    photo.putdata([((px*17+py*7)%230,(px*3+py*19)%230,(px*13+py*11)%230,255) for py in range(size) for px in range(size)])
    px,py=zs(72),zs(12)
    canvas.paste(photo,(px,py))
    chat=types.SimpleNamespace(name='SYNTHETIC OWNER',key='synthetic-owner',mode='private')
    message=types.SimpleNamespace(native_row=row,role='user',native_image_available=True,image=None)
    adapter=types.SimpleNamespace(window=window,hwnd=99,target=chat.name,mode=chat.mode,draft='UNCHANGED SYNTHETIC DRAFT')
    adapter.validate=lambda:'edit';adapter.input_value=lambda edit:adapter.draft
    backend=types.SimpleNamespace(adapter=adapter,module=types.SimpleNamespace(KEEP_FRONT=False),chat=chat)
    class API:
        def __init__(self):self.dpi=dpi;self.clear=True;self.foreground=99;self.calls=[];self.after=None;self.mutate_crop=False
        def window_pid(self,hwnd):return 7
        def window_dpi(self,hwnd):return self.dpi
        def foreground_window(self):return self.foreground
        def occlusion_free(self,*args):return self.clear
        def capture_rgba(self,b):
            self.calls.append(dict(b))
            im=canvas.crop((b['x']-x,b['y']-y,b['x']-x+b['width'],b['y']-y+b['height']))
            raw=im.tobytes();im.close()
            if self.after:self.after()
            if self.mutate_crop and len(self.calls)>1:raw=bytes([raw[0]^1])+raw[1:]
            return raw
    api=API();profile={'verified':True,'evidenceId':'SYNTHETIC LAYOUT ONLY','boundaryMode':'pure-photo-row/v1',
        'layoutRevision':'incoming-avatar64/v1','ownerChatKey':chat.key}
    surface=NativeRowImageSurface(backend,profile,api)
    return types.SimpleNamespace(canvas=canvas,photo=photo,draw=draw,row=row,listing=listing,window=window,chat=chat,message=message,
        adapter=adapter,api=api,profile=profile,surface=surface,x=x,y=y,px=px,py=py,size=size)


class Tests(unittest.TestCase):
    def test_supported_dpi_and_negative_monitor_origin_exact_photo_only(self):
        for dpi in (96,120,144,168,192,240):
            with self.subTest(dpi=dpi):
                f=fixture(dpi);observation=f.surface.observe(f.chat,f.message);self.assertEqual([],f.api.calls)
                with self.assertRaisesRegex(SurfaceError,'NOT_MEASURED'):f.surface.capture(observation)
                proof=f.surface.resolve(observation)
                with self.assertRaisesRegex(SurfaceError,'ALREADY_ATTEMPTED'):f.surface.resolve(observation)
                result=f.surface.capture(proof)
                self.assertEqual(f.photo.tobytes(),result['rgba'])
                self.assertEqual({'x':f.x+f.px,'y':f.y+f.py,'width':f.size,'height':f.size},result['bounds'])
                self.assertEqual(result['bounds'],f.api.calls[-1]);self.assertGreater(f.api.calls[0]['x'],f.x+round(56*dpi/96))
                self.assertNotIn('rgba',proof.state);self.assertTrue(f.surface.current(proof))
                self.assertEqual('UNCHANGED SYNTHETIC DRAFT',f.adapter.draft)
    def test_unaccepted_native_classes_have_unverified_boundary_before_pixels(self):
        for klass in ('mmui::ChatBubbleReferItemView','mmui::ChatBubbleItemView','mmui::ChatVideoItemView','mmui::ChatEmojiItemView','mmui::ChatTextItemView'):
            f=fixture();f.row.ClassName=klass
            with self.assertRaisesRegex(SurfaceError,'ROW_BOUNDARY_UNVERIFIED'):f.surface.measure(f.chat,f.message)
            self.assertEqual([],f.api.calls)
    def test_native_label_mixed_text_quote_filename_and_video_reject_before_pixels(self):
        for name in ('[图片]\nquote text','hello','document.pdf\n12 KB','[Video]','[表情]','Photo additional text',''):
            f=fixture();f.row.Name=name
            with self.assertRaisesRegex(SurfaceError,'PURE_NATIVE_LABEL_REQUIRED'):f.surface.measure(f.chat,f.message)
            self.assertEqual([],f.api.calls)
    def test_foreign_owner_group_and_outgoing_reject_before_pixels(self):
        for change in (lambda f:setattr(f.chat,'key','foreign'),lambda f:setattr(f.chat,'mode','group'),lambda f:setattr(f.message,'role','assistant')):
            f=fixture();change(f)
            with self.assertRaises(SurfaceError):f.surface.measure(f.chat,f.message)
            self.assertEqual([],f.api.calls)
    def test_row_clipped_at_any_viewport_edge_rejects(self):
        for edge in ('left','right','top','bottom'):
            f=fixture();box=f.listing.BoundingRectangle
            setattr(box,edge,getattr(f.row.BoundingRectangle,edge)+(1 if edge in ('left','top') else -1))
            with self.assertRaisesRegex(SurfaceError,'ROW_CLIPPED'):f.surface.measure(f.chat,f.message)
            self.assertEqual([],f.api.calls)
    def test_dpi_window_position_row_identity_and_draft_changes_invalidate(self):
        changes=(lambda f:setattr(f.api,'dpi',120),lambda f:setattr(f.window.BoundingRectangle,'left',f.x-30),
            lambda f:setattr(f.row,'rid',999),lambda f:setattr(f.adapter,'draft','new user draft'),lambda f:setattr(f.api,'foreground',111))
        for change in changes:
            f=fixture();proof=f.surface.measure(f.chat,f.message);change(f)
            self.assertFalse(f.surface.current(proof))
            with self.assertRaisesRegex(SurfaceError,'SNAPSHOT_STALE'):f.surface.capture(proof)
            self.assertEqual(1,len(f.api.calls))
    def test_occlusion_before_and_during_measurement_reject(self):
        f=fixture();f.api.clear=False
        with self.assertRaisesRegex(SurfaceError,'OCCLUDED'):f.surface.measure(f.chat,f.message)
        self.assertEqual([],f.api.calls)
        f=fixture();f.api.after=lambda:setattr(f.api,'clear',False)
        with self.assertRaises(SurfaceError):f.surface.measure(f.chat,f.message)
        f=fixture();observation=f.surface.observe(f.chat,f.message)
        def broken(_):raise RuntimeError('SYNTHETIC PRIVATE ERROR MUST NOT ESCAPE')
        f.api.capture_rgba=broken
        with self.assertRaisesRegex(SurfaceError,'MEASUREMENT_CAPTURE_UNKNOWN'):f.surface.resolve(observation)
        with self.assertRaisesRegex(SurfaceError,'ALREADY_ATTEMPTED'):f.surface.resolve(observation)
    def test_resolution_or_native_dpi_unknown_rejects(self):
        for dpi in (0,95,241,120.5):
            with self.assertRaisesRegex(ValueError,'DPI_UNSUPPORTED'):search_bounds({'x':0,'y':0,'width':640,'height':200},{'x':0,'y':0,'width':640,'height':200},dpi)
        f=fixture();f.row.BoundingRectangle.right=f.x+2049
        with self.assertRaises(SurfaceError):f.surface.measure(f.chat,f.message)
    def test_inconsistent_client_zoom_fails_without_avatar_or_partial_image_leak(self):
        for zoom in (.6,1.5):
            f=fixture(120,zoom=zoom)
            with self.assertRaises(SurfaceError):f.surface.measure(f.chat,f.message)
    def test_loading_flat_background_and_sparse_text_reject(self):
        for kind in ('empty','loading','text'):
            f=fixture();f.canvas.paste((245,245,245,255),(64,0,f.canvas.width,f.canvas.height))
            if kind=='loading':f.draw.rectangle((72,12,199,139),fill=(160,160,160,255))
            if kind=='text':f.draw.text((72,12),'PRIVATE QUOTED TEXT',fill=(0,0,0,255))
            with self.assertRaises(SurfaceError):f.surface.measure(f.chat,f.message)
    def test_separate_caption_or_second_image_rejects(self):
        for box in ((72,160,199,180),(240,12,310,139)):
            f=fixture();f.draw.rectangle(box,fill=(20,100,180,255))
            with self.assertRaises(SurfaceError):f.surface.measure(f.chat,f.message)
    def test_exact_capture_must_match_measured_image_pixels(self):
        f=fixture();proof=f.surface.measure(f.chat,f.message);f.api.mutate_crop=True
        with self.assertRaisesRegex(SurfaceError,'CONTENT_CHANGED'):f.surface.capture(proof)
    def test_capability_is_owned_and_cannot_be_cloned(self):
        import copy
        f=fixture();proof=f.surface.measure(f.chat,f.message)
        self.assertFalse(f.surface.current(copy.copy(proof)))
        calls=len(f.api.calls)
        with self.assertRaises(SurfaceError):f.surface.capture(copy.copy(proof))
        self.assertEqual(calls,len(f.api.calls))
    def test_synthetic_refer_class_does_not_claim_actual_cat_boundary_acceptance(self):
        f=fixture();f.row.ClassName='mmui::ChatBubbleReferItemView'
        with self.assertRaisesRegex(SurfaceError,'ROW_BOUNDARY_UNVERIFIED'):f.surface.measure(f.chat,f.message)
        self.assertEqual([],f.api.calls)


if __name__=='__main__':unittest.main(verbosity=2)
