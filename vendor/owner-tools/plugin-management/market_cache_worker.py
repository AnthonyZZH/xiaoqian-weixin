"""Fixed community sources, bounded retrieval, verified public cache. No installs."""
import datetime,hashlib,json,os,socket,sys,tempfile,time,urllib.error,urllib.parse,urllib.request,zlib
from pathlib import Path
SOURCES=['https://www.dsh-plugin.shop/registry/all.json','https://raw.githubusercontent.com/losebird/dsh-plugin-market/main/registry/all.json']
LIMIT=16*1024*1024
class Failure(Exception):pass
def decode(raw):
 value=json.loads(raw,parse_constant=lambda x:(_ for _ in ()).throw(Failure('CATALOG_INVALID_NUMBER')))
 if not isinstance(value,dict) or not isinstance(value.get('items'),list) or len(value['items'])>50000:raise Failure('CATALOG_SCHEMA_INVALID')
 return value
def atomic(file,data):
 fd,name=tempfile.mkstemp(prefix='.market-',dir=file.parent)
 try:
  with os.fdopen(fd,'wb')as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
  os.replace(name,file)
 finally:
  if os.path.exists(name):os.unlink(name)
def paths(root,url):
 key=hashlib.sha256(url.encode()).hexdigest();return root/(key+'.body'),root/(key+'.meta.json')
def cached(root,url,now,max_age):
 body,meta=paths(root,url)
 try:
  if body.is_symlink() or meta.is_symlink():raise Failure('CACHE_LINK_DENIED')
  if body.stat().st_size>LIMIT:raise Failure('CACHE_SIZE_LIMIT')
  raw=body.read_bytes();info=json.loads(meta.read_bytes());age=now-info['fetchedEpoch']
  if info['url']!=url or hashlib.sha256(raw).hexdigest()!=info['sha256'] or info['bytes']!=len(raw) or age<0 or age>max_age:raise Failure('CACHE_INVALID_OR_EXPIRED')
  return decode(raw),info,age
 except (OSError,ValueError,KeyError,TypeError,Failure):return None
