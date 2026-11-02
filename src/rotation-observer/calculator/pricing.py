"""Official CNY observation; drop-in quote/rates_bounds/search_fetch_cost API.
No network, model call, alias rewriting, or production mutation.
"""
from datetime import datetime, timezone, timedelta
from decimal import Decimal as D
import hashlib, json
from usage import Hold

CN_SOURCE='https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
SOURCE=CN_SOURCE
SEARCH_SOURCE='https://api-docs.deepseek.com/zh-cn/guides/search/'
CHECKED='2026-11-02'
RETRIEVED_AT='2026-11-02T04:56:39Z'
# Local review policy, NOT an official tariff expiration. Review daily;
# an unattended snapshot becomes unknown after seven days without revalidation.
REVIEW_AFTER=timedelta(days=1)
MAX_UNREVIEWED=timedelta(days=7)
MODEL_RATES={
 'deepseek-flash':{'offpeak':{'hit':'0.02','miss':'1','output':'4'},'peak':{'hit':'0.04','miss':'2','output':'8'}},
 'deepseek-v4-pro':{'offpeak':{'hit':'0.15','miss':'4.5','output':'13.5'},'peak':{'hit':'0.30','miss':'9.0','output':'27.0'}},
}
MODEL_REVISIONS={'deepseek-flash':'DeepSeek-V4.1-Flash-1017','deepseek-v4-pro':'DeepSeek-V4-Pro-0813'}
BAND_RULE='Asia/Shanghai:Mon-Fri-excluding-CN-statutory-holidays:09:00-12:00,14:00-18:00;others-offpeak'
SNAPSHOT_ID=hashlib.sha256(json.dumps({'currency':'CNY','models':MODEL_RATES,'revisions':MODEL_REVISIONS,'band_rule':BAND_RULE,'search_per_success':'0.005','fetch_per_success':'0.005','server_tools_start':'2026-10-31T16:00:00Z'},sort_keys=True,separators=(',',':')).encode()).hexdigest()

def instant(value):
 if not isinstance(value,str):raise Hold('AS_OF_REQUIRED')
 try:t=datetime.fromisoformat(value.replace('Z','+00:00'))
 except ValueError:raise Hold('AS_OF_INVALID')
 if t.tzinfo is None:raise Hold('AS_OF_ZONE_REQUIRED')
 return t.astimezone(timezone.utc)

def quote(model,currency='CNY'):
 if currency!='CNY' or model not in MODEL_RATES:raise Hold('MODEL_OR_CURRENCY_NOT_IN_OFFICIAL_QUOTE')
 observed=instant(RETRIEVED_AT)
 return dict(tariff_id=f'deepseek-official:{model}:CNY:{SNAPSHOT_ID}',snapshot_id=SNAPSHOT_ID,
  route_id='deepseek-official/'+model,model=model,model_revision=MODEL_REVISIONS[model],currency='CNY',
  source=CN_SOURCE,verified_on=CHECKED,verified_at=RETRIEVED_AT,
  effective_from=RETRIEVED_AT,effective_from_basis='observed-current-quote-only-not-official-start-date',
  official_effective_from=None,official_valid_until=None,
  review_due_at=(observed+REVIEW_AFTER).isoformat(),local_review_deadline=(observed+MAX_UNREVIEWED).isoformat(),
  expiry_basis='internal-max-unreviewed-age-not-official-expiration',
  rates={b:dict(v) for b,v in MODEL_RATES[model].items()},unit='CNY per 1000000 tokens',
  context_upper=1048576,output_upper=393216)

def rates_bounds(card,band,as_of):
 now=instant(as_of);observed=instant(RETRIEVED_AT)
 if card.get('snapshot_id')!=SNAPSHOT_ID or card.get('currency')!='CNY' or card.get('model') not in MODEL_RATES:raise Hold('QUOTE_VERSION_UNKNOWN')
 if card.get('rates')!=MODEL_RATES[card['model']]:raise Hold('QUOTE_CONTENT_CHANGED')
 if now<observed:raise Hold('QUOTE_NOT_OBSERVED_AT_REQUEST_TIME')
 if now>=observed+MAX_UNREVIEWED:raise Hold('QUOTE_LOCAL_REVIEW_OVERDUE')
 if band not in ('peak','offpeak','unknown'):raise Hold('PRICE_BAND_INVALID')
 choices=('offpeak','peak') if band=='unknown' else (band,)
 return {k:(min(D(card['rates'][b][k]) for b in choices),max(D(card['rates'][b][k]) for b in choices)) for k in ('hit','miss','output')}

def search_fetch_cost(as_of,*,search=0,fetch=0,currency='CNY',access_path='server_tool'):
 """Counts are billable successes, never local MCP text-search/read operations.
 Server-tool free period is explicit official policy; direct APIs are separate.
 """
 if any(type(n) is not int or n<0 for n in (search,fetch)):raise Hold('TOOL_BILLABLE_COUNT_REQUIRED')
 if currency!='CNY':raise Hold('TOOL_CURRENCY_UNKNOWN')
 if access_path not in ('server_tool','direct_api'):raise Hold('TOOL_ACCESS_PATH_UNKNOWN')
 now=instant(as_of);observed=instant(RETRIEVED_AT)
 if now>=observed+MAX_UNREVIEWED:raise Hold('QUOTE_LOCAL_REVIEW_OVERDUE')
 start=instant('2026-10-31T16:00:00Z')
 if access_path=='server_tool' and now<start:return D(0)
 if access_path=='direct_api' and now<observed:raise Hold('HISTORICAL_DIRECT_TOOL_TARIFF_UNVERIFIED')
 return D(search+fetch)*D('0.005')
