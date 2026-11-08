"""Bounded local readers. No macros, links, extraction to disk, OCR or network."""
import io
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

MAX_BYTES = 5 * 1024 * 1024
MAX_TEXT = 60000
MAX_XML = 8 * 1024 * 1024
TEXT = {'.txt', '.md', '.csv', '.json'}


class DocumentError(ValueError):
    pass


def decode(data):
    try:
        text = data.decode('utf-16' if data.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8-sig')
    except UnicodeError:
        raise DocumentError('TEXT_ENCODING_UNSUPPORTED') from None
    if '\x00' in text:
        raise DocumentError('TEXT_BINARY_REJECTED')
    return text


def xml(archive, name):
    item = archive.getinfo(name)
    if item.file_size > MAX_XML or item.flag_bits & 1:
        raise DocumentError('DOCUMENT_XML_LIMIT')
    data = archive.read(item)
    text = decode(data)
    if re.search(r'<!\s*(?:DOCTYPE|ENTITY)', text, re.I):
        raise DocumentError('DOCUMENT_ENTITY_REJECTED')
    return ET.fromstring(text)


def number(name):
    return [int(n) if n.isdigit() else n for n in re.split(r'(\d+)', name)]


def ooxml(archive, extension):
    entries = archive.infolist()
    if len(entries) > 1000 or len({e.filename for e in entries}) != len(entries):
        raise DocumentError('DOCUMENT_STRUCTURE_LIMIT')
    if sum(e.file_size for e in entries) > 32 * 1024 * 1024:
        raise DocumentError('DOCUMENT_EXPANSION_LIMIT')
    if extension == '.docx':
        root = xml(archive, 'word/document.xml')
        ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
        for p in root.iter(ns + 'p'):
            yield ''.join((e.text or '') if e.tag == ns + 't' else '\t' if e.tag == ns + 'tab'
                          else '\n' if e.tag in (ns + 'br', ns + 'cr') else '' for e in p.iter()) + '\n'
    elif extension == '.pptx':
        for name in sorted((e.filename for e in entries if re.fullmatch(r'ppt/slides/slide\d+\.xml', e.filename)), key=number):
            yield '[' + name + ']\n'
            for e in xml(archive, name).iter():
                if e.tag.endswith('}t'):
                    yield (e.text or '') + '\n'
    else:
        ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
        shared = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            shared = [''.join(t.text or '' for t in e.iter(ns + 't')) for e in xml(archive, 'xl/sharedStrings.xml').iter(ns + 'si')]
        for name in sorted((e.filename for e in entries if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', e.filename)), key=number):
            yield '[' + name + ']\n'
            for row in xml(archive, name).iter(ns + 'row'):
                cells = []
                for cell in row.findall(ns + 'c'):
                    value = cell.findtext(ns + 'v', '')
                    if cell.get('t') == 's':
                        value = shared[int(value)]
                    elif cell.get('t') == 'inlineStr':
                        value = ''.join(t.text or '' for t in cell.iter(ns + 't'))
                    elif cell.get('t') == 'b':
                        value = 'TRUE' if value == '1' else 'FALSE'
                    cells.append(cell.get('r', '') + '=' + value)
                yield '\t'.join(cells) + '\n'


def document(data, extension):
    if not isinstance(data, bytes) or len(data) > MAX_BYTES:
        raise DocumentError('DOCUMENT_SIZE_LIMIT')
    parts, used, cut, entries = [], 0, False, []
    limits = {'max_input_bytes': MAX_BYTES, 'max_characters': MAX_TEXT}

    def add(text):
        nonlocal used, cut
        remaining = MAX_TEXT - used
        parts.append(text[:remaining])
        used += min(len(text), remaining)
        cut = cut or len(text) > remaining

    if extension in TEXT:
        add(decode(data))
        coverage = 'plain_text_utf8_or_utf16'
    elif extension in {'.docx', '.xlsx', '.pptx'}:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for text in ooxml(archive, extension):
                add(text)
                if cut:
                    break
        coverage = {'.docx': 'body_and_tables', '.xlsx': 'cell_values_and_cached_formulas', '.pptx': 'slide_text'}[extension]
    elif extension == '.zip':
        limits.update(max_entries=200, max_expanded_bytes=32 * 1024 * 1024)
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            expanded = 0
            for item in archive.infolist()[:200]:
                row = {'name': item.filename[:200], 'bytes': item.file_size, 'read': False}
                entries.append(row)
                add(item.filename[:200] + ' (' + str(item.file_size) + ' bytes)\n')
                if Path(item.filename).suffix.lower() in TEXT and not item.is_dir():
                    if item.flag_bits & 1:
                        row['code'] = 'ZIP_ENCRYPTED_ENTRY'
                    elif item.file_size > MAX_XML or expanded + item.file_size > 32 * 1024 * 1024:
                        row['code'] = 'ZIP_EXPANSION_LIMIT'
                        cut = True
                    else:
                        expanded += item.file_size
                        try:
                            add(decode(archive.read(item)))
                            add('\n')
                            row['read'] = True
                        except DocumentError as error:
                            row['code'] = str(error)
                if cut:
                    break
            cut = cut or len(entries) < len(archive.infolist())
        coverage = 'directory_and_text_entries_only'
    elif extension == '.pdf':
        # Reuse the reviewed r10 vendored pypdf; no pip install or external process.
        sys.path.insert(0, str(Path(__file__).with_name('pdf-deps.zip')))
        from pypdf import PdfReader
        import pypdf.filters
        pypdf.filters.ZLIB_MAX_OUTPUT_LENGTH = MAX_XML
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise DocumentError('PDF_ENCRYPTED_PASSWORD_REQUIRED')
        pages = len(reader.pages)
        limits['max_pages'] = 20
        for index in range(min(pages, 20)):
            add('[page ' + str(index + 1) + ']\n' + (reader.pages[index].extract_text() or '') + '\n')
            if cut:
                break
        cut = cut or pages > 20
        coverage = 'embedded_text_only_no_ocr'
    else:
        raise DocumentError('DOCUMENT_TYPE_UNSUPPORTED')
    return {'text': ''.join(parts), 'truncated': cut, 'limits': limits, 'characters_returned': used,
            'coverage': coverage, 'entries': entries, 'trust': 'untrusted_document_content', 'macros_executed': False}
