"""Bounded, standard-library document extraction and public HTML search.

Document bytes arrive through stdin; no model-supplied filesystem paths are opened.
No document code, macros, relationships, or embedded objects are executed/fetched.
"""
import base64
import io
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from html.parser import HTMLParser
from xml.etree import ElementTree as ET

MAX_INPUT = 8 * 1024 * 1024
MAX_TEXT = 60000
MAX_XML = 8 * 1024 * 1024


class ToolError(Exception):
    pass


def document(data, extension):
    if not isinstance(data, bytes) or len(data) > 5 * 1024 * 1024:
        raise ToolError('DOCUMENT_SIZE_LIMIT')
    if extension == '.txt':
        try:
            if data.startswith((b'\xff\xfe', b'\xfe\xff')):
                text = data.decode('utf-16', errors='strict')
                encoding = 'utf-16-bom'
            else:
                text = data.decode('utf-8-sig', errors='strict')
                encoding = 'utf-8'
        except UnicodeError:
            raise ToolError('TEXT_ENCODING_UNSUPPORTED') from None
        if '\x00' in text:
            raise ToolError('TEXT_BINARY_REJECTED')
    elif extension == '.docx':
        encoding = 'ooxml'
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 1000 or len({item.filename for item in entries}) != len(entries):
                raise ToolError('DOCX_STRUCTURE_LIMIT')
            if sum(item.file_size for item in entries) > 20 * 1024 * 1024:
                raise ToolError('DOCX_EXPANSION_LIMIT')
            for item in entries:
                name = item.filename.lower()
                if item.flag_bits & 1 or name.endswith('vbaproject.bin') or '/activex/' in name:
                    raise ToolError('DOCX_ACTIVE_CONTENT_REJECTED')
                if item.file_size > MAX_XML or item.file_size > max(1024, item.compress_size * 100):
                    raise ToolError('DOCX_EXPANSION_LIMIT')
            if 'word/document.xml' not in archive.namelist():
                raise ToolError('DOCX_DOCUMENT_MISSING')
            xml = archive.read('word/document.xml')
            # Reject DTD/entity declarations before any XML parser processes them.
            decoded = xml.decode('utf-16' if xml.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8-sig')
            if re.search(r'<!\s*(?:DOCTYPE|ENTITY)', decoded, re.I):
                raise ToolError('DOCX_ENTITY_REJECTED')
            root = ET.fromstring(decoded)
            ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
            paragraphs = []
            for paragraph in root.iter(ns + 'p'):
                chunks = []
                for element in paragraph.iter():
                    if element.tag == ns + 't':
                        chunks.append(element.text or '')
                    elif element.tag == ns + 'tab':
                        chunks.append('\t')
                    elif element.tag in (ns + 'br', ns + 'cr'):
                        chunks.append('\n')
                paragraphs.append(''.join(chunks))
            text = '\n'.join(paragraphs)
    else:
        raise ToolError('DOCUMENT_TYPE_UNSUPPORTED')
    return {'text': text[:MAX_TEXT], 'truncated': len(text) > MAX_TEXT,
            'total_characters': len(text), 'encoding': encoding,
            'trust': 'untrusted_document_content', 'macros_executed': False,
            'coverage': 'plain_text' if extension == '.txt' else 'document_body_and_tables_only'}


def safe_url(value):
    value = urllib.parse.urljoin('https://html.duckduckgo.com/', value)
    parsed = urllib.parse.urlsplit(value)
    if parsed.hostname in ('duckduckgo.com', 'html.duckduckgo.com'):
        target = urllib.parse.parse_qs(parsed.query).get('uddg', [])
        if target:
            value = target[0]
            parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        return None
    return value[:2000]


class SearchParser(HTMLParser):
    def __init__(self, engine):
        super().__init__(convert_charrefs=True)
        self.engine = engine
        self.results = []
        self.current = None
        self.heading = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'h2':
            self.heading += 1
        wanted = (self.engine == 'duckduckgo' and 'result__a' in attrs.get('class', '').split()) or (
            self.engine == 'bing' and self.heading > 0)
        if tag == 'a' and wanted:
            self.current = {'url': safe_url(attrs.get('href', '')), 'title': ''}

    def handle_data(self, data):
        if self.current:
            self.current['title'] += data

    def handle_endtag(self, tag):
        if tag == 'a' and self.current:
            self.current['title'] = re.sub(r'\s+', ' ', self.current['title']).strip()[:500]
            if self.current['url'] and self.current['title']:
                self.results.append(self.current)
            self.current = None
        if tag == 'h2':
            self.heading = max(0, self.heading - 1)


def parse_search_html(html, engine):
    lowered = html.lower()
    if any(mark in lowered for mark in ('anomaly-modal', 'captcha', 'verify you are human', 'unusual traffic')):
        raise ToolError('SEARCH_CHALLENGE')
    parser = SearchParser(engine)
    parser.feed(html)
    seen = set()
    rows = []
    for row in parser.results:
        if row['url'] not in seen:
            rows.append(row)
            seen.add(row['url'])
    return rows[:5]


class SearchRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        if parsed.scheme != 'https' or parsed.hostname not in ('html.duckduckgo.com', 'duckduckgo.com', 'www.bing.com', 'cn.bing.com'):
            raise ToolError('SEARCH_REDIRECT_DENIED')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def search(query, opener=None):
    if not isinstance(query, str) or not query.strip() or len(query) > 500:
        raise ToolError('SEARCH_QUERY_INVALID')
    opener = opener or urllib.request.build_opener(SearchRedirects())
    failures = []
    for engine, base in (('duckduckgo', 'https://html.duckduckgo.com/html/?q='),
                         ('bing', 'https://www.bing.com/search?q=')):
        try:
            req = urllib.request.Request(base + urllib.parse.quote(query), headers={'User-Agent': 'XiaoqianPublicSearch/1.0'})
            with opener.open(req, timeout=6) as response:
                raw = response.read(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    raise ToolError('SEARCH_RESPONSE_TOO_LARGE')
                rows = parse_search_html(raw.decode('utf-8', 'replace'), engine)
                if rows:
                    return {'engine': engine, 'results': rows, 'fallback_reasons': failures,
                            'trust': 'untrusted_web_content'}
                failures.append({'engine': engine, 'code': 'SEARCH_NO_RESULTS'})
        except ToolError as error:
            failures.append({'engine': engine, 'code': str(error)})
            if str(error) == 'SEARCH_CHALLENGE':
                # Do not retry or move to another route to bypass a challenge.
                return {'engine': engine, 'results': [], 'blocked': True, 'fallback_reasons': failures}
        except Exception:
            failures.append({'engine': engine, 'code': 'SEARCH_NETWORK_FAILED'})
    return {'results': [], 'unavailable': True, 'fallback_reasons': failures}


def main():
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ToolError('REQUEST_SIZE_LIMIT')
    request = json.loads(raw)
    if request['operation'] == 'document':
        data = base64.b64decode(request['base64'], validate=True)
        if request['extension'] == '.pdf':
            from pdf_document import document_pdf, PDFError
            try:
                return document_pdf(data, page_start=request.get('page_start', 1),
                                    page_count=request.get('page_count', 5), ocr=None)
            except PDFError as error:
                raise ToolError(str(error)) from None
        return document(data, request['extension'])
    if request['operation'] == 'fetch_page':
        from web_reader import fetch_page, PageError
        try:
            return fetch_page(request['url'])
        except PageError as error:
            raise ToolError(str(error)) from None
    if request['operation'] == 'search':
        return search(request['query'])
    raise ToolError('OPERATION_DENIED')


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'result': main()}, ensure_ascii=False))
    except ToolError as error:
        print(json.dumps({'ok': False, 'code': str(error)}))
    except Exception:
        # Never include source document bytes, request URLs, credentials or raw exceptions.
        print(json.dumps({'ok': False, 'code': 'WORKER_INPUT_OR_PARSE_FAILED'}))
