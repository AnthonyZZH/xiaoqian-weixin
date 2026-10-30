"""Owner-only price-band policy overlay; no model or transport dependencies."""
from dataclasses import replace
from datetime import datetime
import json
from pathlib import Path

from xiaoqian_schedule import ScheduleConfig as BaseConfig, Scheduler as BaseScheduler
from xiaoqian_schedule.config import zone

CALENDAR = json.loads(Path(__file__).with_name('calendar-2026.json').read_text(encoding='utf-8'))


def price_band(now):
    dt = datetime.fromtimestamp(now, zone('Asia/Shanghai'))
    if dt.year not in CALENDAR['verified_years']:
        # Holiday set unknown: charge-safe peak cadence on weekdays, known weekend offpeak.
        return 'calendar_unknown' if dt.weekday() < 5 else 'offpeak'
    holiday = any(start <= dt.date().isoformat() <= end for start, end in CALENDAR['holiday_ranges'])
    minute = dt.hour * 60 + dt.minute
    peak = dt.weekday() < 5 and not holiday and (540 <= minute < 720 or 840 <= minute < 1080)
    return 'peak' if peak else 'offpeak'


class ScheduleConfig:
    @staticmethod
    def from_legacy(settings):
        cfg = BaseConfig.from_legacy(settings)
        # Model, UI participation, mute and sleep remain host-owned.
        master=settings.get('initiative_enabled',settings.get('owner_checks_enabled',True))
        if type(master) is not bool:raise ValueError('OWNER_WAKE_MASTER_MUST_BE_BOOL')
        chats = tuple(replace(p, enabled=p.owner and master) for p in cfg.chats)
        if sum(p.owner for p in chats) != 1:
            raise ValueError('EXACTLY_ONE_OWNER_REQUIRED')
        return replace(cfg, chats=chats, timezone_name='Asia/Shanghai',
                       owner_peak_seconds=(1080, 1920), owner_offpeak_seconds=(180, 420),
                       owner_bypass_quiet=True, owner_bypass_budget=True)


