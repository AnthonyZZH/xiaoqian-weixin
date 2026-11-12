"""Public HTTP reader with DNS pinning, no proxy and no paid API.

Returns the readable part of a page, not the whole page: main content first, at most PAGE_CHARS per call
(`offset` continues), or only the passages that mention `focus`.  A page that is an empty JavaScript shell is
reported as such (`render_required`) together with whatever text its embedded data carries.
"""
import datetime
import http.client
import ipaddress
import json
import re
import socket
import ssl
import time
import urllib.parse
import zlib
from html.parser import HTMLParser

MAX_BYTES = 3 * 1024 * 1024
PAGE_CHARS = 12000
FOCUS_CHARS = 6000
MAX_HOPS = 5
CHARSETS = {'utf-8': 'utf-8', 'utf8': 'utf-8', 'iso-8859-1': 'iso-8859-1', 'windows-1252': 'windows-1252',
            'gb18030': 'gb18030', 'gbk': 'gb18030', 'gb2312': 'gb18030', 'big5': 'big5'}
CHALLENGE_TEXT = ('verify you are human', 'unusual traffic', 'subscribe to continue reading',
                  'enable javascript and cookies to continue', '当前环境异常', '完成验证后即可继续访问', '请完成安全验证')
SHELL_NOTE_PARTIAL = ('这个页面的正文由 JavaScript 渲染，HTML 里只有外壳；下面只是页面内嵌数据里能读到的文字，'
                      '可能不完整。不要把它当成全文，更不要据此断定「页面上没有」。')
