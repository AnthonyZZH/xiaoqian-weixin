"""Public HTTP reader with DNS pinning, no proxy and no paid API."""
import datetime
import http.client
import ipaddress
import re
import socket
import ssl
import time
import urllib.parse
import zlib
from html.parser import HTMLParser

MAX_BYTES = 1024 * 1024
MAX_CHARS = 40000


class PageError(Exception):
    pass


def target(url, resolver=socket.getaddrinfo):
    if not isinstance(url, str) or len(url) > 2000 or re.search(r'[\x00-\x20\\]', url):
        raise PageError('URL_INVALID')
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise PageError('URL_SCHEME_OR_AUTH_DENIED')
    host = parsed.hostname.rstrip('.').lower()
    if host == 'localhost' or host.endswith(('.localhost', '.local', '.internal')) or '%' in host:
        raise PageError('ADDRESS_DENIED')
    port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    if port != (443 if parsed.scheme == 'https' else 80):
        raise PageError('PORT_DENIED')
    try:
        addresses = list(dict.fromkeys(row[4][0] for row in resolver(host, port, type=socket.SOCK_STREAM)))
    except OSError:
        raise PageError('DNS_FAILED') from None
    if not addresses:
        raise PageError('DNS_FAILED')
    for address in addresses:
        ip = ipaddress.ip_address(address)
        mapped = getattr(ip, 'ipv4_mapped', None)
        if not ip.is_global or mapped is not None or getattr(ip, 'sixtofour', None) is not None or getattr(ip, 'teredo', None) is not None:
            raise PageError('ADDRESS_DENIED')
    clean = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path or '/', parsed.query, ''))
    return clean, host, port, addresses


class TextHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = []
        self.title_depth = 0
        self.title = []
        self.parts = []
        self.restricted = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ('script', 'style', 'noscript', 'svg', 'template', 'nav', 'footer'):
            self.hidden.append(tag)
        if tag == 'title':
            self.title_depth += 1
        if any(x in (attrs.get('id', '') + ' ' + attrs.get('class', '')).lower() for x in ('captcha', 'anomaly-modal', 'paywall', 'challenge-form')):
            self.restricted = True
        if not self.hidden and tag in ('p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'article', 'section'):
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if self.hidden and tag == self.hidden[-1]:
            self.hidden.pop()
        if tag == 'title':
            self.title_depth = max(0, self.title_depth - 1)

    def handle_data(self, data):
        if self.title_depth:
            self.title.append(data)
        elif not self.hidden:
            self.parts.append(data)


def fetch_page(url, resolver=socket.getaddrinfo, connector=None):
    deadline = time.monotonic() + 17
    original = url
    for hop in range(4):
        clean, host, port, addresses = target(url, resolver)
        remaining = min(6, deadline - time.monotonic())
        if remaining <= 0:
            raise PageError('PAGE_TIMEOUT')
        parsed = urllib.parse.urlsplit(clean)
        conn = None
        try:
            if connector:
                conn = connector(clean, host, port, addresses, remaining)
            else:
                # Resolve/check once per hop, then connect only to that numeric IP.
                # No second hostname lookup may choose a private address (DNS rebinding).
                conn = http.client.HTTPConnection(host, port, timeout=remaining)
                sock = socket.create_connection((addresses[0], port), timeout=remaining)
                if ipaddress.ip_address(sock.getpeername()[0]) not in [ipaddress.ip_address(x) for x in addresses]:
                    sock.close()
                    raise PageError('PEER_ADDRESS_CHANGED')
                if parsed.scheme == 'https':
                    try:
                        sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
                    except Exception:
                        sock.close()
                        raise
                conn.sock = sock
            request_path = parsed.path or '/'
            if parsed.query:
                request_path += '?' + parsed.query
            conn.request('GET', request_path, headers={'Host': parsed.netloc, 'User-Agent': 'XiaoqianPublicPageReader/1.0', 'Accept': 'text/html,text/plain', 'Accept-Encoding': 'identity', 'Connection': 'close'})
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader('Location')
                if hop == 3 or not location:
                    raise PageError('REDIRECT_LIMIT')
                url = urllib.parse.urljoin(clean, location)
                continue  # next hop resolves and validates EVERY address again
            if response.status in (401, 402, 403, 429):
                return {'status': 'restricted', 'http_status': response.status, 'url': clean, 'text': '', 'reason': 'ACCESS_OR_PAYMENT_REQUIRED'}
            if response.status != 200:
                raise PageError('HTTP_STATUS_' + str(response.status))
            mime = response.getheader('Content-Type', '').lower()
            if not (mime.startswith('text/html') or mime.startswith('text/plain')):
                raise PageError('CONTENT_TYPE_DENIED')
            content_encoding = response.getheader('Content-Encoding', 'identity').lower()
            if content_encoding not in ('identity', 'gzip'):
                raise PageError('CONTENT_ENCODING_DENIED')
            length = response.getheader('Content-Length')
            if length and int(length) > MAX_BYTES:
                raise PageError('PAGE_SIZE_LIMIT')
            chunks = []
            count = 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise PageError('PAGE_TIMEOUT')
                if getattr(conn, 'sock', None):
                    conn.sock.settimeout(min(6, remaining))
                data = response.read(min(65536, MAX_BYTES + 1 - count))
                if not data:
                    break
                count += len(data)
                if count > MAX_BYTES:
                    raise PageError('PAGE_SIZE_LIMIT')
                chunks.append(data)
            charset = re.search(r'charset\s*=\s*["\']?([\w-]+)', mime)
            encoding = charset.group(1) if charset else 'utf-8'
            if encoding not in ('utf-8', 'utf8', 'iso-8859-1', 'windows-1252', 'gb18030', 'gbk'):
                raise PageError('CHARSET_UNSUPPORTED')
            body = b''.join(chunks)
            if content_encoding == 'gzip':
                decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
                body = decoder.decompress(body, MAX_BYTES + 1)
                if len(body) > MAX_BYTES or decoder.unconsumed_tail:
                    raise PageError('PAGE_SIZE_LIMIT')
                if not decoder.eof or decoder.unused_data:
                    raise PageError('CONTENT_ENCODING_DENIED')
            raw = body.decode(encoding, errors='replace')
            parser = TextHTML()
            if mime.startswith('text/html'):
                parser.feed(raw)
                text = '\n'.join(re.sub(r'[ \t\r\f]+', ' ', part).strip() for part in ''.join(parser.parts).split('\n'))
            else:
                text = raw
            lowered = text.lower()
            if parser.restricted or any(x in lowered for x in ('verify you are human', 'unusual traffic', 'subscribe to continue reading', 'enable javascript and cookies to continue')):
                return {'status': 'restricted', 'url': clean, 'text': '', 'reason': 'CHALLENGE_OR_PAYWALL'}
            return {'status': 'ok', 'requested_url': original, 'url': clean, 'title': ''.join(parser.title).strip()[:500],
                    'text': text[:MAX_CHARS], 'characters': len(text), 'truncated': len(text) > MAX_CHARS,
                    'bytes': count, 'redirects': hop, 'fetched_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    'last_modified': response.getheader('Last-Modified'), 'trust': 'untrusted_web_content'}
        except PageError:
            raise
        except (TimeoutError, socket.timeout):
            raise PageError('PAGE_TIMEOUT') from None
        except Exception:
            raise PageError('PAGE_NETWORK_FAILED') from None
        finally:
            if conn:
                conn.close()
    raise PageError('REDIRECT_LIMIT')
