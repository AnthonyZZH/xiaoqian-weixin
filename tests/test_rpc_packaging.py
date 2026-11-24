import importlib.util,json,sys,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('stage_rpc',Path(__file__).resolve().parents[1]/'tools/stage-rpc.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Packaging(unittest.TestCase):
 def fixture(self,r,with_calendar=True):
  source=r/'source';policy=r/'app/vendor';(source/'driver').mkdir(parents=True);(source/'vendor').mkdir();(policy/'xiaoqian_schedule').mkdir(parents=True)
  (policy/'xiaoqian_schedule/price-card.json').write_text('{}')
  (policy/'owner_wake_policy.py').write_text("import json\nfrom pathlib import Path\nCALENDAR=json.loads(Path(__file__).with_name('calendar-2026.json').read_text())\n")
  if with_calendar:(policy/'calendar-2026.json').write_text(json.dumps({'verified_years':[2026]}))
  (source/'driver/bridge_rpc.py').write_text("import sys,json\nfrom pathlib import Path\nsys.path.insert(0,str(Path(__file__).resolve().parent.parent/'vendor'))\nimport owner_wake_policy\nfor line in sys.stdin:\n r=json.loads(line);op=r['operation'];print(json.dumps({'id':r['id'],'status':'ok','code':{'initialize':'DRIVER_READY','health':'HEALTHY','close':'CLOSED'}[op]}),flush=True)\n")
  return source,policy
 def test_missing_asset_fails_before_destination_creation(self):
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);s,p=self.fixture(r,False)
   with self.assertRaisesRegex(ValueError,'REQUIRED_RUNTIME'):m.stage(s,p,r/'output')
   self.assertFalse((r/'output').exists())
 def test_final_staged_import_and_handshake(self):
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);s,p=self.fixture(r);result=m.stage(s,p,r/'output')
   self.assertIn('vendor/owner_wake_policy.py',result['files'])
   self.assertNotIn('vendor/calendar-2026.json',result['files'])
   self.assertEqual(result['staticResources'],[])
   self.assertTrue(m.smoke(r/'output',sys.executable)['passed'])
 def test_no_state_or_arbitrary_json_copied(self):
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);s,p=self.fixture(r);(s/'vendor/private.json').write_text('SYNTHETIC NOT FOR COPYING')
   (s/'vendor/driver.sqlite3').write_bytes(b'SYNTHETIC')
   result=m.stage(s,p,r/'output')
   self.assertNotIn('vendor/private.json',result['files']);self.assertNotIn('vendor/driver.sqlite3',result['files'])

 def test_missing_referenced_asset_leaves_destination_retryable(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);source,policy=self.fixture(root)
   (source/'vendor/reader.py').write_text("from pathlib import Path\nasset=Path(__file__).with_name('asset.zip')\n")
   with self.assertRaisesRegex(ValueError,'STATIC_RUNTIME_ASSET_MISSING'):
    m.stage(source,policy,root/'rpc')
   self.assertFalse((root/'rpc').exists())
   (source/'vendor/asset.zip').write_bytes(b'SYNTHETIC')
   result=m.stage(source,policy,root/'rpc',smoke_python=sys.executable)
   self.assertEqual(result['staticResources'],['vendor/asset.zip'])
   self.assertTrue(result['smoke']['passed'])

if __name__=='__main__':unittest.main(verbosity=2)
