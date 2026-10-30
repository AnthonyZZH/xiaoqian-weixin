"""Explicit, validated scheduling policy; stdlib only."""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
import hashlib
import math


def zone(name):
    if name in ("UTC", "Etc/UTC"):
        return timezone.utc
    if name == "Asia/Shanghai":
        # Matches the source patch and works on Windows without a tzdata wheel.
        # Other IANA zones require the host's zoneinfo database; never use local TZ.
        return timezone(timedelta(hours=8), name)
    return ZoneInfo(name)


def number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be finite")
    return float(value)


def minute(text):
    if isinstance(text, int) and not isinstance(text, bool) and 0 <= text <= 23:
        return text * 60
    parts = str(text).split(":")
    if len(parts) not in (1, 2):
        raise ValueError("invalid clock time")
    h, m = int(parts[0]), int(parts[1]) if len(parts) == 2 else 0
    if not 0 <= h < 24 or not 0 <= m < 60:
        raise ValueError("invalid clock time")
    return h * 60 + m


@dataclass(frozen=True)
class Window:
    start: int
    end: int

    def __post_init__(self):
        if any(type(x) is not int or not 0 <= x < 1440 for x in (self.start, self.end)) or self.start == self.end:
            raise ValueError("window requires distinct minute boundaries within a day")

    @classmethod
    def parse(cls, value):
        parts = value.split("-", 1) if isinstance(value, str) else value
        if len(parts) != 2:
            raise ValueError("window requires start and end")
        return cls(minute(parts[0]), minute(parts[1]))

    def contains(self, current):
        return self.start <= current < self.end if self.start < self.end else current >= self.start or current < self.end


def interval(value):
    if len(value) != 2:
        raise ValueError("interval requires two seconds values")
    lo, hi = (number(x, "interval") for x in value)
    if lo < 1 or hi < lo:
        raise ValueError("interval must be at least one second, ascending")
    return lo, hi


HOLIDAYS_2026 = frozenset(["2026-01-01", "2026-01-02", *[f"2026-02-{d:02d}" for d in range(15, 24)], "2026-04-06", *[f"2026-05-{d:02d}" for d in range(1, 6)], "2026-06-19", "2026-09-25", *[f"2026-10-{d:02d}" for d in range(1, 8)]])


@dataclass(frozen=True)
class ChatPolicy:
    chat_id: str
    mode: str
    owner: bool = False
    enabled: bool = True
    delay_seconds: tuple[float, float] = (3600, 28800)
    idle_seconds: float = 0
    max_unanswered: int = 2
    quiet: tuple[Window, ...] = field(default_factory=lambda: (Window.parse("1-8"),))
    active: tuple[Window, ...] = ()  # empty means all day
    muted: bool = False  # an explicit mute always wins, including the owner

    def __post_init__(self):
        if not isinstance(self.chat_id, str) or not self.chat_id or "\0" in self.chat_id:
            raise ValueError("chat_id must be an opaque nonempty string without NUL")
        if self.mode not in ("private", "group") or self.owner and self.mode != "private":
            raise ValueError("owner can only be a private chat")
        for name in ("owner", "enabled", "muted"):
            if type(getattr(self, name)) is not bool:
                raise ValueError(f"{name} must be boolean")
        interval(self.delay_seconds)
        if number(self.idle_seconds, "idle_seconds") < 0 or type(self.max_unanswered) is not int or self.max_unanswered < 0:
            raise ValueError("invalid idle or unanswered limit")
        if any(not isinstance(x, Window) for x in (*self.quiet, *self.active)):
            raise ValueError("quiet/active must contain Window objects")

    @property
    def key(self):
        return hashlib.sha256((self.mode + "\0" + self.chat_id).encode()).hexdigest()


