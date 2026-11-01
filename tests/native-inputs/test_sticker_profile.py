"""Public synthetic regressions; real screenshot replay is a separate private test."""
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'compat/vendor'))
from xiaoqian_driver.native_image_surface import NativeRowImageSurface,SurfaceError
from xiaoqian_driver.image_native import NativeImageBroker
from test_row_image_surface import fixture

class StickerProfile(unittest.TestCase):
    def test_exact_observed_label_and_incoming_geometry_at_supported_dpis(self):
        for dpi in (96,120,144,168,192,240):
            with self.subTest(dpi=dpi):
                f=fixture(dpi);f.row.ClassName='mmui::ChatBubbleReferItemView';f.row.Name='\u52a8\u753b\u8868\u60c5'
                profile={**f.profile,'boundaryMode':'photo-sticker-row/v2','layoutRevision':'incoming-avatar64-content2of3/v2'}
                surface=NativeRowImageSurface(f.surface.backend,profile,f.api)
                proof=surface.measure(f.chat,f.message);result=surface.capture(proof)
                self.assertEqual(f.photo.tobytes(),result['rgba']);self.assertFalse(proof.state['animationFramesAnalyzed'])
                self.assertEqual('animated_sticker_static_frame',proof.state['mediaKind'])
    def test_new_profile_routes_to_row_surface_not_imaginary_image_control(self):
        chat=types.SimpleNamespace(key='synthetic',name='SYNTHETIC',mode='private');adapter=types.SimpleNamespace()
        profile={'verified':True,'evidenceId':'SYNTHETIC','boundaryMode':'photo-sticker-row/v2'}
        backend=types.SimpleNamespace(_load=lambda _:adapter,_native_image_profile=profile,module=types.SimpleNamespace())
        sentinel=object()
        with patch('xiaoqian_driver.native_image_surface.NativeRowImageSurface',return_value=sentinel) as ctor:
            broker=NativeImageBroker(backend,1,mode='real');broker.before_read(chat)
            ctor.assert_called_once_with(backend,{**profile,'groupChatKeys':[]});self.assertNotIn('groupChatKeys',profile);self.assertIs(sentinel,broker.surface);self.assertTrue(adapter.native_image_enabled)
    def test_label_only_does_not_override_unaccepted_classes_or_layout(self):
        f=fixture();profile={**f.profile,'boundaryMode':'photo-sticker-row/v2','layoutRevision':'incoming-avatar64-content2of3/v2'}
        for klass in ('mmui::ChatVideoItemView','mmui::ChatTextItemView','mmui::ChatBubbleItemView'):
            f.row.ClassName=klass;f.row.Name='\u52a8\u753b\u8868\u60c5'
            with self.assertRaisesRegex(SurfaceError,'ROW_BOUNDARY_UNVERIFIED'):NativeRowImageSurface(f.surface.backend,profile,f.api).measure(f.chat,f.message)
        with self.assertRaisesRegex(SurfaceError,'ROW_PROFILE_REQUIRED'):NativeRowImageSurface(f.surface.backend,{**profile,'layoutRevision':'guessed'},f.api)
if __name__=='__main__':unittest.main(verbosity=2)
