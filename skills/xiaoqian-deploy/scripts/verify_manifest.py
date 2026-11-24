"""Read-only verification of an explicit, trusted, quiescent backup manifest.
No traversal/discovery, copy, restore, network, subprocesses or application calls.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


class VerificationError(ValueError):
    pass


def require(value, code):
    if not value:
        raise VerificationError(code)


def checked_path(root, value):
    require(isinstance(value, str) and 0 < len(value) <= 2048, 'PATH_INVALID')
    parts = value.split('/')
    require(all(p and p not in {'.', '..'} and not p.endswith((' ', '.'))
                and not any(c in p for c in '\\:\x00<>"|?*')
                and p.split('.')[0].upper() not in
                {'CON', 'PRN', 'AUX', 'NUL', *[f'COM{i}' for i in range(10)],
                 *[f'LPT{i}' for i in range(10)]} for p in parts), 'PATH_INVALID')
    cursor = root
    for part in parts:
        cursor = cursor / part
        info = cursor.lstat()
        require(not stat.S_ISLNK(info.st_mode)
                and not getattr(info, 'st_file_attributes', 0) & 0x400, 'LINK_DENIED')
    require(cursor.resolve().is_relative_to(root), 'PATH_OUTSIDE_ROOT')
    return cursor


def verify(root, manifest):
    root = Path(root).absolute()
    # Caller supplies an immutable/trusted tree. These checks do not remove
    # races against an adversarial writer and are not claimed as an OS sandbox.
    for ancestor in [*reversed(root.parents), root]:
        info = ancestor.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                and not getattr(info, 'st_file_attributes', 0) & 0x400, 'ROOT_LINK_DENIED')
    root = root.resolve()
    require(isinstance(manifest, dict) and manifest.get('version') == 1, 'MANIFEST_VERSION_INVALID')
    rows = manifest.get('files')
    require(isinstance(rows, list) and 0 < len(rows) <= 100000, 'MANIFEST_FILES_INVALID')
    seen = set()
    total_bytes = 0
    for row in rows:
        require(isinstance(row, dict) and set(row) == {'path', 'bytes', 'sha256'}, 'ENTRY_INVALID')
        require(isinstance(row['path'], str), 'PATH_INVALID')
        key = row['path'].casefold()
        require(key not in seen, 'DUPLICATE_PATH')
        seen.add(key)
        require(type(row['bytes']) is int and row['bytes'] >= 0, 'SIZE_INVALID')
        require(isinstance(row['sha256'], str) and re.fullmatch(r'[0-9a-f]{64}', row['sha256']), 'HASH_INVALID')
        filename = checked_path(root, row['path'])
        before = filename.stat()
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'FILE_TYPE_OR_HARDLINK_DENIED')
        require(before.st_size == row['bytes'], 'SIZE_MISMATCH')
        digest = hashlib.sha256()
        with filename.open('rb') as stream:
            opened = os.fstat(stream.fileno())
            require((opened.st_dev, opened.st_ino, opened.st_size, opened.st_nlink) ==
                    (before.st_dev, before.st_ino, before.st_size, 1), 'FILE_CHANGED')
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
            after = os.fstat(stream.fileno())
            require((after.st_size, after.st_mtime_ns) == (before.st_size, before.st_mtime_ns), 'FILE_CHANGED')
        require(digest.hexdigest() == row['sha256'], 'HASH_MISMATCH')
        total_bytes += before.st_size
    return {'ok': True, 'verifiedFiles': len(rows), 'verifiedBytes': total_bytes,
            'scope': 'listed-files-only'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--manifest', required=True)
    args = parser.parse_args()
    try:
        with open(args.manifest, 'rb') as stream:
            raw = stream.read(32 * 1024 * 1024 + 1)
        require(len(raw) <= 32 * 1024 * 1024, 'MANIFEST_SIZE_LIMIT')
        manifest = json.loads(raw.decode('utf-8-sig'))
        print(json.dumps(verify(args.root, manifest)))
        return 0
    except (OSError, UnicodeError, json.JSONDecodeError, VerificationError) as exc:
        code = str(exc) if isinstance(exc, VerificationError) else 'MANIFEST_OR_FILE_UNREADABLE'
        print(json.dumps({'ok': False, 'code': code}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
