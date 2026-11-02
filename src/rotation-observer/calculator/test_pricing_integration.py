"""Synthetic pricing/usage integration; no network or paid calls."""
import contextlib,io,json,runpy,sys,unittest
from pathlib import Path
from decimal import Decimal as D
sys.path.insert(0,str(Path(__file__).resolve().parent))
from pricing import quote,rates_bounds,search_fetch_cost
from usage import Hold,normalize,actual_cost
NOW='2026-11-02T05:00:00Z'
BASE=dict(model='deepseek-flash',ratio_min=1,ratio_max=1,ratio_median=1,observed_hit_fraction=1,retained_units_lower=1,retained_units_upper=1,summary_input_units_lower=0,summary_input_units_upper=0,reload_units_lower=0,reload_units_upper=0,reload_components={'fixed':0},summary_components={'output_tokens_hard_cap':1024},retrieval_scope='synthetic',retrieval_call_budget_enforced=True,runtime_injection_policy={'enforced':True})
def calculate(changes=None,at=NOW):
 request={'as_of':at,'dimensions':dict(BASE,**(changes or {}))}
 out=io.StringIO()
 with contextlib.redirect_stdout(out),contextlib.redirect_stderr(io.StringIO()):
  prior=sys.stdin
  try:
   sys.stdin=io.StringIO(json.dumps(request)+'\n')
   runpy.run_path(str(Path(__file__).with_name('live_shadow.py')),run_name='__main__')
  finally:sys.stdin=prior
 return json.loads(out.getvalue())
class PricingIntegration(unittest.TestCase):
 def test_disjoint_usage_reasoning_and_duplicate_attempt(self):
  raw={'prompt_cache_hit_tokens':10,'prompt_cache_miss_tokens':20,'prompt_tokens':30,'completion_tokens':30,'total_tokens':60,'completion_tokens_details':{'reasoning_tokens':10}}
  row=normalize(raw,protocol='deepseek-openai',attempt_id='synthetic-attempt',request_hash='synthetic-request',route_id='deepseek-official/deepseek-flash')
  card=quote('deepseek-flash');value=actual_cost([row,row],card,band='peak',tariff_id=card['tariff_id'])
  self.assertEqual(D(value['cost']),D('.0002804'));self.assertEqual(value['attempts'],1);self.assertEqual(row['output'],30)
 def test_cache_write_unknown_cannot_be_silently_priced(self):
  row=normalize({'inputTokens':1,'cacheReadTokens':1,'cacheWriteTokens':1,'outputTokens':1},protocol='harness-disjoint-v1',attempt_id='synthetic',request_hash='synthetic',route_id='deepseek-official/deepseek-flash')
  card=quote('deepseek-flash')
  with self.assertRaisesRegex(Hold,'CACHE_WRITE_PRICE_UNKNOWN'):actual_cost([row],card,band='peak',tariff_id=card['tariff_id'])
 def test_real_numeric_consumer_equality_dearer_and_overlap_remain_shadow(self):
  cases=[({'retained_units_lower':409600,'retained_units_upper':409600},'ESTIMATED_SAVING_PROVEN'),({'summary_input_units_lower':1000000,'summary_input_units_upper':1000000},'ESTIMATED_ROTATION_DEARER_DISJOINT'),({'retained_units_lower':1000,'retained_units_upper':1000,'summary_input_units_lower':50,'summary_input_units_upper':50},'ESTIMATED_INTERVALS_OVERLAP')]
  for changes,expected in cases:
   with self.subTest(expected=expected):
    value=calculate(changes);self.assertEqual(value['interval_relation'],expected);self.assertFalse(value['automatic_permission']);self.assertEqual(value['quote_verified_on'],'2026-11-02')
 def test_internal_daily_review_does_not_expire_official_price(self):
  card=quote('deepseek-flash');self.assertIsNone(card['official_valid_until']);self.assertIsNone(card['official_effective_from'])
  self.assertIn('keep_interval_cny',calculate(at='2026-11-05T05:00:00Z'))
  value=calculate(at='2026-11-09T04:56:39Z');self.assertEqual(value['reason'],'QUOTE_LOCAL_REVIEW_OVERDUE');self.assertFalse(value['automatic_permission']);self.assertIsNone(value['L'])
 def test_local_library_is_not_an_api_success_count(self):
  self.assertEqual(search_fetch_cost(NOW,search=0,fetch=0),D(0))
  self.assertEqual(search_fetch_cost(NOW,search=1,fetch=1),D('.010'))
if __name__=='__main__':unittest.main()
