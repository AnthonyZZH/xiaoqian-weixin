import unittest,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))

from pricing import quote,rates_bounds,search_fetch_cost,SNAPSHOT_ID
from usage import Hold
from decimal import Decimal as D
class PricingTests(unittest.TestCase):
 def test_exact_flash_rates(self):
  c=quote('deepseek-flash');r=rates_bounds(c,'peak','2026-11-02T05:00:00Z')
  self.assertEqual(r,{'hit':(D('.04'),D('.04')),'miss':(D(2),D(2)),'output':(D(8),D(8))})
  self.assertEqual(rates_bounds(c,'offpeak','2026-11-02T05:00:00Z')['output'],(D(4),D(4)))
 def test_exact_pro_and_unknown_band(self):
  r=rates_bounds(quote('deepseek-v4-pro'),'unknown','2026-11-02T05:00:00Z')
  self.assertEqual(r,{'hit':(D('.15'),D('.30')),'miss':(D('4.5'),D('9')),'output':(D('13.5'),D(27))})
 def test_internal_review_due_is_not_expiry(self):
  c=quote('deepseek-flash');self.assertIsNone(c['official_valid_until'])
  rates_bounds(c,'peak','2026-11-05T00:00:00Z')
  with self.assertRaisesRegex(Hold,'LOCAL_REVIEW_OVERDUE'):rates_bounds(c,'peak','2026-11-09T04:56:39Z')
 def test_no_backdating_model_snapshot(self):
  with self.assertRaisesRegex(Hold,'NOT_OBSERVED'):rates_bounds(quote('deepseek-flash'),'peak','2026-10-30T00:00:00Z')
 def test_no_guessed_alias_or_unchecked_currency(self):
  for m,c in [('deepseek-chat','CNY'),('deepseek-v4-flash','CNY'),('deepseek-flash','USD')]:
   with self.assertRaises(Hold):quote(m,c)
 def test_tamper_fails_closed(self):
  c=quote('deepseek-flash');c['rates']['peak']['miss']='0'
  with self.assertRaisesRegex(Hold,'CONTENT_CHANGED'):rates_bounds(c,'peak','2026-11-02T05:00:00Z')
 def test_tool_boundary_and_decimals(self):
  self.assertEqual(search_fetch_cost('2026-10-31T15:59:59Z',search=3),D(0))
  self.assertEqual(search_fetch_cost('2026-10-31T16:00:00Z',search=1,fetch=1),D('.010'))
  self.assertEqual(search_fetch_cost('2026-11-02T05:00:00Z',search=1,fetch=2),D('.015'))
 def test_direct_api_does_not_get_server_free_period(self):
  with self.assertRaisesRegex(Hold,'HISTORICAL_DIRECT'):search_fetch_cost('2026-10-31T15:00:00Z',search=1,access_path='direct_api')
  self.assertEqual(search_fetch_cost('2026-11-02T05:00:00Z',fetch=1,access_path='direct_api'),D('.005'))
 def test_invalid_asof_and_unknown_counts(self):
  for v in [-1,True,None]:
   with self.assertRaises(Hold):search_fetch_cost('2026-11-02T05:00:00Z',search=v)
  with self.assertRaisesRegex(Hold,'ZONE_REQUIRED'):rates_bounds(quote('deepseek-flash'),'peak','2026-11-02T05:00:00')
if __name__=='__main__':unittest.main()

