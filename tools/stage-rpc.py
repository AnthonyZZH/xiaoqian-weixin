"""Stage a source-only RPC with explicit runtime assets; never copies live state.

Usage: stage-rpc.py RPC_SOURCE_ROOT APP_VENDOR_ROOT NEW_DEST
       [--smoke-python ABSOLUTE_PYTHON]
RPC_SOURCE_ROOT contains driver/ and vendor/. APP_VENDOR_ROOT must be the
sibling app/vendor of NEW_DEST; RPC delegates to that canonical policy. The optional smoke uses
the real staged JSONL process, synthetic state and a fake UI backend only.
"""
import argparse,ast,hashlib,json,shutil,subprocess,tempfile
from pathlib import Path

def adjacent_assets(module):
    """Find literal Path(__file__).with_name('asset') references in a source module."""
    tree = ast.parse(module.read_text(encoding="utf-8-sig"))
    for call in ast.walk(tree):
        if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Attribute):
            continue
        if call.func.attr != "with_name" or "__file__" not in ast.unparse(call.func.value):
            continue
        if call.args and isinstance(call.args[0], ast.Constant) and isinstance(call.args[0].value, str):
            yield module.with_name(call.args[0].value)


def stage(source, policy, destination, *, smoke_python=None):
    source = Path(source).resolve(strict=True)
    policy = Path(policy).resolve(strict=True)
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError("DESTINATION_ALREADY_EXISTS")
    if policy != destination.parent / "app/vendor":
        raise ValueError("CANONICAL_SIBLING_APP_VENDOR_REQUIRED")
    shim = Path(__file__).with_name("rpc-policy-shim.py")
    calendar = policy / "calendar-2026.json"
    required = [source / "driver/bridge_rpc.py", policy / "owner_wake_policy.py",
                calendar, policy / "xiaoqian_schedule/price-card.json", shim]
    if any(not item.is_file() or item.is_symlink() for item in required):
        raise ValueError("REQUIRED_RUNTIME_SOURCE_OR_ASSET_MISSING")
    if not isinstance(json.loads(calendar.read_text(encoding="utf-8")).get("verified_years"), list):
        raise ValueError("CALENDAR_CONTRACT_INVALID")

    policy_path = Path("vendor/owner_wake_policy.py")
    files = {policy_path: shim}
    resources = set()
    for folder in ["driver", "vendor"]:
        for module in (source / folder).rglob("*.py"):
            relative = module.relative_to(source)
            if relative == policy_path or {"test", "tests", "__pycache__"}.intersection(relative.parts):
                continue
            if relative.as_posix() == "vendor/xiaoqian_schedule/demo.py":
                continue
            if module.is_symlink():
                raise ValueError("SOURCE_SYMLINK_DENIED")
            files[relative] = module
            for asset in adjacent_assets(module):
                if not asset.is_file() or asset.is_symlink():
                    raise ValueError("STATIC_RUNTIME_ASSET_MISSING")
                asset_path = asset.relative_to(source)
                files[asset_path] = asset
                resources.add(asset_path.as_posix())

    # The temporary RPC is a sibling of app/, so the smoke check resolves the
    # same policy it will use after rename. A failed build remains retryable.
    with tempfile.TemporaryDirectory(dir=destination.parent, prefix=".rpc-stage-") as scratch:
        output = Path(scratch)
        manifest = {}
        for relative, original in sorted(files.items()):
            target = output / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, target)
            manifest[relative.as_posix()] = hashlib.sha256(target.read_bytes()).hexdigest()
        result = {"files": manifest, "staticResources": sorted(resources)}
        if smoke_python:
            result["smoke"] = smoke(output, smoke_python)
        output.rename(destination)
    return result

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
 a=ap.parse_args();result=stage(a.source,a.policy,a.destination,smoke_python=a.smoke_python)
 (Path(a.destination)/'rpc-source-manifest.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
 print(json.dumps({'files':len(result['files']),'staticResources':result['staticResources'],'smoke':result.get('smoke')}))
