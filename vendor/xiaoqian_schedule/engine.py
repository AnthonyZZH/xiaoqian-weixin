"""Transactional scheduling/outbox. Calling code owns all actual side effects."""
from __future__ import annotations
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import math
import random
import sqlite3
import time
import uuid

from .config import ScheduleConfig, number, zone


class StateError(RuntimeError):
    pass


class ClockRegression(StateError):
    pass


@dataclass(frozen=True)
class WakeEvent:
    event_id: str
    chat_id: str
    mode: str
    occurrence_at: float
    created_at: float
    generation: int
    idle_minutes: int
    unanswered: int
    kind: str = "initiative.wake"


@dataclass(frozen=True)
class Claim:
    event: WakeEvent
    token: str
    worker: str
    lease_until: float


_ACTIVE = "('pending','claimed','reserved','uncertain')"


class Scheduler:
    """One SQLite file per independent profile; concurrent instances are supported.

    poll -> claim -> model decision (external) -> prepare_send -> physical send
    (external) -> finish. A reservation is irreversible; an uncertain send blocks
    its chat until explicit resolution. Expired unreserved claims can be reclaimed.
    """
    def __init__(self, path, config: ScheduleConfig, *, clock=time.time, rng=None):
        if str(path) == ":memory:":
            raise ValueError("a durable database path is required")
        self.path = Path(path)
        self.config = config
        self.clock = clock
        self.rng = rng or random.Random()
        self.policies = {p.key: p for p in config.chats}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version == 0:
                if db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchone():
                    raise StateError("existing database is not a schedule database")
                statements = [
                    "CREATE TABLE meta (key TEXT PRIMARY KEY, value REAL NOT NULL)",
                    "CREATE TABLE chats (key TEXT PRIMARY KEY, last_activity REAL NOT NULL, next_at REAL NOT NULL, unanswered INTEGER NOT NULL CHECK(unanswered>=0), generation INTEGER NOT NULL CHECK(generation>=0))",
                    "CREATE TABLE seen (kind TEXT NOT NULL, source_id TEXT NOT NULL, chat_key TEXT NOT NULL, PRIMARY KEY(kind,source_id,chat_key))",
                    "CREATE TABLE events (id TEXT PRIMARY KEY, chat_key TEXT NOT NULL REFERENCES chats(key), occurrence_at REAL NOT NULL, created_at REAL NOT NULL, generation INTEGER NOT NULL, idle_minutes INTEGER NOT NULL, unanswered INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','claimed','reserved','uncertain','sent','declined','cancelled')), token TEXT, worker TEXT, lease_until REAL, reservation_id TEXT)",
                    f"CREATE UNIQUE INDEX one_active_event ON events(chat_key) WHERE status IN {_ACTIVE}",
                    "CREATE TABLE reservations (id TEXT PRIMARY KEY, event_id TEXT UNIQUE NOT NULL REFERENCES events(id), chat_key TEXT NOT NULL, reserved_at REAL NOT NULL)",
                    "CREATE INDEX budget_window ON reservations(chat_key,reserved_at)",
                ]
                for sql in statements:
                    db.execute(sql)
                db.execute("PRAGMA user_version=1")
                db.execute("INSERT INTO meta VALUES ('last_now',0),('owner_sleep_until',0)")
            elif version != 1:
                raise StateError("unsupported schedule state version")
            # Never replace, reset, or partially recover a corrupt database.
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise StateError("invalid schedule state")
            if {r[0] for r in db.execute("SELECT key FROM meta")} != {"last_now", "owner_sleep_until"}:
                raise StateError("invalid schedule metadata")
            db.commit()

    @contextmanager
    def _connection(self):
        db = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA synchronous=FULL")
            yield db
        finally:
            if db.in_transaction:
                db.rollback()
            db.close()

    @contextmanager
    def _transaction(self, now=None):
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            # Sample the clock after obtaining the process-wide database lock.
            moment = number(self.clock() if now is None else now, "now")
            if moment < 0:
                raise ValueError("now must be a nonnegative epoch timestamp")
            previous = db.execute("SELECT value FROM meta WHERE key='last_now'").fetchone()[0]
            if moment < previous:
                raise ClockRegression("clock moved backward; wait until the persisted high-water mark")
            db.execute("UPDATE meta SET value=? WHERE key='last_now'", (moment,))
            yield db, moment
            db.commit()

    def _policy(self, chat_id, mode):
        from hashlib import sha256
        key = sha256((mode + "\0" + chat_id).encode()).hexdigest()
        try:
            return self.policies[key]
        except KeyError:
            raise ValueError("chat is not configured") from None

    def _schedule(self, p, now, activity=True):
        return now + self.config.delay(p, now, self.rng) + (p.idle_seconds if p.mode == "group" and activity else 0)

    def _ensure(self, db, p, now):
        row = db.execute("SELECT * FROM chats WHERE key=?", (p.key,)).fetchone()
        if row is None:
            db.execute("INSERT INTO chats VALUES (?,?,?,0,0)", (p.key, now, self._schedule(p, now)))
            return None
        return row

    def _seen(self, db, kind, source_id, key):
        if not isinstance(source_id, str) or not source_id:
            raise ValueError("source_id is required for durable input deduplication")
        return db.execute("INSERT OR IGNORE INTO seen VALUES (?,?,?)", (kind, source_id, key)).rowcount == 0

    def heard(self, chat_id, mode, *, source_id, owner_sleep=False, now=None):
        """Observe a verified non-echo incoming message, with a transport-stable id.

        Owner sleep classification is supplied by the trusted inbound adapter; no
        content is persisted here. A later owner message clears sleep by default.
        """
        p = self._policy(chat_id, mode)
        if type(owner_sleep) is not bool:
            raise ValueError("owner_sleep must be boolean")
        with self._transaction(now) as (db, moment):
            if self._seen(db, "heard", source_id, p.key):
                return False
            self._activity(db, p, moment, clear=True)
            if p.owner:
                db.execute("UPDATE meta SET value=? WHERE key='owner_sleep_until'", (moment + self.config.owner_sleep_seconds if owner_sleep else 0,))
            return True

    def spoke(self, chat_id, mode, *, source_id, now=None):
        """Observe an ordinary response. Proactive sends must use the event protocol."""
        p = self._policy(chat_id, mode)
        with self._transaction(now) as (db, moment):
            if self._seen(db, "spoke", source_id, p.key):
                return False
            self._activity(db, p, moment, clear=False)
            return True

    def _activity(self, db, p, now, clear):
        old = self._ensure(db, p, now)
        count = 0 if clear or old is None else old["unanswered"]
        generation = 1 if old is None else old["generation"] + 1
        db.execute("UPDATE chats SET last_activity=?,next_at=?,unanswered=?,generation=? WHERE key=?", (now, self._schedule(p, now), count, generation, p.key))
        # A prepared/uncertain side effect cannot safely be unsent or retried.
        db.execute("UPDATE events SET status='cancelled' WHERE chat_key=? AND status IN ('pending','claimed')", (p.key,))

    def _calendar_ready(self, p, candidate):
        quiet = () if p.owner and self.config.owner_bypass_quiet else p.quiet
        if not (p.owner and self.config.owner_bypass_budget):
            quiet = (*quiet, *self.config.budget_quiet)
        if not quiet and not p.active:
            return candidate
        for _ in range(8 * 24 * 60 + 1):
            dt = datetime.fromtimestamp(candidate, zone(self.config.timezone_name))
            minute = dt.hour * 60 + dt.minute
            if not any(w.contains(minute) for w in quiet) and (not p.active or any(w.contains(minute) for w in p.active)):
                return candidate
            candidate = (math.floor(candidate / 60) + 1) * 60
        return None  # contradictory active/quiet windows: stay blocked

    def _ready(self, db, p, state, now):
        if not p.enabled or p.muted or state["unanswered"] >= p.max_unanswered:
            return None
        candidate = max(now, state["next_at"], state["last_activity"] + (p.idle_seconds if p.mode == "group" else 0))
        if p.owner:
            candidate = max(candidate, db.execute("SELECT value FROM meta WHERE key='owner_sleep_until'").fetchone()[0])
        if not (p.owner and self.config.owner_bypass_budget):
            rows = [r[0] for r in db.execute("SELECT reserved_at FROM reservations WHERE chat_key=? AND reserved_at>? ORDER BY reserved_at", (p.key, now - 3600))]
            if rows:
                candidate = max(candidate, rows[-1] + self.config.budget_cooldown_seconds)
            if len(rows) >= self.config.budget_per_hour:
                candidate = max(candidate, rows[-self.config.budget_per_hour] + 3600)
        return self._calendar_ready(p, candidate)

    def _event(self, row):
        p = self.policies[row["chat_key"]]
        return WakeEvent(row["id"], p.chat_id, p.mode, row["occurrence_at"], row["created_at"], row["generation"], row["idle_minutes"], row["unanswered"])

    def poll(self, *, now=None):
        """Persist due wake events and return pending events, oldest first.

        Repeating a poll returns the same event id. Missed intervals collapse into
        one event per chat. This method creates no threads, timers, or model calls.
        """
        with self._transaction(now) as (db, moment):
            db.execute("UPDATE events SET status='pending',token=NULL,worker=NULL,lease_until=NULL WHERE status='claimed' AND lease_until<=?", (moment,))
            ready = []
            for p in self.policies.values():
                state = self._ensure(db, p, moment)
                if state is None:
                    continue
                active = db.execute(f"SELECT * FROM events WHERE chat_key=? AND status IN {_ACTIVE}", (p.key,)).fetchone()
                if active is not None and active["status"] != "pending":
                    continue
                target = self._ready(db, p, state, moment)
                if target is None or target > moment:
                    if active is not None:
                        db.execute("UPDATE events SET status='cancelled' WHERE id=?", (active["id"],))
                    if target is not None:
                        db.execute("UPDATE chats SET next_at=MAX(next_at,?) WHERE key=?", (target, p.key))
                    continue
                if active is None:
                    event_id = str(uuid.uuid4())
                    db.execute("INSERT INTO events(id,chat_key,occurrence_at,created_at,generation,idle_minutes,unanswered,status) VALUES (?,?,?,?,?,?,?,'pending')", (event_id, p.key, state["next_at"], moment, state["generation"], max(0, int((moment-state["last_activity"])//60)), state["unanswered"]))
                    active = db.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
                ready.append(self._event(active))
            return sorted(ready, key=lambda e: (e.occurrence_at, e.event_id))

    def claim(self, event_id, worker, *, lease_seconds=60, now=None):
        """Only one worker receives a lease; after expiry unreserved work can resume."""
        ttl = number(lease_seconds, "lease_seconds")
        if ttl <= 0 or not isinstance(worker, str) or not worker:
            raise ValueError("worker and positive lease are required")
        with self._transaction(now) as (db, moment):
            row = db.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
            if row is None or row["chat_key"] not in self.policies:
                return None
            if row["status"] == "claimed" and row["lease_until"] <= moment:
                db.execute("UPDATE events SET status='pending' WHERE id=?", (event_id,))
            elif row["status"] != "pending":
                return None
            state = db.execute("SELECT * FROM chats WHERE key=?", (row["chat_key"],)).fetchone()
            target = self._ready(db, self.policies[row["chat_key"]], state, moment)
            if state["generation"] != row["generation"] or target is None or target > moment:
                db.execute("UPDATE events SET status='cancelled' WHERE id=?", (event_id,))
                return None
            token = str(uuid.uuid4())
            db.execute("UPDATE events SET status='claimed',token=?,worker=?,lease_until=? WHERE id=?", (token, worker, moment + ttl, event_id))
            return Claim(self._event(row), token, worker, moment + ttl)

    def renew(self, event_id, token, *, lease_seconds=60, now=None):
        ttl = number(lease_seconds, "lease_seconds")
        if ttl <= 0:
            raise ValueError("lease must be positive")
        with self._transaction(now) as (db, moment):
            return bool(db.execute("UPDATE events SET lease_until=? WHERE id=? AND token=? AND status='claimed' AND lease_until>?", (moment+ttl, event_id, token, moment)).rowcount)

    def prepare_send(self, event_id, token, *, now=None):
        """Irreversibly reserve one logical send after the external model decision.

        Revalidates policy, activity, lease, sleep and budget atomically immediately
        before an external side effect. Repeating this call never grants permission
        twice. Returning a reservation id is permission for exactly one attempt.
        """
        with self._transaction(now) as (db, moment):
            row = db.execute("SELECT * FROM events WHERE id=? AND token=? AND status='claimed' AND lease_until>?", (event_id, token, moment)).fetchone()
            if row is None or row["chat_key"] not in self.policies:
                return None
            p = self.policies[row["chat_key"]]
            state = db.execute("SELECT * FROM chats WHERE key=?", (p.key,)).fetchone()
            target = self._ready(db, p, state, moment)
            if row["generation"] != state["generation"] or target is None or target > moment:
                db.execute("UPDATE events SET status='cancelled' WHERE id=?", (event_id,))
                return None
            reservation_id = str(uuid.uuid4())
            db.execute("INSERT INTO reservations VALUES (?,?,?,?)", (reservation_id, event_id, p.key, moment))
            db.execute("UPDATE events SET status='reserved',reservation_id=? WHERE id=?", (reservation_id, event_id))
            return reservation_id

    def finish(self, event_id, token, outcome, *, now=None):
        """Record sent, declined, cancelled or uncertain. Duplicate receipts are inert.

        A process crash with status reserved is itself uncertain: there is no lease
        takeover and no automatic resend. resolve_uncertain handles that case too.
        """
        if outcome not in ("sent", "declined", "cancelled", "uncertain"):
            raise ValueError("invalid outcome")
        with self._transaction(now) as (db, moment):
            row = db.execute("SELECT * FROM events WHERE id=? AND token=?", (event_id, token)).fetchone()
            if row is None or row["chat_key"] not in self.policies:
                return False
            allowed = ("reserved",) if outcome in ("sent", "uncertain") else ("claimed", "reserved")
            if row["status"] not in allowed or row["status"] == "claimed" and row["lease_until"] <= moment:
                return False
            db.execute("UPDATE events SET status=? WHERE id=?", (outcome, event_id))
            if outcome != "uncertain":
                self._advance(db, row, outcome == "sent", moment)
            return True

    def _advance(self, db, event, sent, now):
        p = self.policies[event["chat_key"]]
        state = db.execute("SELECT * FROM chats WHERE key=?", (p.key,)).fetchone()
        # A newer incoming message must keep its own timer and cleared count.
        if state["generation"] != event["generation"]:
            return
        if sent:
            db.execute("UPDATE chats SET last_activity=?,next_at=?,unanswered=unanswered+1,generation=generation+1 WHERE key=?", (now, self._schedule(p, now), p.key))
        else:
            db.execute("UPDATE chats SET next_at=? WHERE key=?", (self._schedule(p, now, activity=False), p.key))

    def resolve_uncertain(self, event_id, *, sent, now=None):
        """Operator-verified resolution only. The consumed budget is never refunded."""
        if type(sent) is not bool:
            raise ValueError("sent must be boolean")
        with self._transaction(now) as (db, moment):
            row = db.execute("SELECT * FROM events WHERE id=? AND status IN ('reserved','uncertain')", (event_id,)).fetchone()
            if row is None or row["chat_key"] not in self.policies:
                return False
            db.execute("UPDATE events SET status=? WHERE id=?", ("sent" if sent else "cancelled", event_id))
            self._advance(db, row, sent, moment)
            return True

    def import_legacy_state(self, initiative, budget=None, *, now=None):
        """Explicit one-time import of caller-supplied JSON objects into empty state.

        Never reads legacy paths. Rejects unknown/malformed entries as a unit and
        preserves future next_at, unanswered, sleep and consumed rolling budgets.
        The caller must pass only the opted-in policies' state and hashed budgets.
        """
        from hashlib import sha256
        if not isinstance(initiative, dict) or not isinstance(initiative.get("chats", {}), dict) or budget is not None and not isinstance(budget, dict):
            raise ValueError("legacy state must contain objects")
        with self._transaction(now) as (db, moment):
            if db.execute("SELECT 1 FROM seen WHERE kind='import' AND source_id='legacy-v1'").fetchone():
                return False
            if db.execute("SELECT 1 FROM chats").fetchone() or db.execute("SELECT 1 FROM events").fetchone() or db.execute("SELECT 1 FROM seen").fetchone():
                raise StateError("legacy import requires empty schedule state")
            sleep = number(initiative.get("sleep_until", 0), "sleep_until")
            if sleep < 0:
                raise ValueError("negative legacy sleep")
            for chat, state in initiative.get("chats", {}).items():
                if not isinstance(chat, str) or not isinstance(state, dict):
                    raise ValueError("invalid legacy chat state")
                p = self._policy(chat, state.get("mode", ""))
                last = number(state.get("last_activity"), "last_activity")
                due = number(state.get("next_at"), "next_at")
                count = state.get("unanswered")
                if last < 0 or last > moment or due < 0 or type(count) is not int or count < 0:
                    raise ValueError("invalid/future legacy activity or unanswered count")
                db.execute("INSERT INTO chats VALUES (?,?,?,?,0)", (p.key, last, due, count))
            legacy_keys = {}
            for p in self.policies.values():
                legacy_keys.setdefault(sha256(p.chat_id.encode()).hexdigest(), []).append(p)
            for key, stamps in (budget or {}).items():
                if key not in legacy_keys or not isinstance(stamps, list):
                    raise ValueError("unknown or invalid legacy budget")
                values = [number(v, "budget timestamp") for v in stamps]
                if values != sorted(values) or any(v < 0 or v > moment for v in values):
                    raise ValueError("unordered/future legacy budget")
                for p in legacy_keys[key]:
                    self._ensure(db, p, moment)
                    for stamp in values:
                        event_id, reservation_id = str(uuid.uuid4()), str(uuid.uuid4())
                        db.execute("INSERT INTO events(id,chat_key,occurrence_at,created_at,generation,idle_minutes,unanswered,status,reservation_id) VALUES (?,?,?,?,0,0,0,'sent',?)", (event_id, p.key, stamp, stamp, reservation_id))
                        db.execute("INSERT INTO reservations VALUES (?,?,?,?)", (reservation_id, event_id, p.key, stamp))
            db.execute("UPDATE meta SET value=? WHERE key='owner_sleep_until'", (sleep,))
            db.execute("INSERT INTO seen VALUES ('import','legacy-v1','')")
            return True

    def snapshot(self):
        """Operational state only, without message content or private contact names."""
        with self._connection() as db:
            return {"version": 1, "chats": [dict(r) for r in db.execute("SELECT * FROM chats ORDER BY key")], "events": [dict(r) for r in db.execute("SELECT * FROM events ORDER BY created_at,id")], "reservations": [dict(r) for r in db.execute("SELECT * FROM reservations ORDER BY reserved_at,id")], "meta": {r[0]: r[1] for r in db.execute("SELECT key,value FROM meta")}}

    def next_wakeup(self, *, now=None):
        """Earliest useful host callback time, or None while explicitly blocked.

        Call poll first to seed new chats. Returning now means pending work exists.
        The external host owns arming/cancelling an actual native reminder.
        """
        with self._transaction(now) as (db, moment):
            candidates = []
            for p in self.policies.values():
                state = self._ensure(db, p, moment)
                if state is None:
                    state = db.execute("SELECT * FROM chats WHERE key=?", (p.key,)).fetchone()
                event = db.execute(f"SELECT * FROM events WHERE chat_key=? AND status IN {_ACTIVE}", (p.key,)).fetchone()
                if event is not None:
                    if event["status"] in ("reserved", "uncertain"):
                        continue
                    if event["status"] == "claimed":
                        candidates.append(max(moment, event["lease_until"]))
                        continue
                ready = self._ready(db, p, state, moment)
                if ready is not None:
                    candidates.append(ready)
            return min(candidates) if candidates else None
