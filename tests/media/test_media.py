"""Offline synthetic tests. Scratch files are confined to this module directory."""
import sys
sys.path.insert(0,str(__import__('pathlib').Path(__file__).resolve().parents[2]/'vendor'))
import base64
import hashlib
import json
import os
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

from xiaoqian_media import (IntegrityError, InvalidMedia, InvalidState, MediaLibrary,
                            StoreBusy, UnknownMedia, UnsafePath, inspect_bytes)

SCRATCH = Path(__file__).resolve().parents[1] / '.test-tmp'
SCRATCH.mkdir(exist_ok=True)


def chunk(kind, body):
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)


def png(animated=False, color=b'\xff\x00\x00\xff'):
    header = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0))
    pixels = zlib.compress(b'\x00' + color)
    if animated:
        control = lambda seq: chunk(b'fcTL', struct.pack('>IIIIIHHBB', seq, 1, 1, 0, 0, 1, 10, 0, 0))
        return (header + chunk(b'acTL', struct.pack('>II', 2, 0)) + control(0)
                + chunk(b'IDAT', pixels) + control(1) + apng_payload() + chunk(b'IEND', b''))
    return header + chunk(b'IDAT', pixels) + chunk(b'IEND', b'')


def apng_payload():
    return chunk(b'fdAT', struct.pack('>I', 2) + zlib.compress(b'\x00\x00\x00\xff\xff'))


def gif(frames=2):
    header = b'GIF89a' + struct.pack('<HHBBB', 1, 1, 0x80, 0, 0) + b'\x00\x00\x00\xff\xff\xff'
    control = b'!\xf9\x04\x00\x08\x00\x00\x00'
    image = b',' + struct.pack('<HHHHB', 0, 0, 1, 1, 0) + b'\x02\x02\x44\x01\x00'
    return header + (control + image) * frames + b';'


# A two-frame 2x2 red/blue lossless WebP generated from blank synthetic images.
WEBP = base64.b64decode('UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAAAAAAAAABBTk1GKAAAAAAAAAAAAAEAAAEAAFAAAAJWUDhMDwAAAC8BQAAABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAAEAAAEAAFAAAABWUDhMDwAAAC8BQAAABxDR//4HIqL/AQA=')
JPEG = base64.b64decode('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z')


class InspectionTests(unittest.TestCase):
    def test_animation_detection(self):
        for data, kind, animated, frames in ((gif(), 'gif', True, 2), (gif(1), 'gif', False, 1),
                (png(True), 'apng', True, 2), (png(), 'png', False, 1), (WEBP, 'webp', True, 2), (JPEG, 'jpeg', False, 1)):
            with self.subTest(kind=kind, animated=animated):
                info = inspect_bytes(data)
                self.assertEqual((kind, animated, frames), (info.format, info.animated, info.frame_count))
                self.assertEqual('container_only', info.inspection)

    def test_gif_comment_markers_are_not_frames(self):
        self.assertEqual(1, inspect_bytes(gif(1)[:-1] + b'!\xfe\x03,,,\x00;').frame_count)

    def test_truncation_and_trailing_bytes(self):
        for raw in (gif(), png(True), WEBP, JPEG):
            for data in (raw[:10], raw[:-2], raw + b'foreign data'):
                with self.subTest(signature=raw[:8], length=len(data)):
                    with self.assertRaises(InvalidMedia): inspect_bytes(data)

    def test_png_crc_and_apng_declared_frame_count(self):
        raw = bytearray(png(True)); raw[29] ^= 1
        with self.assertRaises(InvalidMedia): inspect_bytes(bytes(raw))
        raw = png(True).replace(chunk(b'acTL', struct.pack('>II', 2, 0)), chunk(b'acTL', struct.pack('>II', 3, 0)))
        with self.assertRaises(InvalidMedia): inspect_bytes(raw)

    def test_apng_missing_frame_payload(self):
        with self.assertRaises(InvalidMedia): inspect_bytes(png(True).replace(apng_payload(), b''))

    def test_webp_riff_size_and_frame_bounds(self):
        raw = bytearray(WEBP); raw[4] += 1
        with self.assertRaises(InvalidMedia): inspect_bytes(bytes(raw))
        raw = bytearray(WEBP); pos = raw.index(b'ANMF') + 8; raw[pos:pos+3] = b'\xff\xff\xff'
        with self.assertRaises(InvalidMedia): inspect_bytes(bytes(raw))

    def test_type_size_dimensions_and_unsupported_data(self):
        for raw in (b'not an image', bytearray(gif()), b'', gif() * 2):
            with self.assertRaises(InvalidMedia): inspect_bytes(raw)
        with self.assertRaises(InvalidMedia): inspect_bytes(png(), 20)
        raw = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 20000, 1, 8, 6, 0, 0, 0))
        with self.assertRaises(InvalidMedia): inspect_bytes(raw)


