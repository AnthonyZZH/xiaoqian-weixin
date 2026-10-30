"""Stage a source-only RPC with explicit runtime assets; never copies live state.

Usage: stage-rpc.py RPC_SOURCE_ROOT POLICY_SNAPSHOT_ROOT NEW_DEST
       [--smoke-python ABSOLUTE_PYTHON]
RPC_SOURCE_ROOT contains driver/ and vendor/. POLICY_SNAPSHOT_ROOT contains
owner_wake_policy.py and its public calendar-2026.json. The optional smoke uses
the real staged JSONL process, synthetic state and a fake UI backend only.
"""
import argparse,ast,hashlib,json,shutil,subprocess,tempfile
from pathlib import Path

def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def stage(source,policy,destination):
 source=Path(source).resolve(strict=True);policy=Path(policy).resolve(strict=True);destination=Path(destination).resolve()
 if destination.exists():raise ValueError('DESTINATION_ALREADY_EXISTS')
 required=[source/'driver/bridge_rpc.py',policy/'owner_wake_policy.py',policy/'calendar-2026.json']
 if any(not p.is_file() or p.is_symlink() for p in required):raise ValueError('REQUIRED_RUNTIME_SOURCE_OR_ASSET_MISSING')
 calendar=json.loads(required[2].read_text(encoding='utf-8'))
 if not isinstance(calendar.get('verified_years'),list):raise ValueError('CALENDAR_CONTRACT_INVALID')
 destination.mkdir(parents=True)
 for folder in ['driver','vendor']:
  for p in (source/folder).rglob('*.py'):
   if '__pycache__' in p.parts:continue
   if p.is_symlink():raise ValueError('SOURCE_SYMLINK_DENIED')
   q=destination/p.relative_to(source);q.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,q)
 for name in ['owner_wake_policy.py','calendar-2026.json']:
  (destination/'vendor').mkdir(exist_ok=True);shutil.copyfile(policy/name,destination/'vendor'/name)
 resources=[]
 for p in destination.rglob('*.py'):
  tree=ast.parse(p.read_text(encoding='utf-8-sig'))
  for n in ast.walk(tree):
   if not (isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='with_name' and n.args and isinstance(n.args[0],ast.Constant) and isinstance(n.args[0].value,str)):continue
   if '__file__' not in ast.unparse(n.func.value):continue
   q=p.with_name(n.args[0].value)
   if not q.is_file():raise ValueError('STATIC_RUNTIME_ASSET_MISSING')
   resources.append(q.relative_to(destination).as_posix())
 manifest={p.relative_to(destination).as_posix():digest(p) for p in destination.rglob('*') if p.is_file()}
 return {'files':manifest,'staticResources':sorted(set(resources))}

def smoke(destination,python):
 destination=Path(destination).resolve(strict=True)
 with tempfile.TemporaryDirectory(prefix='rpc-smoke-') as temporary:
  r=Path(temporary)
  cfg={'mode':'fake','allow_real':False,'state_dir':str(r/'driver'),'media_root':str(r/'media'),'schedule_path':str(r/'schedule.sqlite3'),
       'chats':[{'id':'synthetic-owner','title':'SYNTHETIC ONLY','mode':'private','owner':True}],
       'time_zone':'Asia/Shanghai','initiative':{'initiative_enabled':False},'fake_options':{},'command_timeout':2}
  frames=[{'id':'init','operation':'initialize','args':{'config':cfg}},{'id':'health','operation':'health','args':{}},{'id':'close','operation':'close','args':{}}]
  p=subprocess.run([str(python),'-X','utf8','-u','-B',str(destination/'driver/bridge_rpc.py')],input=''.join(json.dumps(f)+'\n' for f in frames),text=True,encoding='utf-8',capture_output=True,timeout=15)
  if p.returncode:raise RuntimeError('STAGED_RPC_IMPORT_OR_PROCESS_FAILED')
  rows=[json.loads(x) for x in p.stdout.splitlines() if x.strip()]
  if len(rows)!=3 or [x.get('id') for x in rows]!=['init','health','close'] or any(x.get('status')!='ok' for x in rows):raise RuntimeError('STAGED_RPC_HANDSHAKE_FAILED')
  if rows[0].get('code')!='DRIVER_READY' or rows[2].get('code')!='CLOSED':raise RuntimeError('STAGED_RPC_LIFECYCLE_FAILED')
  return {'passed':True,'mode':'fake-ui-real-rpc-process','stderrBytes':len(p.stderr.encode()),'modelCalls':0,'wechatUiStarted':False}

if __name__=='__main__':
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('source');ap.add_argument('policy');ap.add_argument('destination');ap.add_argument('--smoke-python')
 a=ap.parse_args();result=stage(a.source,a.policy,a.destination)
 if a.smoke_python:result['smoke']=smoke(a.destination,a.smoke_python)
 (Path(a.destination)/'rpc-source-manifest.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
 print(json.dumps({'files':len(result['files']),'staticResources':result['staticResources'],'smoke':result.get('smoke')}))
