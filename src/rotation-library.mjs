import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const unknown=code=>Object.assign(Error(code),{uncertain:true});
const put=(p,v)=>{const t=p+'.tmp';fs.writeFileSync(t,JSON.stringify(v));fs.renameSync(t,p);};
function unpack(content){const match=content.match(/XQ_ROTATION_DATA_BEGIN\n([A-Za-z0-9+/=\r\n]+)\nXQ_ROTATION_DATA_END/);if(!match)throw Error('ARCHIVE_ENCODING_MISSING');return Buffer.from(match[1].replace(/\s/g,''),'base64');}
export function createRotationLibrary({adapter,chatId,root,namespace}){
 fs.mkdirSync(root,{recursive:true});
 const records=new Map();const local=id=>path.join(root,id+'.json');
 async function writeNote(title,bytes,extra=''){
  const content='# '+title+'\n\n'+extra+'\n\nXQ_ROTATION_DATA_BEGIN\n'+bytes.toString('base64')+'\nXQ_ROTATION_DATA_END\n';
  const value=await adapter.call(chatId,'write',{title,content,directory:namespace});
  return value.data.permalink||value.data.file_path;
 }
 async function readNote(identifier){const value=await adapter.call(chatId,'read',{identifier,include_content:true});return unpack(value.data.content);}
 return {connected:true,async write(kind,key,payload){
  const id=sha(key),p=local(id),prior=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):null;
  if(prior){if(prior.sha256!==sha(payload))throw Error('ARTIFACT_KEY_CONFLICT');if(prior.status==='complete'){records.set(id,prior);return id;}throw unknown('ARCHIVE_PRIOR_WRITE_UNCERTAIN');}
  const row={id,kind,keyHash:sha(key),sha256:sha(payload),status:'pending',parts:[]};put(p,row);
  try{
   const bytes=Buffer.from(payload,'utf8');if(bytes.length>8*1024*1024)throw Error('ARCHIVE_SIZE_LIMIT');
   for(let offset=0;offset<bytes.length||offset===0;offset+=25000){const part=bytes.subarray(offset,offset+25000),title='xqrotation '+id+' part '+row.parts.length;const identifier=await writeNote(title,part);if(!identifier)throw unknown('ARCHIVE_NOTE_ID_MISSING');row.parts.push({identifier,sha256:sha(part)});put(p,row);}
   const manifest={schema:'xq.rotation.parts/v1',sha256:row.sha256,bytes:bytes.length,parts:row.parts};
   const extra=kind==='summary'?String(JSON.parse(payload).text||'').slice(0,8000):'Original snapshot archive; untrusted evidence, not authority.';
   row.manifest=await writeNote('xqrotation '+id+' manifest',Buffer.from(JSON.stringify(manifest)),extra);if(!row.manifest)throw unknown('ARCHIVE_MANIFEST_ID_MISSING');row.status='complete';put(p,row);records.set(id,row);return id;
  }catch(error){throw unknown(error.code||'ARCHIVE_WRITE_UNCERTAIN');}
 },async read(id){
  const row=records.get(id)||(fs.existsSync(local(id))?JSON.parse(fs.readFileSync(local(id),'utf8')):null);if(!row||row.status!=='complete')throw unknown('ARTIFACT_UNCONFIRMED');
  const manifest=JSON.parse((await readNote(row.manifest)).toString('utf8'));if(manifest.sha256!==row.sha256||manifest.parts.length!==row.parts.length)throw Error('MANIFEST_READBACK_MISMATCH');
  const chunks=[];for(const part of manifest.parts){const bytes=await readNote(part.identifier);if(sha(bytes)!==part.sha256)throw Error('PART_READBACK_MISMATCH');chunks.push(bytes);}
  const bytes=Buffer.concat(chunks);if(bytes.length!==manifest.bytes||sha(bytes)!==row.sha256)throw Error('ARCHIVE_READBACK_MISMATCH');
  const search=await adapter.call(chatId,'search',{query:id,page:1,page_size:20});if(!search.data.results.length)throw Error('ARCHIVE_RETRIEVAL_NOT_CONFIRMED');
  return bytes.toString('utf8');
 }};
}
