"""Synthetic search and drawing responses; never makes a network request."""
import json
import struct
import sys
import zlib
from pathlib import Path


def chunk(kind, body):
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)


request = json.load(sys.stdin)
if request['operation'] == 'search':
    print(json.dumps({'ok': True, 'results': [{'title': 'Synthetic',
        'url': 'https://example.invalid/source', 'snippet': 'No network used'}]}))
elif request['operation'] == 'draw':
    root = Path(request['generatedRoot'])
    output = Path(request['output'])
    assert output.parent == root
    root.mkdir(parents=True, exist_ok=True)
    header = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0))
    output.write_bytes(header + chunk(b'IDAT', zlib.compress(b'\x00\xff\x00\x00\xff')) + chunk(b'IEND', b''))
    print(json.dumps({'ok': True, 'path': str(output)}))
elif request['operation'] == 'vision':
    print(json.dumps({'ok': True, 'description': 'Synthetic image description'}))
else:
    print(json.dumps({'ok': False, 'code': 'denied'}))