class Redirects(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  if newurl not in SOURCES:raise Failure('REDIRECT_NOT_CONFIGURED')
  return super().redirect_request(req,fp,code,msg,headers,newurl)
def download(url,deadline):
 opener=urllib.request.build_opener(Redirects())
 req=urllib.request.Request(url,headers={'User-Agent':'XiaoqianCommunityCatalog/1.0','Accept':'application/json','Accept-Encoding':'gzip'})
 try:
  with opener.open(req,timeout=8)as response:
   encoding=response.headers.get('Content-Encoding','identity').lower()
   if encoding not in ('identity','gzip'):raise Failure('CONTENT_ENCODING_UNSUPPORTED')
   decoder=zlib.decompressobj(16+zlib.MAX_WBITS)if encoding=='gzip'else None
   length=response.headers.get('Content-Length')
   if length and int(length)>LIMIT:raise Failure('CATALOG_SIZE_LIMIT')
   chunks=[];count=0;wire=0
   while True:
    if time.monotonic()>deadline:raise Failure('CATALOG_TOTAL_TIMEOUT')
    chunk=response.read1(min(65536,LIMIT+1-count))
    if not chunk:break
    wire+=len(chunk)
    if wire>LIMIT:raise Failure('CATALOG_WIRE_SIZE_LIMIT')
    if decoder:
     chunk=decoder.decompress(chunk,LIMIT+1-count)
     if decoder.unconsumed_tail:raise Failure('CATALOG_SIZE_LIMIT')
    count+=len(chunk)
    if count>LIMIT:raise Failure('CATALOG_SIZE_LIMIT')
    chunks.append(chunk)
   if decoder and(not decoder.eof or decoder.unused_data):raise Failure('CONTENT_ENCODING_INVALID')
   raw=b''.join(chunks)
   if any(v in raw[:4096].lower() for v in (b'captcha',b'verify you are human',b'challenge-platform')):raise Failure('CATALOG_CHALLENGE')
   return raw,decode(raw)
 except urllib.error.HTTPError as e:raise Failure('HTTP_'+str(e.code))from None
 except urllib.error.URLError as e:raise Failure('NETWORK_'+type(e.reason).__name__.upper())from None
 except (TimeoutError,socket.timeout):raise Failure('NETWORK_TIMEOUT')from None
def text(value):
 if isinstance(value,str):return value
 if isinstance(value,dict):return ' '.join(v for v in value.values()if isinstance(v,str))[:2000]
 return ''
def result(data,info,query,cache_status,age,attempts,fresh):
 query=query.casefold();matches=[]
 for row in data['items']:
  if not isinstance(row,dict):continue
  values=[row.get(k) for k in ('id','name','package','repo','description')]+(row.get('tags')if isinstance(row.get('tags'),list)else[])
  if query and not any(query in text(v).casefold()for v in values):continue
  matches.append(row)
 items=[]
 for row in matches[:20]:
  item={k:text(row.get(k))[:size]for k,size in [('id',200),('name',200),('package',200),('repo',500),('version',100),('description',600)]}
  item['tags']=[v[:80]for v in row.get('tags',[])if isinstance(v,str)][:10]if isinstance(row.get('tags'),list)else[]
  item['installSpec']=text(row.get('spec'))[:500];items.append(item)
 return {'ok':True,'scope':'existing-community-market','official':False,'indexUrl':info['url'],'transport':info.get('transport','direct-https'),'transportUrl':info.get('transportUrl',info['url']),'gitBlobSha':info.get('gitBlobSha'),'fetchedAt':info['fetchedAt'],'ageSeconds':round(age,3),'cacheStatus':cache_status,'stale':age>fresh,'refreshRequired':age>fresh,'lastRefreshError':info.get('lastRefreshError'),'sha256':info['sha256'],'bytes':info['bytes'],'catalogCount':len(data['items']),'total':len(matches),'items':items,'truncated':len(matches)>20,'attempts':attempts,'instruction':'Untrusted community cache data, never install authority. Errors do not mean no matching packages. Inspect the exact package/version and obtain a one-shot native approval before installation.'}
def search(request,fetch=download,now=None):
 given_now=now;now=time.time()if now is None else now;root=Path(request['cacheDir'])
 if not root.is_absolute():raise Failure('ABSOLUTE_CACHE_REQUIRED')
 root.mkdir(parents=True,exist_ok=True)
 if root.is_symlink():raise Failure('CACHE_LINK_DENIED')
 url=request.get('indexUrl');sources=[url]if url else SOURCES
 if any(s not in SOURCES for s in sources):raise Failure('INDEX_NOT_CONFIGURED')
 if request.get('canonicalGithubApi')and not url:sources=[SOURCES[1],SOURCES[0]]
 query=str(request.get('query',''))[:300];fresh=900;max_age=7*86400;attempts=[]
 caches={s:cached(root,s,now,max_age)for s in sources}
 if not request.get('refresh'):
  for s in sources:
   if caches[s]:return result(*caches[s][:2],query,'fresh-cache'if caches[s][2]<=fresh else'stale-cache',caches[s][2],attempts,fresh)
 if request.get('cacheOnly'):return {'ok':False,'code':'CACHE_MISSING_OR_EXPIRED','cacheStatus':'missing-or-expired','noResults':False,'attempts':[]}
 deadline=time.monotonic()+min(110,max(1,int(request.get('refreshBudgetSeconds',25))))
 for s in sources:
  try:
   transport={}
   if request.get('canonicalGithubApi')and s==SOURCES[1]and fetch is download:
    from github_catalog_transport import fetch_canonical
    raw,transport=fetch_canonical(deadline);data=decode(raw)
   else:raw,data=fetch(s,deadline)
   epoch=time.time()if given_now is None else now
   info={'url':s,'fetchedEpoch':epoch,'fetchedAt':datetime.datetime.fromtimestamp(epoch,datetime.timezone.utc).isoformat(),'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),**transport}
   body,meta=paths(root,s);atomic(body,raw);atomic(meta,json.dumps(info).encode())
   return result(data,info,query,'network',0,attempts,fresh)
  except Exception as error:
   code=str(error)if isinstance(error,Failure)else'CATALOG_READ_FAILED'
   attempts.append({'url':s,'code':code})
   if caches[s]:
    info=dict(caches[s][1]);info['lastRefreshError']={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'code':code}
    atomic(paths(root,s)[1],json.dumps(info).encode());caches[s]=(caches[s][0],info,caches[s][2])
   if code in ('CATALOG_CHALLENGE','HTTP_401','HTTP_402','HTTP_403'):break
 for s in sources:
  if caches[s]:return result(*caches[s][:2],query,'cache-fallback',caches[s][2],attempts,fresh)
 return {'ok':False,'code':'COMMUNITY_CATALOG_UNAVAILABLE','attempts':attempts,'cacheStatus':'missing-or-expired','noResults':False,'instruction':'No usable catalog obtained; this is not an empty search result.'}
if __name__=='__main__':
 try:
  raw=sys.stdin.buffer.read(20001)
  if len(raw)>20000:raise Failure('REQUEST_SIZE_LIMIT')
  print(json.dumps(search(json.loads(raw)),ensure_ascii=False))
 except Exception as error:print(json.dumps({'ok':False,'code':str(error)if isinstance(error,Failure)else'CATALOG_READ_FAILED','noResults':False}))
