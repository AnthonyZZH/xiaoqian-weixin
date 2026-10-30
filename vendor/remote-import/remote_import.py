"""Bounded public-image acquisition. No UI, model calls, or message sending."""
import hashlib
import http.client
import ipaddress
import json
import socket
import ssl
import time
from urllib.parse import urlsplit, urljoin, urlunsplit

from xiaoqian_media import inspect_bytes
from xiaoqian_media.safety import child, read_regular


class DownloadRejected(ValueError):
    pass


def checked_url(url):
    if not isinstance(url, str) or len(url) > 4096 or any(ord(c) <= 32 or ord(c) > 126 for c in url):
        raise DownloadRejected('URL must be bounded ASCII without whitespace')
    p = urlsplit(url)
    if p.scheme not in ('http', 'https') or not p.hostname or p.username is not None or p.password is not None or p.fragment:
        raise DownloadRejected('public HTTP(S) image URL required')
    try:
        port = p.port or (443 if p.scheme == 'https' else 80)
    except ValueError as e:
        raise DownloadRejected('invalid port') from e
    if port != (443 if p.scheme == 'https' else 80):
        raise DownloadRejected('only standard web ports allowed')
    return p, port


def public_addresses(host, port):
    try:
        addresses = list(dict.fromkeys(x[4][0] for x in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)))
    except OSError as e:
        raise DownloadRejected('DNS resolution failed') from e
    def safe(address):
        ip = ipaddress.ip_address(address)
        return (ip.is_global and not ip.is_multicast and not ip.is_reserved
                and not ip.is_unspecified and not getattr(ip, 'ipv4_mapped', None)
                and not getattr(ip, 'sixtofour', None) and not getattr(ip, 'teredo', None))
    if not addresses or not all(safe(x) for x in addresses):
        raise DownloadRejected('non-public destination rejected')
    return addresses


class PinnedConnection(http.client.HTTPConnection):
    def __init__(self, host, port, address, secure, timeout):
        super().__init__(host, port, timeout=timeout)
        self.address, self.secure = address, secure

    def connect(self):
        # Never resolve again after validation; HTTPS still verifies original host.
        self.sock = socket.create_connection((self.address, self.port), self.timeout)
        if self.secure:
            self.sock = ssl.create_default_context().wrap_socket(self.sock, server_hostname=self.host)


def download_image(url, *, max_bytes=20*1024*1024, timeout=15, max_redirects=3):
    if type(max_bytes) is not int or not 1 <= max_bytes <= 20*1024*1024:
        raise ValueError('max_bytes outside 1..20MiB')
    if not 0 < timeout <= 30 or type(max_redirects) is not int or not 0 <= max_redirects <= 5:
        raise ValueError('invalid request limits')
    start = time.monotonic()
    original = url
    for hop in range(max_redirects+1):
        p, port = checked_url(url)
        addresses = public_addresses(p.hostname, port)
        remaining = timeout - (time.monotonic()-start)
        if remaining <= 0:
            raise DownloadRejected('download deadline exceeded')
        conn = PinnedConnection(p.hostname, port, addresses[0], p.scheme == 'https', remaining)
        try:
            conn.request('GET', urlunsplit(('', '', p.path or '/', p.query, '')),
                         headers={'Accept': 'image/gif,image/png,image/webp,image/jpeg',
                                  'Accept-Encoding': 'identity', 'User-Agent': 'XiaoqianMediaImporter/1'})
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader('Location')
                if not location or hop == max_redirects:
                    raise DownloadRejected('redirect limit or missing destination')
                next_url = urljoin(url, location)
                if p.scheme == 'https' and urlsplit(next_url).scheme != 'https':
                    raise DownloadRejected('HTTPS downgrade rejected')
                url = next_url
                continue
            if response.status != 200:
                raise DownloadRejected('image server did not return HTTP 200')
            mime = response.getheader('Content-Type', '').split(';')[0].strip().lower()
            expected = {'image/gif': ('gif',), 'image/png': ('png','apng'),
                        'image/apng': ('apng',), 'image/webp': ('webp',), 'image/jpeg': ('jpeg',)}
            if mime not in expected or response.getheader('Content-Encoding', 'identity').lower() != 'identity':
                raise DownloadRejected('unsupported image MIME or encoding')
            length = response.getheader('Content-Length')
            if length is not None and (not length.isdecimal() or int(length) > max_bytes):
                raise DownloadRejected('invalid or oversized Content-Length')
            parts, size = [], 0
            while True:
                remaining = timeout - (time.monotonic()-start)
                if remaining <= 0:
                    raise DownloadRejected('download deadline exceeded')
                if conn.sock is not None:
                    conn.sock.settimeout(remaining)
                data = response.read1(min(65536, max_bytes+1-size))
                if not data:
                    break
                parts.append(data)
                size += len(data)
                if size > max_bytes:
                    raise DownloadRejected('image exceeds byte limit')
            raw = b''.join(parts)
            if length is not None and size != int(length):
                raise DownloadRejected('truncated response')
            info = inspect_bytes(raw, max_bytes)
            if info.format not in expected[mime]:
                raise DownloadRejected('MIME and image bytes disagree')
            return raw, {'requested_url': original, 'final_url': url, 'content_type': mime}
        finally:
            conn.close()
    raise DownloadRejected('redirect limit')


def import_url(library, url, *, name='', description='', tags=(), timeout=15):
    """Owner-authorized call; new records are pending. Duplicates retain review state.

    Append complete source URLs and supplied metadata to a digest-specific receipt.
    A receipt-write failure raises; retry is safe because import is deduplicated.
    """
    raw, source = download_image(url, max_bytes=library.max_bytes, timeout=timeout)
    digest = hashlib.sha256(raw).hexdigest()
    row = library.import_bytes(raw, name=name, description=description, tags=tags,
                               source_label='public-url:sha256:'+digest)
    receipt = dict(source, name=name, description=description, tags=list(tags), sha256=digest,
                   media_id=row.media_id)
    with library._operation(write=True):
        filename = 'remote-source-'+digest+'.json'
        path = child(library.folder, filename, missing=True)
        entries = json.loads(read_regular(path, 1024*1024).decode('utf-8')) if path.exists() else []
        if receipt not in entries:
            entries.append(receipt)
        payload = json.dumps(entries, ensure_ascii=False).encode('utf-8')
        if len(payload) > 1024*1024:
            raise DownloadRejected('provenance receipt capacity exceeded')
        library._atomic_write(library.folder, filename, payload)
    return row
