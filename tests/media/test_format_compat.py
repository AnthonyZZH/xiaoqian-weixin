"""Synthetic compatibility regression tests; no real media leaves its server."""
import hashlib
import struct
import unittest

from test_media import LibraryFixture, gif, png, WEBP, JPEG
from xiaoqian_media import inspect_bytes, InvalidMedia, IntegrityError

FOOTER = b'!\xfe' + b'0123456789abcdef' * 2


class FooterCompatibilityTests(LibraryFixture):
    def test_exact_footer_accepted_after_complete_gif_and_jpeg(self):
        for raw in (gif(), JPEG):
            with self.subTest(kind=raw[:6]):
                self.assertEqual(inspect_bytes(raw), inspect_bytes(raw + FOOTER))
                self.assertEqual(inspect_bytes(raw), inspect_bytes(raw + FOOTER.upper()))

    def test_import_keep_reopen_send_preserves_full_original_and_footer(self):
        from xiaoqian_media import MediaLibrary
        for raw in (gif() + FOOTER, JPEG + FOOTER):
            row = self.library.import_bytes(raw, description='synthetic legacy media')
            self.library.keep(row.media_id)
            reopened = MediaLibrary(self.base/'store', 'stickers', require_existing=True)
            target, payload = reopened.read_for_send(row.media_id)
            self.assertEqual(raw, payload)
            self.assertEqual(raw, target.path.read_bytes())
            self.assertEqual(hashlib.sha256(raw).hexdigest(), row.sha256)
            self.assertEqual(len(raw), row.byte_count)

    def test_footer_mutation_is_still_caught_by_full_file_hash(self):
        raw = gif() + FOOTER
        row = self.library.import_bytes(raw, description='synthetic')
        self.library.keep(row.media_id)
        target = self.library.resolve_send_target(row.media_id)
        target.path.write_bytes(raw[:-1] + b'0')
        with self.assertRaises(IntegrityError):
            self.library.read_for_send(row.media_id)

    def test_unknown_oversized_malformed_and_repeated_footers_rejected(self):
        tails = (b'arbitrary bytes', b'!\xff' + b'a'*32, b'!\xfe' + b'g'*32,
                 FOOTER + b'\x00', FOOTER[:-1], FOOTER + FOOTER)
        for raw in (gif(), JPEG):
            for tail in tails:
                with self.subTest(size=len(tail), kind=raw[:6]):
                    with self.assertRaises(InvalidMedia):
                        inspect_bytes(raw + tail)

    def test_real_missing_terminators_and_truncated_headers_still_rejected(self):
        for raw in (gif()[:-1], JPEG[:-2], JPEG[:20]):
            for suffix in (b'', FOOTER):
                with self.assertRaises(InvalidMedia):
                    inspect_bytes(raw + suffix)
        # EOI inside an APP block is not a complete main JPEG without a SOF/SOS.
        app_only = b'\xff\xd8\xff\xe1' + struct.pack('>H', 4) + b'\xff\xd9'
        with self.assertRaises(InvalidMedia):
            inspect_bytes(app_only + FOOTER)

    def test_full_input_size_limit_includes_footer(self):
        raw = gif()
        with self.assertRaises(InvalidMedia):
            inspect_bytes(raw + FOOTER, max_bytes=len(raw))

    def test_png_apng_and_webp_rules_are_unchanged(self):
        for raw in (png(), png(True), WEBP):
            with self.assertRaises(InvalidMedia):
                inspect_bytes(raw + FOOTER)


if __name__ == '__main__':
    unittest.main(verbosity=2)
