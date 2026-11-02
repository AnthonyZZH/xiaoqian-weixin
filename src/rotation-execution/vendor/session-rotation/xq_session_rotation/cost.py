"""No provider calls: quote-and-usage driven conservative cost accounting."""
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Optional

D = Decimal
MILLION = D(1000000)


def decimal(value):
    if isinstance(value, bool):
        raise ValueError("boolean is not a price")
    try:
        result = D(str(value))
    except InvalidOperation:
        raise ValueError("invalid amount") from None
    if not result.is_finite() or result < 0:
        raise ValueError("amount must be finite and nonnegative")
    return result


@dataclass(frozen=True)
class Amount:
    low: Decimal
    high: Decimal

    def __post_init__(self):
        object.__setattr__(self, "low", decimal(self.low))
        object.__setattr__(self, "high", decimal(self.high))
        if self.low > self.high:
            raise ValueError("inverted amount range")

    def __add__(self, other):
        return Amount(self.low + other.low, self.high + other.high)

    def times(self, n):
        return Amount(self.low * n, self.high * n)


@dataclass(frozen=True)
class Tokens:
    low: int
    high: int

    def __post_init__(self):
        if any(type(v) is not int or v < 0 for v in (self.low, self.high)) or self.low > self.high:
            raise ValueError("token range must contain ascending nonnegative integers")

    @classmethod
    def exact(cls, n):
        return cls(n, n)


ZERO = Tokens(0, 0)


@dataclass(frozen=True)
class Usage:
    uncached: Optional[Tokens]
    cached: Optional[Tokens]
    output: Optional[Tokens]
    embedding: Optional[Tokens] = ZERO


@dataclass(frozen=True)
class RateCard:
    provider: str
    model: str
    currency: str
    source: str
    verified_on: date
    # Currency per million tokens; None means unknown, never implicitly free.
    uncached: Optional[Decimal] = None
    cached: Optional[Decimal] = None
    output: Optional[Decimal] = None
    embedding: Optional[Decimal] = None

    def __post_init__(self):
        for field in ("uncached", "cached", "output", "embedding"):
            value = getattr(self, field)
            if value is not None:
                object.__setattr__(self, field, decimal(value))


@dataclass(frozen=True)
class Charge:
    stage: str
    evidence: str
    usage: Optional[Usage] = None
    rates: Optional[RateCard] = None
    fixed: Optional[Amount] = None
    currency: str = ""
    source: str = ""
    verified_on: Optional[date] = None

    @classmethod
    def free(cls, stage, evidence, currency, source, verified_on):
        return cls(stage, evidence, fixed=Amount(0, 0), currency=currency,
                   source=source, verified_on=verified_on)

    def priced(self, as_of, max_age_days):
        if not self.evidence:
            raise UnknownCost(self.stage + ": missing usage evidence/assumptions")
        if self.fixed is not None:
            if self.usage is not None or self.rates is not None:
                raise ValueError("fixed and token pricing cannot both apply")
            currency, source, verified = self.currency, self.source, self.verified_on
            result = self.fixed
        else:
            if self.usage is None or self.rates is None:
                raise UnknownCost(self.stage + ": missing usage or rates")
            rates = self.rates
            if not rates.provider or not rates.model:
                raise UnknownCost(self.stage + ": provider/model missing")
            currency, source, verified = rates.currency, rates.source, rates.verified_on
            result = Amount(0, 0)
            for field in ("uncached", "cached", "output", "embedding"):
                usage, rate = getattr(self.usage, field), getattr(rates, field)
                if usage is None:
                    raise UnknownCost(self.stage + ": unknown " + field + " usage")
                if usage.high == 0:
                    continue
                if rate is None:
                    raise UnknownCost(self.stage + ": unknown " + field + " price")
                result += Amount(D(usage.low) * rate / MILLION, D(usage.high) * rate / MILLION)
        if not currency or not source or not isinstance(verified, date):
            raise UnknownCost(self.stage + ": price source/date/currency missing")
        if not 0 <= (as_of - verified).days <= max_age_days:
            raise UnknownCost(self.stage + ": stale or future quote")
        return result, currency, source + " @ " + verified.isoformat()


class UnknownCost(ValueError):
    pass