@dataclass(frozen=True)
class ScheduleConfig:
    chats: tuple[ChatPolicy, ...]
    timezone_name: str = "Asia/Shanghai"
    owner_peak_seconds: tuple[float, float] = (900, 1800)
    owner_offpeak_seconds: tuple[float, float] = (300, 300)
    peak_periods: tuple[Window, ...] = field(default_factory=lambda: (Window.parse("09:00-12:00"), Window.parse("14:00-18:00")))
    peak_holidays: frozenset[str] = HOLIDAYS_2026
    owner_bypass_quiet: bool = True
    owner_bypass_budget: bool = True
    owner_sleep_seconds: float = 18000
    budget_per_hour: int = 12
    budget_cooldown_seconds: float = 180
    budget_quiet: tuple[Window, ...] = field(default_factory=lambda: (Window.parse("1-8"),))

    def __post_init__(self):
        zone(self.timezone_name)
        if any(not isinstance(x, ChatPolicy) for x in self.chats) or len({x.key for x in self.chats}) != len(self.chats):
            raise ValueError("duplicate/invalid chat policy")
        if sum(x.owner for x in self.chats) > 1:
            raise ValueError("only one owner")
        interval(self.owner_peak_seconds); interval(self.owner_offpeak_seconds)
        for value in self.peak_holidays:
            if datetime.strptime(value, "%Y-%m-%d").date().isoformat() != value:
                raise ValueError("holiday must use ISO date")
        if type(self.budget_per_hour) is not int or self.budget_per_hour < 1:
            raise ValueError("hourly budget must be positive")
        if number(self.budget_cooldown_seconds, "cooldown") < 0 or number(self.owner_sleep_seconds, "sleep") < 0:
            raise ValueError("negative cooldown/sleep")
        if any(not isinstance(w, Window) for w in (*self.peak_periods, *self.budget_quiet)):
            raise ValueError("invalid window")
        if type(self.owner_bypass_quiet) is not bool or type(self.owner_bypass_budget) is not bool:
            raise ValueError("bypass flags must be boolean")

    def delay(self, policy, now, rng):
        bounds = policy.delay_seconds
        if policy.owner:
            current = datetime.fromtimestamp(now, zone(self.timezone_name))
            peak = current.weekday() < 5 and current.date().isoformat() not in self.peak_holidays
            peak = peak and any(w.contains(current.hour * 60 + current.minute) for w in self.peak_periods)
            bounds = self.owner_peak_seconds if peak else self.owner_offpeak_seconds
        return rng.uniform(*bounds)

    @classmethod
    def from_legacy(cls, settings):
        """Translate supplied settings only; never reads settings.json or real contacts.

        Invalid policy fails rather than silently relaxing a guard. Unlike legacy
        normalization, a zero delay is rejected to avoid zero-time event storms.
        """
        def windows(value):
            return () if value in (None, "", []) else (Window.parse(value),) if isinstance(value, str) else tuple(Window.parse(v) for v in value)
        def seconds(key, default):
            return tuple(number(x, key) * 60 for x in settings.get(key, default))
        for key in ("initiative_private", "initiative_group"):
            if type(settings.get(key, True)) is not bool:
                raise ValueError(f"{key} must be boolean")
        extras = settings.get("initiative_private_chats", [])
        if not isinstance(extras, list) or any(not isinstance(x, str) for x in extras):
            raise ValueError("initiative_private_chats must be a list of opaque IDs")
        chats = []
        for chat, raw in settings.get("chats", {}).items():
            mode = raw.get("mode")
            if mode not in ("private", "group"):
                raise ValueError("invalid legacy chat mode")
            owner = mode == "private" and chat == settings.get("owner")
            enabled = settings.get("initiative_" + mode, True)
            if mode == "private":
                enabled = enabled and (owner or chat in extras)
            quiet = settings.get("initiative_quiet_hours", {"private": "1-8", "group": "1-8"}).get(mode, "")
            chats.append(ChatPolicy(chat, mode, owner=owner, enabled=enabled,
                delay_seconds=seconds("initiative_" + mode + "_minutes", [60, 480] if mode == "private" else [60, 240]),
                idle_seconds=number(settings.get("initiative_group_idle_minutes", 40), "idle") * 60 if mode == "group" else 0,
                max_unanswered=settings.get("initiative_max_unanswered", {}).get(mode, 2), quiet=windows(quiet),
                active=windows(settings.get("initiative_active_hours", {}).get(mode, [])), muted=raw.get("muted", False)))
        return cls(tuple(chats), timezone_name=settings.get("social_timezone", "Asia/Shanghai"),
            owner_peak_seconds=seconds("initiative_peak_minutes", [15, 30]), owner_offpeak_seconds=seconds("initiative_offpeak_minutes", [5, 5]),
            peak_periods=tuple(Window.parse(v) for v in settings.get("initiative_peak_periods", [["09:00", "12:00"], ["14:00", "18:00"]])),
            peak_holidays=frozenset(settings.get("initiative_peak_holidays", HOLIDAYS_2026)),
            owner_bypass_quiet=settings.get("initiative_owner_bypass_quiet", True),
            owner_bypass_budget=settings.get("initiative_owner_bypass_budget", True),
            budget_per_hour=settings.get("hourly_limit", 12),
            budget_cooldown_seconds=settings.get("cooldown_seconds", 180),
            budget_quiet=windows(settings.get("send_quiet_hours", "1-8")),
            owner_sleep_seconds=settings.get("owner_sleep_seconds", 18000))
