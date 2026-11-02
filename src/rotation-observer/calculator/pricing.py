"""Dated official quote snapshot. Revalidate before use; do not map unknown aliases."""
from datetime import datetime, timezone, timedelta
from decimal import Decimal as D
from usage import Hold
SOURCE="https://api-docs.deepseek.com/quick_start/pricing/"
CN_SOURCE="https://api-docs.deepseek.com/zh-cn/quick_start/pricing/"
CHECKED="2026-10-31"
EFFECTIVE_FROM="2026-10-30"

def quote(model,currency="CNY"):
    table={
      ("deepseek-flash","USD"):(("0.003","0.15","0.6"),("0.006","0.3","1.2")),
      ("deepseek-v4-pro","USD"):(("0.022","0.66","1.98"),("0.044","1.32","3.96")),
      ("deepseek-flash","CNY"):(("0.02","1","4"),("0.04","2","8")),
      ("deepseek-v4-pro","CNY"):(("0.15","4.5","13.5"),("0.30","9","27")),
    }
    if (model,currency) not in table: raise Hold("MODEL_OR_CURRENCY_NOT_IN_OFFICIAL_QUOTE")
    off,peak=table[model,currency]
    return dict(tariff_id=f"deepseek-official:{model}:{currency}:{CHECKED}",
      route_id="deepseek-official/"+model,model=model,currency=currency,
      source=CN_SOURCE if currency=="CNY" else SOURCE,verified_on=CHECKED,effective_from=EFFECTIVE_FROM,
      rates={b:dict(zip(("hit","miss","output"),r)) for b,r in (("offpeak",off),("peak",peak))},
      # Safe conservative ceiling for the official 1M context and explicit API 384K output.
      context_upper=1048576,output_upper=393216)

def rates_bounds(card, band, as_of):
    if not isinstance(as_of,str): raise Hold("AS_OF_REQUIRED")
    now=datetime.fromisoformat(as_of.replace("Z","+00:00"))
    if now.tzinfo is None: raise Hold("AS_OF_ZONE_REQUIRED")
    checked=datetime.fromisoformat(card["verified_on"]).replace(tzinfo=timezone.utc)
    effective=datetime.fromisoformat(card.get("effective_from",card["verified_on"])).replace(tzinfo=timezone.utc)
    if now < effective or now >= checked+timedelta(days=2): raise Hold("QUOTE_STALE_REVALIDATE_OFFICIAL_SOURCE")
    if band not in ("peak","offpeak","unknown"): raise Hold("PRICE_BAND_INVALID")
    choices=("offpeak","peak") if band=="unknown" else (band,)
    return {k:(min(D(card["rates"][b][k]) for b in choices),max(D(card["rates"][b][k]) for b in choices)) for k in ("hit","miss","output")}

def search_fetch_cost(as_of,*,search=0,fetch=0,currency="CNY"):
    """Counts mean HTTP200+nonempty search / HTTP200+body fetch only; not library MCP calls."""
    for n in (search,fetch):
        if type(n) is not int or n<0:raise Hold("TOOL_BILLABLE_COUNT_REQUIRED")
    if currency not in ("CNY","USD"):raise Hold("TOOL_CURRENCY_UNKNOWN")
    now=datetime.fromisoformat(as_of.replace("Z","+00:00"))
    if now.tzinfo is None:raise Hold("AS_OF_ZONE_REQUIRED")
    rates_bounds(quote("deepseek-flash",currency),"offpeak",as_of)
    start=datetime(2026,10,31,16,tzinfo=timezone.utc)
    return D(0) if now<start else D(search+fetch)*(D(".005") if currency=="CNY" else D(".00075"))
