import sys,types,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'compat/vendor'))
from xiaoqian_driver.native_image_surface import NativeRowImageSurface,SurfaceError
from test_row_image_surface import fixture
from test_native_image_surface import Control

def group_fixture(dpi=120,sticker=False):
 f=fixture(dpi,offset=(100,100));scale=dpi/96;s=lambda n:round(n*scale)
 f.canvas.paste((245,245,245,255),(s(64),0,f.canvas.width,f.canvas.height))
 f.draw.text((s(72),s(8)),'SYNTHETIC USER',fill=(10,10,10,255))
 f.py=s(50);f.px=s(72);f.canvas.paste(f.photo,(f.px,f.py))
 f.chat.mode='group';f.chat.key='synthetic-group';f.adapter.mode='group';f.message.sender='SYNTHETIC USER'
 f.header=Control(4,'TextControl',name=f.message.sender,parent=f.row,box=(f.x+s(72),f.y+s(6),f.x+s(200),f.y+s(26)))
 f.profile.update(groupChatKeys=['synthetic-group'],allowReferPhotos=True,boundaryMode='photo-sticker-row/v2',layoutRevision='incoming-avatar64-content2of3/v2')
 f.row.ClassName='mmui::ChatBubbleReferItemView';f.row.Name='动画表情' if sticker else '图片'
 f.surface=NativeRowImageSurface(f.surface.backend,f.profile,f.api)
 return f
class GroupSurfaceTests(unittest.TestCase):
 def test_selected_group_uses_exact_photo_without_avatar_or_sender_header(self):
  for dpi in (96,120,144):
   f=group_fixture(dpi);proof=f.surface.measure(f.chat,f.message);result=f.surface.capture(proof)
   self.assertEqual(result['rgba'],f.photo.tobytes());self.assertEqual(result['bounds'],dict(x=f.x+f.px,y=f.y+f.py,width=f.size,height=f.size));self.assertGreater(f.api.calls[0]['y'],f.header.BoundingRectangle.bottom)
 def test_unrouted_read_observation_does_not_walk_sender_header_or_capture(self):
  f=group_fixture();calls=[];original=f.row.GetChildren;f.row.GetChildren=lambda:(calls.append(True) or original())
  observation=f.surface.observe(f.chat,f.message);self.assertTrue(f.surface.current(observation));self.assertEqual(calls,[]);self.assertEqual(f.api.calls,[])
  f.surface.resolve(observation);self.assertTrue(calls);self.assertEqual(len(f.api.calls),1)
 def test_unconfigured_group_has_no_pixels(self):
  f=group_fixture();f.chat.key='another-group'
  with self.assertRaises(SurfaceError):f.surface.measure(f.chat,f.message)
  self.assertEqual(f.api.calls,[])
 def test_missing_or_duplicate_native_sender_header_has_no_pixels(self):
  for kind in ('missing','duplicate'):
   f=group_fixture()
   if kind=='missing':f.message.sender='OTHER'
   else:Control(5,'TextControl',name=f.message.sender,parent=f.row,box=(f.x+90,f.y+7,f.x+220,f.y+25))
   with self.assertRaises(SurfaceError):f.surface.measure(f.chat,f.message)
   self.assertEqual(f.api.calls,[])
 def test_header_change_invalidates_measured_image(self):
  f=group_fixture();proof=f.surface.measure(f.chat,f.message);f.header.Name='CHANGED';self.assertFalse(f.surface.current(proof))
  with self.assertRaises(SurfaceError):f.surface.capture(proof)
 def test_mixed_label_or_caption_not_externally_available(self):
  f=group_fixture();f.row.Name='图片\nquoted text'
  with self.assertRaises(SurfaceError):f.surface.measure(f.chat,f.message)
  self.assertEqual(f.api.calls,[])
  f=group_fixture();f.draw.rectangle((90,225,200,235),fill=(2,10,20,255))
  with self.assertRaises(SurfaceError):f.surface.measure(f.chat,f.message)
 def test_group_sticker_is_single_static_frame_and_consumed_once(self):
  f=group_fixture(sticker=True);proof=f.surface.measure(f.chat,f.message);count=len(f.api.calls);first=f.surface.capture(proof)
  self.assertEqual(first['rgba'],f.photo.tobytes());self.assertEqual(len(f.api.calls),count);self.assertFalse(proof.state['animationFramesAnalyzed'])
  with self.assertRaises(SurfaceError):f.surface.capture(proof)
if __name__=='__main__':unittest.main()