SHELL_NOTE_EMPTY = '这个页面的正文由 JavaScript 渲染，这里读不到正文。换一个来源（新闻报道、官方文档或公告页、公众号文章）。'


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
    HIDDEN = ('script', 'style', 'noscript', 'svg', 'template', 'nav', 'footer', 'aside', 'form', 'iframe', 'button', 'select')
    BREAKS = ('p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'h4', 'tr', 'article', 'section', 'blockquote', 'pre')

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = []
        self.title_depth = 0
        self.title = []
        self.parts = []
        self.main_parts = []
        self.main_depth = 0
        self.restricted = False
        self.meta = {}
        self.published = None
        self.data_kind = None
        self.data = []
        self.embedded = []

    def handle_starttag(self, tag, attrs):
        attrs = {key: value or '' for key, value in attrs}
        if tag == 'meta':
            name = (attrs.get('property') or attrs.get('name') or attrs.get('itemprop') or '').lower()
            if name and attrs.get('content') and name not in self.meta:
                self.meta[name] = attrs['content'].strip()[:1000]
            return
        if tag == 'time' and attrs.get('datetime') and not self.published:
            self.published = attrs['datetime'][:40]
        if tag == 'script':
            kind = attrs.get('type', '').lower()
            if kind == 'application/ld+json':
                self.data_kind = 'ld'
            elif kind == 'application/json' or attrs.get('id', '') in ('__NEXT_DATA__', '__NUXT_DATA__'):
                self.data_kind = 'json'
            else:
                self.data_kind = 'js'
            self.data = []
        if tag in self.HIDDEN:
            self.hidden.append(tag)
        if tag == 'title':
            self.title_depth += 1
        if tag in ('article', 'main') and not self.hidden:
            self.main_depth += 1
        if any(x in (attrs.get('id', '') + ' ' + attrs.get('class', '')).lower() for x in ('captcha', 'anomaly-modal', 'paywall', 'challenge-form')):
            self.restricted = True
        if not self.hidden and tag in self.BREAKS:
            self.parts.append('\n')
            if self.main_depth:
                self.main_parts.append('\n')

    def handle_endtag(self, tag):
        if tag == 'script' and self.data_kind:
            if len(self.embedded) < 40:
                self.embedded.append((self.data_kind, ''.join(self.data)))
            self.data_kind = None
        if self.hidden and tag == self.hidden[-1]:
            self.hidden.pop()
        if tag == 'title':
            self.title_depth = max(0, self.title_depth - 1)
        if tag in ('article', 'main') and self.main_depth and not self.hidden:
            self.main_depth -= 1

    def handle_data(self, data):
        if self.data_kind:
            if sum(len(x) for x in self.data) < 2 * 1024 * 1024:
                self.data.append(data)
        elif self.title_depth:
            self.title.append(data)
        elif not self.hidden:
            self.parts.append(data)
            if self.main_depth:
                self.main_parts.append(data)


def tidy(parts):
    lines = (re.sub(r'[ \t\r\f\v 　]+', ' ', line).strip() for line in ''.join(parts).split('\n'))
    return '\n'.join(line for line in lines if line)


def _strings(value, out, depth=0):
    """Human-readable strings inside embedded page data (hydration state, JSON-LD)."""
    if depth > 12 or len(out) > 400:
        return
    if isinstance(value, str):
        text = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', value)).strip()
        if len(text) >= 30 and not re.match(r'^(https?:|data:|/|[\w.\-]+$)', text) and (
                re.search(r'[㐀-鿿]', text) or text.count(' ') >= 4):
            out.append(text[:3000])
    elif isinstance(value, dict):
        for item in value.values():
            _strings(item, out, depth + 1)
    elif isinstance(value, list):
        for item in value[:200]:
            _strings(item, out, depth + 1)


def embedded_text(parser):
    """Text and a date that a script-rendered page still ships inside its HTML."""
    out, published = [], None
    for kind, raw in parser.embedded:
        raw = raw.strip()
        if kind == 'js':
            m = re.search(r'(?:__INITIAL_STATE__|__NUXT__|__PRELOADED_STATE__|__APOLLO_STATE__)\s*=\s*(\{.*\})', raw, flags=re.S)
            if not m:
                continue
            raw = m.group(1)
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        if kind == 'ld':
            for node in (data if isinstance(data, list) else [data]):
                if isinstance(node, dict) and not published:
                    published = node.get('datePublished') or node.get('dateModified')
        _strings(data, out)
    return '\n'.join(dict.fromkeys(out))[:PAGE_CHARS], (published[:40] if isinstance(published, str) else None)


def client_redirect(raw):
    """Tiny interstitial pages (a search engine's link hop) that only forward the browser."""
    if len(raw) > 4096:
        return None
    m = re.search(r'http-equiv=["\']?refresh["\']?[^>]*content=["\']\s*\d+\s*;\s*url=["\']?([^"\'>\s]+)', raw, flags=re.I) or \
        re.search(r'location\.(?:replace|assign)\(\s*["\']([^"\']+)["\']', raw) or \
        re.search(r'location(?:\.href)?\s*=\s*["\']([^"\']+)["\']', raw)
    return m.group(1) if m else None


def focus_units(focus):
    units = []
    for word in re.findall(r'[a-z0-9][a-z0-9.+#\-]*', focus.lower()):
        if len(word) >= 2 and word not in units:
            units.append(word)
    for run in re.findall(r'[㐀-鿿]+', focus):
        for piece in ([run] if len(run) <= 4 else [run[i:i + 2] for i in range(len(run) - 1)]):
            if len(piece) >= 2 and piece not in units:
                units.append(piece)
    return units[:24]


def focus_passages(text, focus, limit=FOCUS_CHARS):
    """Paragraphs that mention the focus words, each with a neighbour either side, in page order."""
    units = focus_units(focus)
    lines = text.split('\n')
    scored = []
    for index, line in enumerate(lines):
        low = line.lower()
        score = sum(1 for unit in units if unit in low)
        if score:
            scored.append((score, index))
    if not scored:
        return None, 0
    keep, used = set(), 0
    for _score, index in sorted(scored, key=lambda row: (-row[0], row[1])):
        group = [i for i in (index - 1, index, index + 1) if 0 <= i < len(lines) and i not in keep]
        size = sum(len(lines[i]) + 1 for i in group)
        if used + size > limit:
            if used:
                continue
            lines[index] = lines[index][:limit]
            group, size = [index], limit
        keep.update(group)
        used += size
    out, last = [], None
    for index in sorted(keep):
        if last is not None and index != last + 1:
            out.append('[…]')
        out.append(lines[index])
        last = index
    return '\n'.join(out), len(scored)


def read_html(raw, count):
    """(text, title, published, shell) for one decoded HTML document of `count` bytes."""
    parser = TextHTML()
    parser.feed(raw)
    whole, main = tidy(parser.parts), tidy(parser.main_parts)
    text = main if len(main) >= 400 else whole
    data_text, data_date = embedded_text(parser)
    published = parser.meta.get('article:published_time') or parser.meta.get('datepublished') or \
        parser.meta.get('og:updated_time') or parser.meta.get('date') or parser.published or data_date
    shell = len(text) < 200 and count > 5000
    if shell:
        # A JavaScript shell: the HTML carries no article.  Hand over what its data does carry.
        summary = parser.meta.get('og:description') or parser.meta.get('description') or ''
        text = '\n'.join(part for part in (summary, data_text) if part) or text
    title = (''.join(parser.title).strip() or parser.meta.get('og:title', ''))[:300]
    return text, title, (published[:40] if published else None), shell, parser.restricted


def fetch_page(url, resolver=socket.getaddrinfo, connector=None, focus=None, offset=0, limit=PAGE_CHARS):
    if focus is not None and (not isinstance(focus, str) or len(focus) > 200):
        raise PageError('FOCUS_INVALID')
    if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
        raise PageError('OFFSET_INVALID')
    if not isinstance(limit, int) or isinstance(limit, bool) or not 500 <= limit <= PAGE_CHARS:
        raise PageError('LIMIT_INVALID')
    deadline = time.monotonic() + 17
    original = url
    for hop in range(MAX_HOPS):
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
            conn.request('GET', request_path, headers={'Host': parsed.netloc, 'User-Agent': 'XiaoqianPublicPageReader/1.0', 'Accept': 'text/html,application/xhtml+xml,text/plain', 'Accept-Encoding': 'identity', 'Connection': 'close'})
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader('Location')
                if hop == MAX_HOPS - 1 or not location:
                    raise PageError('REDIRECT_LIMIT')
                url = urllib.parse.urljoin(clean, location)
                continue  # next hop resolves and validates EVERY address again
            if response.status in (401, 402, 403, 429):
                return {'status': 'restricted', 'http_status': response.status, 'url': clean, 'text': '', 'reason': 'ACCESS_OR_PAYMENT_REQUIRED'}
            if response.status != 200:
                raise PageError('HTTP_STATUS_' + str(response.status))
            mime = response.getheader('Content-Type', '').lower()
            is_html = mime.startswith('text/html') or mime.startswith('application/xhtml+xml')
            if not (is_html or mime.startswith('text/plain') or mime.startswith('application/json')):
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
            body = b''.join(chunks)
            if content_encoding == 'gzip':
                decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
                body = decoder.decompress(body, MAX_BYTES + 1)
                if len(body) > MAX_BYTES or decoder.unconsumed_tail:
                    raise PageError('PAGE_SIZE_LIMIT')
                if not decoder.eof or decoder.unused_data:
                    raise PageError('CONTENT_ENCODING_DENIED')
            charset = re.search(r'charset\s*=\s*["\']?([\w-]+)', mime) or \
                re.search(r'<meta[^>]+charset\s*=\s*["\']?([\w-]+)', body[:4096].decode('ascii', 'replace'), flags=re.I)
            encoding = CHARSETS.get(charset.group(1).lower() if charset else 'utf-8')
            if not encoding:
                raise PageError('CHARSET_UNSUPPORTED')
            raw = body.decode(encoding, errors='replace')
            forward = client_redirect(raw) if is_html else None
            if forward:
                if hop == MAX_HOPS - 1:
                    raise PageError('REDIRECT_LIMIT')
                url = urllib.parse.urljoin(clean, forward)
                continue  # a script/meta forward is a redirect like any other: validated again next hop
            title, published, shell, restricted = '', None, False, False
            text = raw
            if is_html:
                text, title, published, shell, restricted = read_html(raw, count)
            lowered = text.lower()
            if restricted or 'captcha' in parsed.path.lower() or any(x in lowered for x in CHALLENGE_TEXT):
                # A verification or pay wall is where reading stops; it is never worked around.
                return {'status': 'restricted', 'requested_url': original, 'url': clean, 'text': '', 'reason': 'CHALLENGE_OR_PAYWALL',
                        'note': '这个页面要求人机验证或付费，读不了。用搜索结果里的摘要，或换一个来源。'}
            result = {'status': 'ok', 'requested_url': original, 'url': clean, 'title': title, 'published': published,
                      'last_modified': response.getheader('Last-Modified'), 'characters': len(text), 'bytes': count,
                      'redirects': hop, 'fetched_at': datetime.datetime.now().astimezone().strftime('%Y-%m-%d %H:%M %z'),
                      'trust': 'untrusted_web_content'}
            if shell:
                result['render_required'] = True
                if len(text) < 80:
                    result['status'] = 'render_required'
                    result['note'] = SHELL_NOTE_EMPTY
                else:
                    result['source'] = 'embedded_data'
                    result['note'] = SHELL_NOTE_PARTIAL
            passages, hits = focus_passages(text, focus, min(limit, FOCUS_CHARS)) if focus else (None, 0)
            if passages is not None:
                result.update({'mode': 'focus', 'focus_hits': hits, 'text': passages})
                return result
            if focus:
                result['focus_hits'] = 0
                result['note'] = (result.get('note', '') + ' 正文里没有出现 focus 里的词，返回的是正文开头。').strip()
                offset = 0
            if offset and offset >= len(text):
                raise PageError('OFFSET_BEYOND_END')
            result['text'] = text[offset:offset + limit]
            result['offset'] = offset
            result['truncated'] = offset + limit < len(text)
            if result['truncated']:
                result['next_offset'] = offset + limit
            return result
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
