import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {createAttachmentRegistry,createOwnerToolkit} from '../../vendor/owner-tools/index.mjs';

function syntheticPDF(){
 const stream='BT /F1 12 Tf 20 100 Td (HelloPDF) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 let result='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(result));result+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
 const start=Buffer.byteLength(result);result+='xref\n0 6\n0000000000 65535 f \n';for(const offset of offsets.slice(1))result+=`${String(offset).padStart(10,'0')} 00000 n \n`;
 result+=`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(result);
}
test('registered synthetic PDF uses default local worker and owner tool with page bounds',async t=>{
 assert.ok(process.env.XQ_TEST_PYTHON,'Set XQ_TEST_PYTHON to the Python with requirements-windows.txt installed');
 const parent=path.join(import.meta.dirname,'temporary-pdf');fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'case-'));
 t.after(()=>{assert.equal(path.dirname(path.resolve(root)),parent);fs.rmSync(root,{recursive:true,force:true});});
 const file=path.join(root,'synthetic.pdf');fs.writeFileSync(file,syntheticPDF());
 const registry=createAttachmentRegistry({root}),binding='synthetic-owner-binding',agent={};let active=true;
 const descriptor=registry.register({absolutePath:file,ownerBindingId:binding,displayName:'synthetic.pdf',sourceMessageId:'a'.repeat(64)});
 const kit=await createOwnerToolkit({isCurrentOwner:({agent:a,bindingId})=>active&&a===agent&&bindingId===binding,attachments:registry,python:process.env.XQ_TEST_PYTHON});
 const owner=kit.bind({agent,bindingId:binding}),exec={agent,signal:new AbortController().signal,callId:'synthetic-pdf-read'};
 const result=await owner.execute('owner_attachment_read',{attachmentId:descriptor.id,pageStart:1,pageCount:1},exec);
 assert.equal(result.text,'HelloPDF');assert.equal(result.total_pages,1);assert.equal(result.text.length,8);assert.equal(result.external_uploads,false);assert.equal(result.trust,'untrusted_document_content');
 await assert.rejects(owner.execute('owner_attachment_read',{attachmentId:descriptor.id,pageStart:2,pageCount:1},exec),/PDF_PAGE_RANGE_INVALID/);
 await assert.rejects(owner.execute('owner_attachment_read',{attachmentId:descriptor.id}, {...exec,agent:{}}),/OWNER_AGENT_MISMATCH/);
 active=false;await assert.rejects(owner.execute('owner_attachment_read',{attachmentId:descriptor.id},exec),/OWNER_AUTHORITY_REVOKED/);
});
