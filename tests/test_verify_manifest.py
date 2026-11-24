import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'skills/xiaoqian-deploy/scripts/verify_manifest.py'
spec = importlib.util.spec_from_file_location('verify_manifest', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='.synthetic-', dir=Path(__file__).resolve().parent)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'note.txt').write_bytes(b'SYNTHETIC')
        self.manifest = {'version': 1, 'files': [{
            'path': 'note.txt', 'bytes': 9,
            'sha256': hashlib.sha256(b'SYNTHETIC').hexdigest()}]}

    def test_valid_manifest_leaves_content_unchanged(self):
        result = module.verify(self.root, self.manifest)
        self.assertEqual(result['verifiedFiles'], 1)
        self.assertEqual(result['verifiedBytes'], 9)
        self.assertEqual((self.root / 'note.txt').read_bytes(), b'SYNTHETIC')

    def test_wrong_hash_or_size_rejected(self):
        self.manifest['files'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(module.VerificationError, 'HASH_MISMATCH'):
            module.verify(self.root, self.manifest)
        self.manifest['files'][0]['bytes'] = 10
        with self.assertRaisesRegex(module.VerificationError, 'SIZE_MISMATCH'):
            module.verify(self.root, self.manifest)

    def test_unsafe_paths_rejected(self):
        for value in ['../note.txt', '/note.txt', 'C:/note.txt', 'a\\note.txt',
                      'note.txt:ads', 'NUL.txt', 'a./note.txt']:
            with self.subTest(value=value):
                with self.assertRaisesRegex(module.VerificationError, 'PATH_INVALID'):
                    module.checked_path(self.root, value)

    def test_casefold_duplicate_rejected(self):
        self.manifest['files'].append({**self.manifest['files'][0], 'path': 'NOTE.TXT'})
        with self.assertRaisesRegex(module.VerificationError, 'DUPLICATE_PATH'):
            module.verify(self.root, self.manifest)

    def test_empty_manifest_is_not_restore_success(self):
        with self.assertRaisesRegex(module.VerificationError, 'MANIFEST_FILES_INVALID'):
            module.verify(self.root, {'version': 1, 'files': []})

    def test_hardlink_rejected(self):
        import os
        os.link(self.root / 'note.txt', self.root / 'second.txt')
        with self.assertRaisesRegex(module.VerificationError, 'FILE_TYPE_OR_HARDLINK_DENIED'):
            module.verify(self.root, self.manifest)

    def test_cli_outputs_metadata_and_nonzero_on_corruption(self):
        manifest_path = self.root / 'manifest.json'
        manifest_path.write_text(json.dumps(self.manifest), encoding='utf-8')
        command = [sys.executable, '-B', str(SCRIPT), '--root', str(self.root),
                   '--manifest', str(manifest_path)]
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('SYNTHETIC', result.stdout)
        (self.root / 'note.txt').write_bytes(b'CORRUPTED')
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)['code'], 'HASH_MISMATCH')


if __name__ == '__main__':
    unittest.main()
