"""Synthetic native contracts: no WeChat, network, model, or production state."""
import base64
import hashlib
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP / 'vendor'))
from xiaoqian_driver.protocol import Chat, DriverError
from xiaoqian_driver.image_native import NativeImageBroker, ImageError
from xiaoqian_driver.native_image_surface import NativeUIASurface, NativeRowImageSurface, rectangle
from xiaoqian_driver.row_image_geometry import tight_photo
from xiaoqian_driver.native_saved_file_location import normalize_location
from xiaoqian_driver.saved_file_identity import WindowsFile, read_saved, Rejected
from xiaoqian_driver.snapshot_identity import token


class Control:
    def __init__(self, rid, bounds, parent=None, name='', klass=''):
        self.rid, self.parent = rid, parent
        self.Name, self.ClassName = name, klass
        self.IsOffscreen = False
        x, y, w, h = bounds
        self.BoundingRectangle = NS(left=x, top=y, right=x+w, bottom=y+h)
    def GetRuntimeId(self): return [self.rid]
    def GetParentControl(self): return self.parent
    def Exists(self, timeout): return True


class API:
    def __init__(self, image):
        self.image, self.captures, self.clear = image, [], True
        self.sparse = False
    def window_pid(self, hwnd): return 7
    def foreground_window(self): return 1
    def window_dpi(self, hwnd): return 96
    def candidates(self, row, selector): return [self.image]
    def occlusion_free(self, *args): return self.clear
    def capture_rgba(self, b):
        self.captures.append(dict(b))
        pixels = bytearray()
        for y in range(b['y'], b['y']+b['height']):
            for x in range(b['x'], b['x']+b['width']):
                content = (74 <= x < 106 and 30 <= y < 62 and
                           (not self.sparse or 84 <= x < 96 or 40 <= y < 52))
                pixels.extend((x*19 % 200, y*13 % 200, (x+y)*7 % 200, 255)
                              if content else (240, 240, 240, 255))
        return bytes(pixels)


def surface(kind):
    chat = Chat('SYNTHETIC OWNER')
    window = Control(1, (0, 0, 500, 300))
    listing = Control(2, (0, 0, 500, 200), window)
    window.ListControl = lambda **kw: listing
    native = Control(3, (0, 20, 300, 64), listing, '图片', 'mmui::ChatImageItemView')
    image = Control(4, (74, 30, 32, 32), native, klass='ContentPhoto')
    image.ControlTypeName = 'ImageControl'
    adapter = NS(target=chat.name, mode=chat.mode, hwnd=1, window=window, draft='')
    adapter.validate = lambda: adapter
    adapter.input_value = lambda edit: adapter.draft
    row = NS(native_row=native, native_image_available=True, role='user')
    backend = NS(chat=chat, adapter=adapter, module=NS(KEEP_FRONT=False), rows={'raw': row})
    profile = dict(verified=True, evidenceId='SYNTHETIC', ownerChatKey=chat.key)
    if kind == 'control':
        profile['contentImage'] = dict(ControlTypeName='ImageControl', ClassName='ContentPhoto')
        cls = NativeUIASurface
    else:
        profile.update(boundaryMode='photo-sticker-row/v2' if kind == 'sticker' else 'pure-photo-row/v1',
                       layoutRevision='incoming-avatar64-content2of3/v2' if kind == 'sticker' else 'incoming-avatar64/v1')
        cls = NativeRowImageSurface
        if kind == 'sticker': native.Name, native.ClassName = '动画表情', 'mmui::ChatBubbleReferItemView'
    api = API(image)
    return cls(backend, profile, api), backend, chat, row, api


