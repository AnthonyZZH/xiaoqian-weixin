"""Optional official GitHub API transport of the SAME configured repository file.
No token, unknown mirror, new catalog or package installation. Blob SHA verified.
"""
import hashlib,json,re,time,urllib.request,zlib
LIMIT=16*1024*1024
META='https://api.github.com/repos/losebird/dsh-plugin-market/contents/registry/all.json?ref=main'
def fetch_canonical(deadline):
 def read(url,accept,limit):
  if time.monotonic()>=deadline:raise ValueError('GITHUB_DEADLINE')
  req=urllib.request.Request(url,headers={'User-Agent':'XiaoqianPublicCatalog/1.0','Accept':accept,'Accept-Encoding':'gzip'})
  with urllib.request.urlopen(req,timeout=8)as response:
   encoding=response.headers.get('Content-Encoding','identity').lower()
   if encoding not in ('identity','gzip'):raise ValueError('GITHUB_ENCODING')
   decoder=zlib.decompressobj(16+zlib.MAX_WBITS)if encoding=='gzip'else None
   chunks=[];count=0;wire=0
   while True:
    if time.monotonic()>=deadline:raise ValueError('GITHUB_DEADLINE')
    chunk=response.read1(65536)
    if not chunk:break
    wire+=len(chunk)
    if wire>LIMIT:raise ValueError('GITHUB_WIRE_LIMIT')
    if decoder:
     chunk=decoder.decompress(chunk,limit+1-count)
     if decoder.unconsumed_tail:raise ValueError('GITHUB_EXPANSION_LIMIT')
    count+=len(chunk)
    if count>limit:raise ValueError('GITHUB_SIZE_LIMIT')
    chunks.append(chunk)
   if decoder and(not decoder.eof or decoder.unused_data):raise ValueError('GITHUB_ENCODING')
   return b''.join(chunks)
 metadata=json.loads(read(META,'application/vnd.github+json',65536))
 sha=metadata.get('sha','')
 if metadata.get('type')!='file'or metadata.get('path')!='registry/all.json'or not re.fullmatch('[a-f0-9]{40}',sha)or not 0<metadata.get('size',0)<=LIMIT:raise ValueError('GITHUB_METADATA_INVALID')
 url='https://api.github.com/repos/losebird/dsh-plugin-market/git/blobs/'+sha
 body=read(url,'application/vnd.github.raw+json',LIMIT)
 calculated=hashlib.sha1(b'blob '+str(len(body)).encode()+b'\0'+body,usedforsecurity=False).hexdigest()
 if len(body)!=metadata['size']or calculated!=sha:raise ValueError('GITHUB_BLOB_MISMATCH')
 return body,{'transport':'github-official-api','transportUrl':url,'gitBlobSha':sha}
