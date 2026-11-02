"""Strict historical billing normalization. No HTTP, tokenizer heuristic or model."""
from decimal import Decimal as D

class Hold(ValueError): pass

def count(value):
    if type(value) is not int or value < 0: raise Hold("USAGE_BUCKET_UNKNOWN_OR_INVALID")
    return value

def normalize(raw, *, protocol, attempt_id, request_hash, route_id):
    if not all(isinstance(v,str) and v for v in (attempt_id,request_hash,route_id)):
        raise Hold("OBSERVATION_ATTRIBUTION_MISSING")
    if protocol == "deepseek-openai":
        hit=count(raw.get("prompt_cache_hit_tokens"))
        miss=count(raw.get("prompt_cache_miss_tokens"))
        output=count(raw.get("completion_tokens"))
        if count(raw.get("prompt_tokens")) != hit+miss: raise Hold("PROMPT_BUCKET_SUM_MISMATCH")
        write=0
        if "total_tokens" in raw and count(raw["total_tokens"]) != hit+miss+output: raise Hold("TOTAL_BUCKET_SUM_MISMATCH")
    elif protocol == "harness-disjoint-v1":
        hit=count(raw.get("cacheReadTokens"));miss=count(raw.get("inputTokens"))
        write=count(raw.get("cacheWriteTokens"));output=count(raw.get("outputTokens"))
    else: raise Hold("USAGE_PROTOCOL_UNSUPPORTED")
    # Reasoning is already included in output; never add details.reasoning_tokens.
    return dict(kind="observation",attempt_id=attempt_id,request_hash=request_hash,route_id=route_id,
                hit=hit,miss=miss,write=write,output=output)

def actual_cost(observations, quote, *, band, tariff_id):
    """Only price observations with an explicitly attributed contemporaneous tariff."""
    if tariff_id != quote["tariff_id"] or band not in ("peak","offpeak"):
        raise Hold("HISTORICAL_TARIFF_OR_BAND_UNKNOWN")
    seen={}; result=D(0)
    for row in observations:
        key=row["attempt_id"]
        if key in seen:
            if row!=seen[key]: raise Hold("CONFLICTING_DUPLICATE_ATTEMPT")
            continue
        seen[key]=row
        if row["route_id"] != quote["route_id"]: raise Hold("OBSERVATION_ROUTE_MISMATCH")
        rates=quote["rates"][band]
        for bucket in ("hit","miss","write","output"):
            n=count(row[bucket])
            if n and rates.get(bucket) is None: raise Hold("CACHE_WRITE_PRICE_UNKNOWN")
            if n: result+=D(n)*D(rates[bucket])/D(1000000)
    return {"kind":"historical_actual","cost":str(result),"currency":quote["currency"],
            "attempts":len(seen),"not_a_forecast":True}