class LibraryFixture(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix='media_', dir=SCRATCH)
        self.base = Path(self.scratch.name)
        self.imports = self.base / 'explicit-imports'; self.imports.mkdir()
        self.library = MediaLibrary(self.base / 'store', 'stickers', allowed_import_roots=[self.imports])

    def tearDown(self): self.scratch.cleanup()

    def make(self, raw=None, **metadata):
        return self.library.import_bytes(gif() if raw is None else raw, description='happy hello', **metadata)



class LibraryTests(LibraryFixture):
    def test_animation_hashes_survive_import_keep_preview_restart_send(self):
        for raw, ext in ((gif(), '.gif'), (WEBP, '.webp'), (png(True), '.apng')):
            with self.subTest(extension=ext):
                source = self.imports / ('provided' + ext); source.write_bytes(raw)
                digest = hashlib.sha256(raw).hexdigest()
                row = self.library.import_file(source, description='animated greeting')
                self.assertEqual('pending', row.status)
                with self.assertRaises(InvalidState): self.library.resolve_send_target(row.media_id)
                self.library.keep(row.media_id); self.library.attach_preview(row.media_id, png())
                preview = self.library.preview_target(row.media_id)
                self.assertTrue(preview.static_preview); self.assertTrue(preview.original_animated)
                self.assertEqual('first_frame_static', preview.render_mode)
                self.assertEqual(self.library.previews, preview.path.parent)
                reopened = MediaLibrary(self.base / 'store', 'stickers')
                target, payload = reopened.read_for_send(row.media_id)
                self.assertFalse(target.static_preview); self.assertTrue(target.animated)
                self.assertEqual(raw, payload); self.assertEqual(digest, target.sha256)
                self.assertEqual(digest, hashlib.sha256(target.path.read_bytes()).hexdigest())
                self.assertEqual(raw, source.read_bytes()); self.assertNotEqual(preview.path, target.path)

    def test_description_search_and_review_state(self):
        a = self.make(name='greeting', tags=('joy',)); b = self.make(png(), name='sad', tags=('tear',))
        self.assertEqual(2, len(self.library.pending())); self.assertEqual([], self.library.catalog())
        self.library.set_description(a.media_id, '\u5f00\u5fc3 \u6253\u62db\u547c', tags=('HELLO',))
        self.library.keep(a.media_id)
        self.assertEqual([a.media_id], [r.media_id for r in self.library.search('\u5f00\u5fc3')])
        self.assertEqual([a.media_id], [r.media_id for r in self.library.search('hello')])
        self.assertEqual([], self.library.search('tear'))
        self.assertEqual([b.media_id], [r.media_id for r in self.library.search('tear', status='pending')])

    def test_keep_requires_description(self):
        row = self.library.import_bytes(gif())
        with self.assertRaises(InvalidState): self.library.keep(row.media_id)
        self.library.set_description(row.media_id, 'reviewed'); self.library.keep(row.media_id)

    def test_exact_duplicate_keeps_manual_description(self):
        row = self.make(); self.library.set_description(row.media_id, 'manual words')
        same = self.make(); self.assertEqual(row.media_id, same.media_id)
        self.assertEqual('manual words', same.description); self.assertEqual(1, len(self.library.pending()))

    def test_capture_provenance_and_send_opt_in(self):
        row = self.library.import_static_capture(png(), description='screen crop')
        self.assertTrue(row.to_dict()['original_animation_unknown'])
        self.assertTrue(self.library.preview_target(row.media_id).original_animation_unknown)
        self.library.keep(row.media_id)
        with self.assertRaises(InvalidState): self.library.resolve_send_target(row.media_id)
        self.assertEqual(png(), self.library.read_for_send(row.media_id, allow_static_capture=True)[1])
        self.assertNotEqual(row.media_id, self.make(png()).media_id)
        with self.assertRaises(InvalidMedia): self.library.import_static_capture(gif())
        with self.assertRaises(ValueError): self.library.import_static_capture(png(), source_kind='original_file')

    def test_discard_removes_bytes_and_previews(self):
        row = self.make(); self.library.keep(row.media_id); self.library.attach_preview(row.media_id, png())
        payload = self.library.resolve_send_target(row.media_id).path
        preview = self.library.preview_target(row.media_id).path
        self.library.discard(row.media_id)
        self.assertFalse(payload.exists()); self.assertFalse(preview.exists())
        self.assertEqual('discarded', self.library.discard(row.media_id).status)
        for method in (self.library.keep, self.library.resolve_send_target, self.library.preview_target):
            with self.assertRaises(InvalidState): method(row.media_id)
        self.assertNotEqual(row.media_id, self.make().media_id)

    def test_original_tamper_fails_closed(self):
        row = self.make(); self.library.keep(row.media_id)
        path = self.library.resolve_send_target(row.media_id).path; path.write_bytes(gif(1))
        for action in (lambda: self.library.resolve_send_target(row.media_id), self.make,
                       lambda: self.library.discard(row.media_id)):
            with self.assertRaises(IntegrityError): action()
        self.assertTrue(path.exists())

    def test_description_does_not_change_bytes(self):
        row = self.make(); self.library.keep(row.media_id); before = self.library.read_for_send(row.media_id)
        self.library.set_description(row.media_id, 'changed', name='../display only')
        self.assertEqual(before, self.library.read_for_send(row.media_id))

    def test_id_and_collection_attacks_rejected(self):
        row = self.make(); self.library.keep(row.media_id)
        for value in ('../x', '..\\x', 'C:\\private.gif', 'file.gif', 'm_'+'a'*31,
                      'm_'+'A'*32, '//server/share', 'm_'+'a'*32+':ads', None, {}):
            for method in (self.library.get, self.library.keep, self.library.discard,
                           self.library.preview_target, self.library.resolve_send_target):
                with self.subTest(value=value, method=method.__name__):
                    with self.assertRaises(UnsafePath): method(value)
        for value in ('../other', 'C:\\app', 'x/../../app', 'x\\bad', 'CON', 'con', 'aux', 'com1', 'x.', 'x ', '', 'x:ads'):
            with self.subTest(collection=value):
                with self.assertRaises(UnsafePath): MediaLibrary(self.base/'store', value)
        other = MediaLibrary(self.base/'store', 'other')
        with self.assertRaises(UnknownMedia): other.resolve_send_target(row.media_id)

    def test_import_roots_traversal_and_ads(self):
        outside = self.base/'outside.gif'; outside.write_bytes(gif())
        inside = self.imports/'inside.gif'; inside.write_bytes(gif())
        for path in (outside, self.imports/'..'/'outside.gif', Path(str(inside)+':secret'), Path('relative.gif')):
            with self.subTest(path=path):
                with self.assertRaises(UnsafePath): self.library.import_file(path)
        with self.assertRaises(UnsafePath): MediaLibrary(self.base/'closed').import_file(inside)
        self.assertEqual(gif(), outside.read_bytes())

    def test_extension_mismatch_and_size_limit(self):
        wrong = self.imports/'wrong.png'; wrong.write_bytes(gif())
        with self.assertRaises(InvalidMedia): self.library.import_file(wrong)
        tiny = MediaLibrary(self.base/'tiny', max_bytes=20)
        with self.assertRaises(InvalidMedia): tiny.import_bytes(gif())
        self.assertEqual([], tiny.pending())

    def test_hardlinked_source_and_payload(self):
        source = self.imports/'source.gif'; source.write_bytes(gif())
        linked = self.imports/'hard.gif'; os.link(source, linked)
        with self.assertRaises(UnsafePath): self.library.import_file(linked)
        row = self.make(); self.library.keep(row.media_id); target = self.library.resolve_send_target(row.media_id).path
        os.link(target, self.base/'copy.gif')
        with self.assertRaises(UnsafePath): self.library.resolve_send_target(row.media_id)

    def test_symlink_source_and_payload_when_permitted(self):
        source = self.imports/'source.gif'; source.write_bytes(gif()); link = self.imports/'symbol.gif'
        try: link.symlink_to(source)
        except (OSError, NotImplementedError) as exc: self.skipTest('OS symlink privilege unavailable: '+str(exc))
        with self.assertRaises(UnsafePath): self.library.import_file(link)
        row = self.make(); self.library.keep(row.media_id); target = self.library.resolve_send_target(row.media_id).path
        target.unlink(); target.symlink_to(source)
        with self.assertRaises(UnsafePath): self.library.resolve_send_target(row.media_id)

    def test_catalog_corruption_and_injected_paths(self):
        row = self.make(); index = self.library.folder/'index.json'; original = index.read_bytes()
        for change in (lambda d: d['records'][row.media_id].update(file='../../private.gif'),
                       lambda d: d.update(collection_id='other'),
                       lambda d: d['records'][row.media_id].update(media_id='../x'),
                       lambda d: d['records'][row.media_id].update(sha256='0'*63),
                       lambda d: d['records'][row.media_id]['info'].update(extension='../gif')):
            document = json.loads(original); change(document); index.write_text(json.dumps(document), encoding='utf-8')
            with self.assertRaises(IntegrityError): MediaLibrary(self.base/'store', 'stickers')
        for text in ('{"schema_version":1,"schema_version":1}', 'corrupt JSON'):
            index.write_text(text, encoding='utf-8')
            with self.assertRaises(IntegrityError): self.library.pending()
            self.assertEqual(text, index.read_text(encoding='utf-8'))

    def test_cross_instance_writes_and_busy_lock(self):
        second = MediaLibrary(self.base/'store', 'stickers'); a = self.make()
        b = second.import_bytes(png(), description='second writer')
        self.assertEqual({a.media_id,b.media_id}, {r.media_id for r in self.library.pending()})
        lock = self.library.folder/'.write.lock'; lock.write_text('simulated active writer', encoding='utf-8')
        with self.assertRaises(StoreBusy): self.library.set_description(a.media_id,'must not write')
        self.assertTrue(lock.exists()); self.assertEqual('happy hello', second.get(a.media_id).description); lock.unlink()

    def test_failed_index_replace_preserves_old_catalog(self):
        row = self.make(); index = self.library.folder/'index.json'; previous = index.read_bytes(); real_replace = os.replace
        def fail(source, destination):
            if Path(destination).name == 'index.json': raise OSError('simulated disk failure')
            return real_replace(source,destination)
        with patch('xiaoqian_media.store.os.replace', side_effect=fail):
            with self.assertRaises(OSError): self.library.set_description(row.media_id,'not committed')
        self.assertEqual(previous,index.read_bytes()); self.assertFalse((self.library.folder/'.write.lock').exists())
        self.assertEqual([],list(self.library.folder.glob('.tmp_*')))

    def test_failed_preview_index_replace_preserves_previous_preview(self):
        row = self.make(); self.library.attach_preview(row.media_id,png()); previous = self.library.preview_target(row.media_id)
        with patch.object(self.library,'_save',side_effect=OSError('simulated disk failure')):
            with self.assertRaises(OSError): self.library.attach_preview(row.media_id,png(color=b'\x00\xff\x00\xff'))
        self.assertEqual(previous,self.library.preview_target(row.media_id))

    def test_queue_cap_and_input_validation(self):
        limited = MediaLibrary(self.base/'limited',max_pending=1); row = limited.import_bytes(gif(),description='first')
        with self.assertRaises(InvalidState): limited.import_bytes(png(),description='second')
        limited.keep(row.media_id); limited.import_bytes(png(),description='second')
        with self.assertRaises(ValueError): self.library.set_description(self.make().media_id,'   ')
        for limit in (0,-1,True,1001):
            with self.assertRaises(ValueError): self.library.catalog(limit=limit)

    def test_preview_is_never_send_target(self):
        row = self.make(); self.library.keep(row.media_id)
        with self.assertRaises(InvalidMedia): self.library.attach_preview(row.media_id,png(True))
        self.library.attach_preview(row.media_id,png()); preview = self.library.preview_target(row.media_id)
        with self.assertRaises(UnsafePath): self.library.resolve_send_target(str(preview.path))
        preview.path.write_bytes(png(color=b'\x00\xff\x00\xff'))
        with self.assertRaises(IntegrityError): self.library.preview_target(row.media_id)
        self.assertEqual(gif(),self.library.read_for_send(row.media_id)[1])

    def test_search_beyond_display_page_limit(self):
        row = self.make(); self.library.keep(row.media_id); index = self.library.folder/'index.json'
        document = json.loads(index.read_text(encoding='utf-8')); template = document['records'][row.media_id]; records={}
        for number in range(1002):
            key = 'm_'+f'{number:032x}'
            records[key] = dict(template,media_id=key,description='unique last' if number==1001 else 'common',created_ns=number)
        document['records']=records; index.write_text(json.dumps(document),encoding='utf-8')
        self.assertEqual(1,len(self.library.search('unique last')))