class Scheduler(BaseScheduler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        with self._connection() as db:
            db.execute('CREATE TABLE IF NOT EXISTS owner_wake_state (chat_key TEXT PRIMARY KEY, price_band TEXT NOT NULL, next_due REAL, last_wake REAL, decision TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS owner_wake_audit (event_id TEXT PRIMARY KEY, chat_key TEXT NOT NULL, price_band TEXT NOT NULL, last_wake REAL NOT NULL, decision TEXT NOT NULL, decided_at REAL)')
        self._reconcile(startup=True)

    def _schedule(self, p, now, activity=True):
        if not p.owner:
            return super()._schedule(p, now, activity)
        band = price_band(now)
        bounds = (1080, 1920) if band in ('peak', 'calendar_unknown') else (180, 420)
        return now + self.rng.uniform(*bounds)

    def _ready(self, db, p, state, now):
        # Checks stay a model decision even after two unanswered openings.
        # Explicit mute/sleep still win; groups never have timed openings.
        if not p.owner or not p.enabled or p.muted:
            return None
        sleep = db.execute("SELECT value FROM meta WHERE key='owner_sleep_until'").fetchone()[0]
        return max(now, state['next_at'], sleep)

    def _record_schedule(self, db, p, now, decision=None):
        row = db.execute('SELECT next_at FROM chats WHERE key=?', (p.key,)).fetchone()
        if row is None:
            return
        band = price_band(now)
        sleep = db.execute("SELECT value FROM meta WHERE key='owner_sleep_until'").fetchone()[0]
        due = max(row['next_at'], sleep) if p.enabled and not p.muted else None
        db.execute('INSERT INTO owner_wake_state VALUES (?,?,?,NULL,?) ON CONFLICT(chat_key) DO UPDATE SET price_band=excluded.price_band,next_due=excluded.next_due,decision=COALESCE(?,owner_wake_state.decision)',
                   (p.key, band, due, decision or 'scheduled', decision))

    def _reconcile(self, startup=False, now=None):
        with self._transaction(now) as (db, moment):
            band = price_band(moment)
            for p in self.policies.values():
                if not p.owner:
                    continue
                self._ensure(db, p, moment)
                state = db.execute('SELECT * FROM chats WHERE key=?', (p.key,)).fetchone()
                meta = db.execute('SELECT * FROM owner_wake_state WHERE chat_key=?', (p.key,)).fetchone()
                active = db.execute("SELECT * FROM events WHERE chat_key=? AND status IN ('pending','claimed','reserved','uncertain')", (p.key,)).fetchone()
                # Never retry a prepared/uncertain physical side effect.
                if active and active['status'] in ('reserved', 'uncertain'):
                    continue
                rebase = meta is None or (meta['price_band'] != band and active is None)
                rebase = rebase or (startup and (state['next_at'] <= moment or active is not None))
                if rebase:
                    if active:
                        db.execute("UPDATE events SET status='cancelled' WHERE id=?", (active['id'],))
                        db.execute("UPDATE owner_wake_audit SET decision='abandoned_restart',decided_at=? WHERE event_id=? AND decision='awaiting_agent'", (moment, active['id']))
                    db.execute('UPDATE chats SET next_at=? WHERE key=?', (self._schedule(p, moment), p.key))
                    self._record_schedule(db, p, moment, 'scheduled' if meta is None else 'rescheduled')
                elif active is None:
                    self._record_schedule(db, p, moment)

    def _activity(self, db, p, now, clear):
        super()._activity(db, p, now, clear)
        if p.owner:
            db.execute("UPDATE owner_wake_audit SET decision='cancelled_activity',decided_at=? WHERE chat_key=? AND decision='awaiting_agent' AND event_id IN (SELECT id FROM events WHERE status='cancelled')", (now, p.key))
            self._record_schedule(db, p, now, 'scheduled')

    def poll(self, *, now=None):
        self._reconcile(now=now)
        return super().poll(now=now)

    def claim(self, event_id, worker, *, lease_seconds=60, now=None):
        # Audit is written before returning to Host, before any Agent call.
        with self._connection() as db:
            prior = db.execute('SELECT 1 FROM owner_wake_audit WHERE event_id=?', (event_id,)).fetchone()
        if prior:
            with self._transaction(now) as (db, moment):
                event = db.execute('SELECT * FROM events WHERE id=?', (event_id,)).fetchone()
                if event and event['status'] in ('pending', 'claimed') and (event['lease_until'] or 0) <= moment:
                    db.execute("UPDATE events SET status='cancelled' WHERE id=?", (event_id,))
                    p = self.policies[event['chat_key']]
                    db.execute('UPDATE chats SET next_at=? WHERE key=?', (self._schedule(p, moment), p.key))
                    db.execute("UPDATE owner_wake_audit SET decision='abandoned_lease',decided_at=? WHERE event_id=?", (moment, event_id))
                    self._record_schedule(db, p, moment, 'abandoned_lease')
            return None
        claim = super().claim(event_id, worker, lease_seconds=lease_seconds, now=now)
        if claim:
            moment = self.clock() if now is None else now
            with self._transaction(moment) as (db, moment):
                db.execute('INSERT INTO owner_wake_audit VALUES (?,?,?,?,?,NULL)', (event_id, claim.event.chat_id and self._policy(claim.event.chat_id, claim.event.mode).key, price_band(moment), moment, 'awaiting_agent'))
                db.execute("UPDATE owner_wake_state SET last_wake=?,decision='awaiting_agent',next_due=NULL WHERE chat_key=?", (moment, self._policy(claim.event.chat_id, claim.event.mode).key))
        return claim

    def _advance(self, db, event, sent, now):
        super()._advance(db, event, sent, now)
        p = self.policies[event['chat_key']]
        if p.owner:
            status = getattr(self, '_finish_reasons', {}).get(event['id']) or db.execute('SELECT status FROM events WHERE id=?', (event['id'],)).fetchone()[0]
            db.execute('UPDATE owner_wake_audit SET decision=?,decided_at=? WHERE event_id=?', (status, now, event['id']))
            self._record_schedule(db, p, now, status)

    def finish(self, event_id, token, outcome, *, now=None, decision=None):
        if decision not in (None, 'decision_timeout', 'completed_without_decision') or decision and outcome != 'declined':
            raise ValueError('invalid decision reason')
        self._finish_reasons = getattr(self, '_finish_reasons', {})
        if decision:
            self._finish_reasons[event_id] = decision
        try:
            result = super().finish(event_id, token, outcome, now=now)
        finally:
            self._finish_reasons.pop(event_id, None)
        if result and outcome == 'uncertain':
            with self._transaction(now) as (db, moment):
                db.execute("UPDATE owner_wake_audit SET decision='uncertain',decided_at=? WHERE event_id=?", (moment, event_id))
                db.execute("UPDATE owner_wake_state SET decision='uncertain',next_due=NULL WHERE chat_key=(SELECT chat_key FROM events WHERE id=?)", (event_id,))
        return result

    def snapshot(self):
        out = super().snapshot()
        with self._connection() as db:
            out['owner_wake_state'] = [dict(r) for r in db.execute('SELECT * FROM owner_wake_state')]
            out['owner_wake_audit'] = [dict(r) for r in db.execute('SELECT * FROM owner_wake_audit ORDER BY last_wake')]
        return out
