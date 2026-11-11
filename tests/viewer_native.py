"""Original-image acquisition contracts; no desktop operations."""
import base64,io,unittest
from unittest.mock import patch
from attachment_native import surface
from xiaoqian_driver.viewer_image import NativeViewerImageSurface,encode_original
from xiaoqian_driver.image_native import NativeImageBroker,ImageError
from xiaoqian_driver.snapshot_identity import token
from PIL import Image

def png(size):
    out=io.BytesIO();Image.new('RGB',size,(210,220,230)).save(out,format='PNG');return out.getvalue()

class Viewer:
    def __init__(self,backend):self.calls=0;self.backend=backend;self.fail=False;self.change=False
    def acquire(self,row,thumb,current):
        assert current();self.calls+=1
        if self.fail:raise ImageError('IMAGE_VIEWER_SAVE_TIMEOUT')
        if self.change:self.backend.adapter.draft='changed'
        return encode_original(png((900,1800)))

class ViewerImages(unittest.TestCase):
    def fixture(self,kind='photo'):
        base,backend,chat,row,api=surface(kind);viewer=Viewer(backend)
        s=NativeViewerImageSurface(backend,base.profile,api,viewer)
        return s,backend,chat,row,api,viewer

    def test_broker_delivers_original_dimensions_and_captures_only_once(self):
        s,backend,chat,row,api,viewer=self.fixture()
        broker=NativeImageBroker(backend,1,mode='real');broker.surface=s
        raw=dict(key='raw',role='user',text='SYNTHETIC',image_available=True)
        read=broker.begin_read(chat,[raw]);self.assertEqual(viewer.calls,0)
        args=dict(readId=read['readId'],generation=1,handle=dict(chatKey=chat.key,sourceKey='raw',token=token(raw),messageId='a'*64,generation=1))
        proof=broker.dispatch(chat,'image_inspect',args);args['ticket']=proof['ticket']
        self.assertEqual(proof['imageBounds']['height'],1800)
        self.assertEqual(proof['sourceKind'],'wechat_viewer_original')
        result=broker.dispatch(chat,'image_capture',args)
        with Image.open(io.BytesIO(base64.b64decode(result['encoded']))) as im:self.assertEqual(im.size,(900,1800))
        self.assertEqual(viewer.calls,1);self.assertEqual(len(api.captures),1)
        with self.assertRaisesRegex(ImageError,'ALREADY_ATTEMPTED'):broker.dispatch(chat,'image_capture',args)

    def test_real_profile_enables_viewer_acquisition_by_default(self):
        base,backend,chat,_,api=surface('photo')
        backend._load=lambda chat:backend.adapter
        backend.module.NATIVE_IMAGE_PROFILE=base.profile
        with patch('xiaoqian_driver.native_image_surface.WindowsNativeAPI',return_value=api):
            broker=NativeImageBroker(backend,1,mode='real');broker.before_read(chat)
        self.assertIsInstance(broker.surface,NativeViewerImageSurface)
        self.assertTrue(backend.adapter.native_image_enabled)

    def test_failed_viewer_does_not_fall_back_to_thumbnail(self):
        s,_,chat,row,_,viewer=self.fixture();viewer.fail=True
        with self.assertRaisesRegex(ImageError,'VIEWER_SAVE_TIMEOUT'):s.resolve(s.observe(chat,row))

    def test_changed_chat_context_refuses_saved_image(self):
        s,_,chat,row,_,viewer=self.fixture();viewer.change=True
        with self.assertRaisesRegex((ImageError,ValueError),'CONTEXT_CHANGED'):s.resolve(s.observe(chat,row))

    def test_sticker_keeps_static_frame_without_opening_photo_viewer(self):
        s,_,chat,row,_,viewer=self.fixture('sticker')
        proof=s.resolve(s.observe(chat,row));self.assertIn('rgba',s.capture(proof));self.assertEqual(viewer.calls,0)

    def test_large_original_has_bounded_delivered_dimensions_without_upscaling(self):
        result=encode_original(png((1000,6000)))
        self.assertEqual(result['originalSize'],dict(width=1000,height=6000))
        self.assertEqual(result['height'],4096);self.assertLessEqual(result['width']*result['height'],8_000_000)
        self.assertEqual(encode_original(png((20,40)))['height'],40)

if __name__=='__main__':unittest.main()
