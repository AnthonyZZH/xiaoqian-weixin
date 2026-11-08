"""Synthetic-only reader tests; run with python -B app/test/attachment_readers.py."""
import io
import sys
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor' / 'owner-tools'))
from document_reader import document, DocumentError, MAX_TEXT


def archive(files):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, text in files.items():
            z.writestr(name, text)
    return out.getvalue()


class Readers(unittest.TestCase):
    def test_plain(self):
        for ext in ['.txt', '.md', '.csv', '.json']:
            with self.subTest(ext=ext):
                self.assertEqual(document('SYNTHETIC 中文'.encode(), ext)['text'], 'SYNTHETIC 中文')
        self.assertEqual(document('SYNTHETIC 中文'.encode('utf-16'), '.txt')['text'], 'SYNTHETIC 中文')

    def test_docx(self):
        data = archive({'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>SYNTHETIC DOCX</w:t></w:r></w:p></w:body></w:document>'})
        self.assertIn('SYNTHETIC DOCX', document(data, '.docx')['text'])

    def test_xlsx(self):
        ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
        data = archive({'xl/sharedStrings.xml': '<sst xmlns="'+ns+'"><si><t>SYNTHETIC XLSX</t></si></sst>',
                        'xl/worksheets/sheet1.xml': '<worksheet xmlns="'+ns+'"><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><f>1+1</f><v>2</v></c><c r="C1" t="inlineStr"><is><t>INLINE</t></is></c></row></sheetData></worksheet>'})
        result = document(data, '.xlsx')['text']
        self.assertIn('A1=SYNTHETIC XLSX\tB1=2\tC1=INLINE', result)

    def test_pptx(self):
        data = archive({'ppt/slides/slide2.xml': '<a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>SECOND</a:t></a:p>',
                        'ppt/slides/slide1.xml': '<a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>FIRST</a:t></a:p>'})
        result = document(data, '.pptx')['text']
        self.assertLess(result.index('FIRST'), result.index('SECOND'))

    def test_zip(self):
        result = document(archive({'notes.md': 'SYNTHETIC ZIP', 'data.csv': 'a,b', '../listed.txt': 'TEXT WITHOUT EXTRACTION', 'skip.exe': b'BINARY'}), '.zip')
        self.assertIn('SYNTHETIC ZIP', result['text'])
        self.assertEqual(len(result['entries']), 4)
        self.assertFalse(result['entries'][-1]['read'])
        self.assertNotIn('BINARY', result['text'])

    def test_pdf(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor' / 'owner-tools' / 'pdf-deps.zip'))
        from pypdf import PdfWriter
        from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
        writer = PdfWriter()
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
        page = writer.add_blank_page(300, 300)
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
        stream = DecodedStreamObject();stream.set_data(b'BT /F1 12 Tf 20 200 Td (SYNTHETIC PDF) Tj ET')
        page[NameObject('/Contents')] = writer._add_object(stream)
        out = io.BytesIO();writer.write(out)
        self.assertIn('SYNTHETIC PDF', document(out.getvalue(), '.pdf')['text'])
        for _ in range(20):writer.add_blank_page(300, 300)
        out = io.BytesIO();writer.write(out)
        self.assertTrue(document(out.getvalue(), '.pdf')['truncated'])

    def test_truncation(self):
        result = document(b'x' * (MAX_TEXT + 1), '.txt')
        self.assertTrue(result['truncated']);self.assertEqual(len(result['text']), MAX_TEXT)
        result = document(archive({str(i)+'.txt': 'x' for i in range(201)}), '.zip')
        self.assertTrue(result['truncated']);self.assertEqual(len(result['entries']), 200)

    def test_rejections(self):
        with self.assertRaises(DocumentError):document(b'\x00', '.txt')
        with self.assertRaises(DocumentError):document(b'abc', '.exe')
        with self.assertRaises(DocumentError):
            document(archive({'word/document.xml': '<!DOCTYPE x [<!ENTITY e "bad">]><x>&e;</x>'}), '.docx')


if __name__ == '__main__':
    unittest.main()
