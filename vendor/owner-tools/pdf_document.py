"""Offline PDF text extraction; never executes actions, links or embedded files."""
import io
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from dataclasses import dataclass

MAX_INPUT=5*1024*1024
MAX_TEXT=60000

@dataclass(frozen=True)
class PDFLimits:
    max_input: int=64*1024*1024
    max_pages: int=2000
    pages_per_read: int=10
    max_text: int=60000
    max_stream: int=4*1024*1024
    def __post_init__(self):
        for name,ceiling in [('max_input',256*1024*1024),('max_pages',10000),('pages_per_read',100),('max_text',200000),('max_stream',16*1024*1024)]:
            if type(getattr(self,name)) is not int or not 1<=getattr(self,name)<=ceiling:
                raise ValueError('PDF_LIMIT_CONFIG_INVALID')

class PDFError(ValueError):
    pass

def local_ocr(data, page, *, renderer=None, engine=None, language='eng', tessdata=None,
              timeout=8, scale=2000):
    """Optional local Poppler + Tesseract only. No network or remote OCR fallback."""
    import re
    if not re.fullmatch(r'[a-z_]+(?:\+[a-z_]+)*',language) or not 1<=timeout<=30 or not 256<=scale<=4000:
        raise PDFError('PDF_OCR_CONFIG_INVALID')
    for value in (renderer,engine,tessdata):
        if value is not None and not Path(value).is_absolute():raise PDFError('PDF_OCR_CONFIG_INVALID')
    render, ocr=renderer or shutil.which('pdftoppm'),engine or shutil.which('tesseract')
    if not render or not ocr:
        return None
    with tempfile.TemporaryDirectory(prefix='xq-pdf-ocr-') as folder:
        src=Path(folder)/'input.pdf'
        if isinstance(data,bytes):src.write_bytes(data)
        else:
            position=data.tell();data.seek(0)
            with src.open('wb') as out:
                while True:
                    block=data.read(1024*1024)
                    if not block:break
                    out.write(block)
            data.seek(position)
        out=Path(folder)/'page'
        flags={'creationflags':0x08000000} if os.name=='nt' else {}
        subprocess.run([render,'-f',str(page),'-l',str(page),'-scale-to',str(scale),'-singlefile','-png',str(src),str(out)],
                       check=True,timeout=timeout,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,**flags)
        image=out.with_suffix('.png')
        if not image.is_file() or image.stat().st_size>16*1024*1024:
            raise PDFError('PDF_OCR_IMAGE_LIMIT')
        target=Path(folder)/'ocr'
        command=[ocr,str(image),str(target),'-l',language]
        if tessdata:command+=['--tessdata-dir',tessdata]
        subprocess.run(command,check=True,timeout=timeout,
                       stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,**flags)
        text=target.with_suffix('.txt')
        if not text.is_file() or text.stat().st_size>256*1024:
            raise PDFError('PDF_OCR_OUTPUT_LIMIT')
        return text.read_text(encoding='utf-8')

def document_pdf(data, *, page_start=1, page_count=5, ocr=local_ocr, limits=None):
    # Byte-based legacy calls retain their transport cap. Host stream calls use
    # configured policy; neither source nor policy is accepted from model paths.
    limits=limits or PDFLimits(max_input=MAX_INPUT,max_pages=500)
    if isinstance(data,bytes):
        size=len(data);stream=io.BytesIO(data)
    elif hasattr(data,'seek') and hasattr(data,'read'):
        stream=data;stream.seek(0,2);size=stream.tell();stream.seek(0)
    else:raise PDFError('PDF_SOURCE_INVALID')
    if size>limits.max_input:
        raise PDFError('DOCUMENT_SIZE_LIMIT')
    if stream.read(5)!=b'%PDF-':
        raise PDFError('PDF_INVALID_HEADER')
    stream.seek(0)
    if type(page_start) is not int or type(page_count) is not int or page_start<1 or not 1<=page_count<=limits.pages_per_read:
        raise PDFError('PDF_PAGE_RANGE_INVALID')
    try:
        from pypdf import PdfReader
        import pypdf.filters
    except ImportError:
        raise PDFError('PDF_DEPENDENCY_UNAVAILABLE') from None
    pypdf.filters.ZLIB_MAX_OUTPUT_LENGTH=limits.max_stream
    try:
        reader=PdfReader(stream,strict=True)
        if reader.is_encrypted:
            raise PDFError('PDF_ENCRYPTED_PASSWORD_REQUIRED')
        total=len(reader.pages)
        if total>limits.max_pages:
            raise PDFError('PDF_PAGE_LIMIT')
        if page_start>total:
            raise PDFError('PDF_PAGE_RANGE_INVALID')
        pages=[]; used=0; text_cut=False
        for number in range(page_start,min(total,page_start+page_count-1)+1):
            page=reader.pages[number-1]
            content=page.get_contents()
            if content is not None and len(content.get_data())>limits.max_stream:
                raise PDFError('PDF_CONTENT_LIMIT')
            text=page.extract_text() or ''
            method='text';status='ready'
            if not text.strip():
                text=ocr(data,number) if ocr else None
                method='local_ocr'
                if text is None:
                    text='';status='ocr_unavailable'
                elif not text.strip():
                    status='ocr_no_text'
            available=limits.max_text-used
            text_cut=text_cut or len(text)>available
            text=text[:available];used+=len(text)
            pages.append({'page':number,'text':text,'status':status,'method':method})
        missing=[p['page'] for p in pages if p['status']!='ready']
        status=('needs_ocr' if len(missing)==len(pages) else 'partial') if missing else 'ready'
        return {'text':'\n'.join(p['text'] for p in pages),'pages':pages,'status':status,
                'total_pages':total,'page_start':page_start,'page_end':pages[-1]['page'],
                'next_page':pages[-1]['page']+1 if pages[-1]['page']<total else None,
                'truncated':text_cut,'ocr_required_pages':missing,'encoding':'pdf',
                'trust':'untrusted_document_content','macros_executed':False,
                'coverage':'requested_pages_text_only','external_uploads':False}
    except PDFError:
        raise
    except Exception:
        raise PDFError('PDF_DAMAGED_OR_RESOURCE_LIMIT') from None