@dataclass(frozen=True)
class Forecast:
    snapshot_digest: str
    transcript_tokens: int
    summary_input_tokens: Tokens
    retained_cache_loss_tokens: Tokens
    cache_assumptions: str
    future_assumptions: str
    continuation: tuple
    setup: tuple
    first_new_turn: tuple
    steady_new_turn: tuple
    horizon: int = 100
    first_request_tokens: Optional[Tokens] = None
    first_request_components: tuple = ()

    def validate(self):
        if type(self.horizon) is not int or not 1 <= self.horizon <= 10000:
            raise ValueError("horizon must be 1..10000")
        if type(self.transcript_tokens) is not int or self.transcript_tokens < 0:
            raise ValueError("invalid transcript token count")
        if not self.snapshot_digest or not self.cache_assumptions or not self.future_assumptions:
            raise UnknownCost("snapshot and explicit cache/future assumptions are required")
        required = {
            "continuation": {"conversation"},
            "setup": {"summary", "archive_write", "archive_readback", "summary_write", "summary_readback", "write_embedding", "agent_create"},
            "first_new_turn": {"conversation", "retrieval", "retrieval_embedding"},
            "steady_new_turn": {"conversation", "retrieval", "retrieval_embedding"},
        }
        for name, stages in required.items():
            charges = getattr(self, name)
            names = [c.stage for c in charges]
            if len(names) != len(set(names)):
                raise ValueError(name + ": duplicate stage")
            if not stages <= set(names):
                raise UnknownCost(name + ": required cost stages missing")
        summary = next(c for c in self.setup if c.stage == "summary")
        new = next(c for c in self.first_new_turn if c.stage == "conversation")
        if summary.usage is None or summary.usage.uncached is None or summary.usage.cached is None or summary.usage.output is None:
            raise UnknownCost("full-transcript summary usage unknown")
        if summary.usage.uncached.low + summary.usage.cached.low < self.transcript_tokens:
            raise UnknownCost("summary must account for the full transcript input, plus any prompt overhead")
        if self.summary_input_tokens.low < summary.usage.output.high:
            raise UnknownCost("new-session summary input must cover the summary output upper bound")
        components = {"persona", "owner_permissions", "unfinished_tasks", "recent_handoff", "dedup", "tool_schema", "current_message", "summary", "serialization"}
        if not components <= set(self.first_request_components):
            raise UnknownCost("first new request context components have not all been accounted for")
        if new.usage is None or new.usage.uncached is None or new.usage.cached is None:
            raise UnknownCost("new-session cold input unknown")
        total = Tokens(new.usage.uncached.low + new.usage.cached.low, new.usage.uncached.high + new.usage.cached.high)
        if self.first_request_tokens is None or total != self.first_request_tokens:
            raise UnknownCost("first full serialized request total must equal cached plus uncached input bounds")
        if new.usage.uncached.low < self.summary_input_tokens.high + self.retained_cache_loss_tokens.high:
            raise UnknownCost("first new turn omits summary input or retained-prefix cache loss")


@dataclass(frozen=True)
class CostDecision:
    snapshot_digest: str
    recommendation: str
    currency: Optional[str]
    continuation_next: Optional[Amount]
    rotation_next: Optional[Amount]
    setup: Optional[Amount]
    savings_next_lower: Optional[Decimal]
    raw_break_even_turns: Optional[int]
    protected_break_even_turns: Optional[int]
    reason: str
    sources: tuple = ()
    assumptions: tuple = ()


def compare(forecast, *, as_of, max_quote_age_days=30, minimum_saving="0.001", margin_fraction="0.20"):
    """A conditional break-even is advisory, never an automatic rotate permission.

    At N turns: keep=N*C; rotate=H+F+(N-1)*S. Test keep.low - rotate.high
    against max(absolute margin, keep.low*fraction), with strictly positive saving.
    Output lengths are priced separately in both paths and never cancelled by fiat.
    """
    minimum, fraction = decimal(minimum_saving), decimal(margin_fraction)
    if fraction >= 1 or type(max_quote_age_days) is not int or max_quote_age_days < 0:
        raise ValueError("invalid margin or quote freshness policy")
    assumptions = (forecast.cache_assumptions, forecast.future_assumptions)
    try:
        forecast.validate()
        currency, sources, totals = None, set(), {}
        for name in ("continuation", "setup", "first_new_turn", "steady_new_turn"):
            total = Amount(0, 0)
            for charge in getattr(forecast, name):
                cost, unit, source = charge.priced(as_of, max_quote_age_days)
                if currency is not None and currency != unit:
                    raise UnknownCost("mixed currencies require an explicit dated FX conversion")
                currency = unit
                sources.add(source)
                total += cost
            totals[name] = total
    except UnknownCost as error:
        return CostDecision(forecast.snapshot_digest, "indeterminate", None, None, None, None,
                            None, None, None, str(error), assumptions=assumptions)
    keep, setup, first, steady = (totals[n] for n in ("continuation", "setup", "first_new_turn", "steady_new_turn"))
    raw = protected = None
    for n in range(1, forecast.horizon + 1):
        baseline = keep.low * n
        expense = setup.high + first.high + steady.high * (n - 1)
        saving = baseline - expense
        if saving > 0 and raw is None:
            raw = n
        if saving > 0 and saving >= max(minimum, baseline * fraction):
            protected = n
            break
    next_cost = setup + first
    advice = "rotate_next_turn" if protected == 1 else "conditional_break_even" if protected else "keep"
    reason = {
        "rotate_next_turn": "next-turn lower-bound saving meets the configured safety margin under supplied usage bounds",
        "conditional_break_even": "only conditional future break-even; do not claim guaranteed savings or auto-rotate",
        "keep": "no conservative margin-adjusted break-even within the declared forecast horizon",
    }[advice]
    return CostDecision(forecast.snapshot_digest, advice, currency, keep, next_cost, setup,
                        keep.low - next_cost.high, raw, protected, reason, tuple(sorted(sources)), assumptions)
