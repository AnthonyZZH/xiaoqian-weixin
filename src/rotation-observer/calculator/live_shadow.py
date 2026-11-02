"""Numeric-only, empirical single-read scenario; never switches or calls APIs."""
import json,sys
from pathlib import Path
from decimal import Decimal as D
sys.path.insert(0,str(Path(__file__).resolve().parent))
from pricing import quote,rates_bounds
try:
 r=json.loads(sys.stdin.readline(131072));d=r['dimensions'];card=quote(d['model'],'CNY');rates=rates_bounds(card,'unknown',r['as_of']);million=D(1000000)
 lo,hi,mid=[D(str(d[k])) for k in ('ratio_min','ratio_max','ratio_median')]
 assert D(0)<lo<=mid<=hi
 for k in ('retained_units_lower','retained_units_upper','summary_input_units_lower','summary_input_units_upper','reload_units_lower','reload_units_upper'):assert type(d[k]) is int and d[k]>=0
 keep_lo=D(d['retained_units_lower'])*lo*rates['hit'][0]/million
 keep_hi=D(d['retained_units_upper'])*hi*rates['miss'][1]/million
 summary_lo=D(d['summary_input_units_lower'])*lo*rates['hit'][0]/million
 summary_hi=D(d['summary_input_units_upper'])*hi*rates['miss'][1]/million
 output_hi=D(1024)*rates['output'][1]/million
 reload_lo=D(d['reload_units_lower'])*lo*rates['hit'][0]/million
 reload_hi=D(d['reload_units_upper'])*hi*rates['miss'][1]/million
 rotate_lo=summary_lo+reload_lo;rotate_hi=summary_hi+output_hi+reload_hi
 comparison='ESTIMATED_SAVING_PROVEN' if keep_lo>=rotate_hi else 'ESTIMATED_ROTATION_DEARER_DISJOINT' if rotate_lo>keep_hi else 'ESTIMATED_INTERVALS_OVERLAP'
 rate_mid={k:(v[0]+v[1])/2 for k,v in rates.items()};hit=D(str(d['observed_hit_fraction']))
 keep_point=D(d['retained_units_lower'])*mid*(hit*rate_mid['hit']+(1-hit)*rate_mid['miss'])/million
 summary_input_point=D(d['summary_input_units_lower'])*mid*rate_mid['miss']/million
 budget_point=summary_input_point+D(d['reload_units_upper'])*mid*rate_mid['miss']/million+D(1024)*rate_mid['output']/million
 components={k:{'units_upper':v,'cost_upper_cny':str(D(v)*hi*rates['miss'][1]/million)} for k,v in d['reload_components'].items()}
 result={'policy':'single-read-interval-v4','currency':'CNY','mode':'empirical_estimate_shadow','L':str(keep_lo),'U':str(rotate_hi),'keep_interval_cny':[str(keep_lo),str(keep_hi)],'rotation_interval_cny':[str(rotate_lo),str(rotate_hi)],'interval_relation':comparison,'comparison_passes':keep_lo>=rotate_hi,'recommendation':'hold','reason':comparison,'automatic_permission':False,'guaranteed_saving':False,'tokenizer_bound_proven':False,
 'cost_breakdown':{'summary_input_interval':[str(summary_lo),str(summary_hi)],'summary_output_interval':['0',str(output_hi)],'cold_reload_interval':[str(reload_lo),str(reload_hi)],'reload_upper_components':components,'library_external_increment_expected':'0','base_dormant_creation_model_fee':'0'},
 'point_scenario':{'basis':'median observed units/token; observed keep-cache fraction; midpoint tariff; rotation uses configured maximum injection budgets, not a forecast','keep_cny':str(keep_point),'summary_cold_input_alone_cny':str(summary_input_point),'rotation_at_budget_caps_cny':str(budget_point),'budget_caps_rotation_dearer':budget_point>keep_point,'summary_cold_input_alone_dearer':summary_input_point>keep_point,'actual_rotation_point_estimate':None,'actual_point_unknown_reason':'future generated summary and selected excerpts not yet produced'},
 'summary_components':d['summary_components'],'summary_output_budget_tokens':1024,'retrieval_scope':d['retrieval_scope'],'retrieval_call_budget_enforced':d['retrieval_call_budget_enforced'],'runtime_injection_policy':d['runtime_injection_policy'],
 'common_input_cancelled':False,'next_input_not_predicted':True,'horizon':'one retained-context read versus all one-time rotation input/output plus one bounded cold reload; no multi-turn amortization','cache_loss_added_twice':False,'fees_are_conditional_estimates':True,'bound_basis':'native active surface, enforced read projection and rotation handoff injection guards; same-model empirical wire/usage ratios, not rigorous token bounds','conservative_rule_warning':'cheapest cache-hit keep lower versus cold summary upper can prevent triggering even with small retrieval budgets','quote_verified_on':card['verified_on'],'quote_source':card['source']}
 print(json.dumps(result,separators=(',',':')),flush=True)
except Exception as e:
 reason=str(e) if str(e).isupper() and len(str(e))<100 else 'LIVE_NUMERIC_INTERVAL_INPUT_INVALID'
 print(json.dumps({'recommendation':'hold','reason':reason,'automatic_permission':False,'L':None,'U':None},separators=(',',':')),flush=True)
