import argparse,json,sys,hashlib
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
parser=argparse.ArgumentParser();parser.add_argument('--media-root',required=True);parser.add_argument('--collection',required=True);parser.add_argument('--site-packages',required=True)
args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,args.site_packages);sys.path.insert(0,str(root/'vendor'));sys.path.insert(0,str(root/'vendor/remote-import'))
from xiaoqian_media import MediaLibrary
from remote_import import import_url
try:
 raw=sys.stdin.buffer.read(100001)
 if len(raw)>100000:raise ValueError('request_limit')
 request=json.loads(raw.decode('utf-8'))
 folder=Path(args.media_root)/args.collection
 if not (folder/'index.json').is_file():raise ValueError('existing_owner_library_required')
 library=MediaLibrary(args.media_root,args.collection)
 if request.get('probe') is True:
  with library._operation():records=library._load()
  print(json.dumps({'ok':True,'probe':True,'records':len(records)}));raise SystemExit()
 row=import_url(library,request['url'],description=request.get('description',''),tags=tuple(request.get('tags',[])),timeout=15)
 pending=library.search(request.get('description',''),status=row.status,limit=100)
 with library._operation():records=library._load()
 print(json.dumps({'ok':True,'id':row.media_id,'record':row.to_dict(),'catalogEntryPresent':any(x.media_id==row.media_id for x in pending),'counts':{'records':len(records),'kept':sum(x.status=='kept' for x in records.values()),'pending':sum(x.status=='pending' for x in records.values())}},ensure_ascii=False))
except Exception as error:
 print(json.dumps({'ok':False,'code':type(error).__name__,'outcome':'unknown','instruction':'Query the owner pending catalog before any retry; no automatic resend.'}))
