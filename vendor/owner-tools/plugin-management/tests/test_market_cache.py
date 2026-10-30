import importlib.util,json,tempfile,unittest,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('cache_worker',Path(__file__).resolve().parents[1]/'market_cache_worker.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory(prefix='synthetic-market-');self.addCleanup(self.temp.cleanup);self.request={'cacheDir':self.temp.name,'query':'synthetic'};self.raw=json.dumps({'items':[{'id':'synthetic','name':'Synthetic package','spec':'synthetic@1.0.0'}]}).encode()
 def fetch(self,*args):return self.raw,json.loads(self.raw)
 def offline(self,*args):raise m.Failure('NETWORK_TIMEOUT')
 def test_verified_fresh_and_explicit_stale_are_fast(self):
  r=m.search(self.request,self.fetch,1000);self.assertEqual(r['cacheStatus'],'network');self.assertEqual(r['total'],1)
  r=m.search(self.request,self.offline,1001);self.assertEqual(r['cacheStatus'],'fresh-cache');self.assertFalse(r['stale'])
  r=m.search(self.request,self.offline,1901);self.assertEqual(r['cacheStatus'],'stale-cache');self.assertTrue(r['stale']);self.assertTrue(r['refreshRequired'])
 def test_refresh_error_preserved_with_stale_data(self):
  m.search(self.request,self.fetch,1000);r=m.search({**self.request,'refresh':True},self.offline,1901);self.assertTrue(r['ok']);self.assertEqual(r['cacheStatus'],'cache-fallback');self.assertEqual(r['lastRefreshError']['code'],'NETWORK_TIMEOUT');self.assertEqual(r['total'],1)
 def test_no_cache_or_expired_does_not_report_empty_search(self):
  r=m.search(self.request,self.offline,1000);self.assertFalse(r['ok']);self.assertFalse(r['noResults'])
  m.search(self.request,self.fetch,1000);r=m.search(self.request,self.offline,1000+7*86400+1);self.assertFalse(r['ok'])
 def test_cache_corruption_is_not_trusted(self):
  m.search(self.request,self.fetch,1000);body,_=m.paths(Path(self.temp.name),m.SOURCES[0]);body.write_bytes(b'corrupt');r=m.search(self.request,self.offline,1001);self.assertFalse(r['ok']);self.assertFalse(r['noResults'])
 def test_unapproved_source_rejected_without_fetch(self):
  with self.assertRaisesRegex(m.Failure,'INDEX_NOT_CONFIGURED'):m.search({**self.request,'indexUrl':'https://unknown.invalid/mirror'},self.fetch,1000)
if __name__=='__main__':
 result=unittest.TextTestRunner(stream=sys.stdout,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Tests));sys.exit(0 if result.wasSuccessful()else 1)