class RecoveryAndBoundaryTests(LibraryFixture):
    def test_directory_replacement_is_rejected(self):
        row = self.make()
        self.library.keep(row.media_id)
        self.library.originals.rename(self.library.folder / 'moved-originals')
        self.library.originals.mkdir()
        with self.assertRaises(UnsafePath):
            self.library.resolve_send_target(row.media_id)

    def test_symlinked_import_parent_is_rejected(self):
        outside = self.base / 'synthetic-outside'
        outside.mkdir()
        (outside / 'source.gif').write_bytes(gif())
        linked = self.imports / 'linked-parent'
        try:
            linked.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError) as exc:
            self.skipTest('OS directory symlink privilege unavailable: ' + str(exc))
        with self.assertRaises(UnsafePath):
            self.library.import_file(linked / 'source.gif')

    def test_discard_retries_after_tombstone_and_unlink_failure(self):
        row = self.make()
        self.library.keep(row.media_id)
        target = self.library.resolve_send_target(row.media_id).path
        real_unlink = Path.unlink
        def fail(path, *args, **kwargs):
            if path == target:
                raise OSError('simulated failure after tombstone')
            return real_unlink(path, *args, **kwargs)
        with patch('pathlib.Path.unlink', autospec=True, side_effect=fail):
            with self.assertRaises(OSError):
                self.library.discard(row.media_id)
        self.assertEqual('discarded', self.library.get(row.media_id).status)
        with self.assertRaises(InvalidState):
            self.library.resolve_send_target(row.media_id)
        self.assertTrue(target.exists())
        self.library.discard(row.media_id)
        self.assertFalse(target.exists())


if __name__=='__main__': unittest.main(verbosity=2)