class NativeImages(unittest.TestCase):
    def test_sparse_owner_photo_is_delivered_but_sparse_sticker_is_refused(self):
        photo, _, chat, row, api = surface('photo')
        api.sparse = True
        proof = photo.resolve(photo.observe(chat, row))
        self.assertEqual(photo.capture(proof)['bounds'], rectangle(api.image))
        sticker, _, chat, row, api = surface('sticker')
        api.sparse = True
        with self.assertRaisesRegex((DriverError, ValueError), 'IMAGE_CONTENT_SPARSE_OR_MIXED'):
            sticker.resolve(sticker.observe(chat, row))

    def test_sparse_photo_mode_keeps_edge_and_loading_checks(self):
        bounds = dict(x=0, y=0, width=40, height=40)
        pixels = bytearray((240, 240, 240, 255))*1600
        with self.assertRaisesRegex((DriverError, ValueError), 'IMAGE_EMPTY_OR_LOADING'):
            tight_photo(bounds, bytes(pixels), 96, verified_owner_photo=True)
        pixels[:4] = (40, 40, 40, 255)
        with self.assertRaisesRegex((DriverError, ValueError), 'IMAGE_CONTENT_TOUCHES_GUARD'):
            tight_photo(bounds, bytes(pixels), 96, verified_owner_photo=True)

    def test_exact_crop_and_sticker_single_frame(self):
        for kind in ('control', 'photo', 'sticker'):
            with self.subTest(kind=kind):
                s, backend, chat, row, api = surface(kind)
                broker = NativeImageBroker(backend, 1, mode='real')
                broker.surface = s
                raw = dict(key='raw', role='user', text='SYNTHETIC', image_available=True)
                receipt = broker.begin_read(chat, [raw])
                args = dict(readId=receipt['readId'], generation=1, handle=dict(chatKey=chat.key,
                            sourceKey='raw', token=token(raw), messageId='a'*64, generation=1))
                self.assertEqual(api.captures, [])
                inspected = broker.dispatch(chat, 'image_inspect', args)
                args['ticket'] = inspected['ticket']
                captured = broker.dispatch(chat, 'image_capture', args)
                self.assertEqual(captured['imageBounds'], rectangle(api.image))
                self.assertEqual(len(base64.b64decode(captured['rgba'])), 32*32*4)
                self.assertEqual(len(api.captures), 2 if kind == 'photo' else 1)
                with self.assertRaisesRegex(ImageError, 'ALREADY_ATTEMPTED'):
                    broker.dispatch(chat, 'image_capture', args)
                backend.adapter.draft = 'changed'
                with self.assertRaisesRegex(ImageError, 'SNAPSHOT_STALE'):
                    broker.dispatch(chat, 'image_current', args)

    def test_stale_context_and_occlusion(self):
        for kind in ('control', 'photo', 'sticker'):
            s, backend, chat, row, api = surface(kind)
            proof = s.resolve(s.observe(chat, row))
            api.clear = False
            self.assertFalse(s.current(proof))
            with self.assertRaisesRegex(ImageError, 'SNAPSHOT_STALE'): s.capture(proof)

    def test_group_refused(self):
        s, backend, chat, row, api = surface('photo')
        with self.assertRaisesRegex(ImageError, 'OWNER_PRIVATE_INCOMING_REQUIRED'):
            s.observe(Chat('SYNTHETIC GROUP', 'group'), row)
        self.assertEqual(api.captures, [])

    def test_unknown_measurement_is_not_retried(self):
        s, backend, chat, row, api = surface('photo')
        broker = NativeImageBroker(backend, 1, mode='real')
        broker.surface = s
        raw = dict(key='raw', role='user', text='SYNTHETIC', image_available=True)
        receipt = broker.begin_read(chat, [raw])
        args = dict(readId=receipt['readId'], generation=1, handle=dict(chatKey=chat.key,
                    sourceKey='raw', token=token(raw), messageId='a'*64, generation=1))
        calls = []
        def fail(bounds):
            calls.append(bounds)
            raise RuntimeError('SYNTHETIC')
        api.capture_rgba = fail
        with self.assertRaisesRegex(ImageError, 'MEASUREMENT_CAPTURE_UNKNOWN'):
            broker.dispatch(chat, 'image_inspect', args)
        with self.assertRaisesRegex(ImageError, 'CAPTURE_UNKNOWN'):
            broker.dispatch(chat, 'image_inspect', args)
        self.assertEqual(len(calls), 1)


@unittest.skipUnless(os.name == 'nt', 'Native file handles require Windows')
class NativeFiles(unittest.TestCase):
    def test_read_identity_locks_and_limits(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temporary:
            root = Path(temporary)
            target = root / 'synthetic.txt'
            target.write_bytes(b'SYNTHETIC')
            locked = WindowsFile(root, target)
            try:
                identity = locked.identity
                with self.assertRaises(OSError): target.write_bytes(b'CHANGED')
                with self.assertRaises(OSError): target.rename(root / 'renamed.txt')
            finally: locked.close()
            request = dict(root=str(root), relativePath=target.name, expectedBytes=9, fileIdentity=identity)
            result = read_saved(request)
            self.assertEqual(base64.b64decode(result['base64']), b'SYNTHETIC')
            self.assertTrue(result['exclusiveRead'])
            self.assertEqual(result['sha256'], hashlib.sha256(b'SYNTHETIC').hexdigest())
            for change, error in [({'fileIdentity': {}}, 'IDENTITY_MISMATCH'),
                                  ({'expectedBytes': 10}, 'SIZE_MISMATCH'),
                                  ({'expectedSha256': '0'*64}, 'HASH_MISMATCH'),
                                  ({'maxBytes': 8}, 'SIZE_LIMIT'),
                                  ({'relativePath': '../synthetic.txt'}, 'PATH_DENIED')]:
                with self.assertRaisesRegex(Rejected, error): read_saved(dict(request, **change))
            with target.open('r+b'):
                with self.assertRaisesRegex(Rejected, 'BUSY'): read_saved(request)
            os.link(target, root / 'hardlink.txt')
            with self.assertRaisesRegex(Rejected, 'HARDLINK_DENIED'): read_saved(request)

    def test_location_bound_to_root_and_name(self):
        root = r'C:\SYNTHETIC\account\FileStorage\File'
        self.assertEqual(normalize_location(root+r'\sub\data.txt', root, 'data.txt'), r'sub\data.txt')
        for value in (r'C:\elsewhere\data.txt', root+r'\..\data.txt', root+r'\data.txt:stream', root+r'\CON.txt'):
            with self.assertRaises(ValueError): normalize_location(value, root, 'data.txt')
        with self.assertRaisesRegex(ValueError, 'NAME_MISMATCH'):
            normalize_location(root+r'\data.txt', root, 'another.txt')


if __name__ == '__main__': unittest.main()
