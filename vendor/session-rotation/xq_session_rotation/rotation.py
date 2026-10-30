"""Durable per-conversation coordination; every external capability is injected."""
from contextlib import contextmanager
from dataclasses import asdict, dataclass
import hashlib
import json
from pathlib import Path
import sqlite3
import time


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class OutcomeUnknown(RuntimeError):
    """A side effect may have committed; reconcile before any retry."""


class UnsafePoint(RuntimeError):
    pass


@dataclass(frozen=True)
class Snapshot:
    conversation_id: str
    session_id: str
    agent_id: str
    revision: str
    inbound_revision: str
    completed_turns: int
    observed_tokens: int
    # (stable message ID, role, text), in original append order.
    transcript: tuple
    persona_version: str
    persona_text: str
    owner_id: str
    owner_permissions: tuple
    unfinished_tasks: tuple
    recent_handoff: tuple
    dedup_map: tuple

    def __post_init__(self):
        for name in ("conversation_id", "session_id", "agent_id", "revision", "inbound_revision", "persona_version", "persona_text", "owner_id"):
            if not isinstance(getattr(self, name), str) or not getattr(self, name):
                raise ValueError(name + " must be nonempty")
        if any(type(v) is not int or v < 0 for v in (self.completed_turns, self.observed_tokens)):
            raise ValueError("counters must be nonnegative lifetime counters")
        for name in ("transcript", "owner_permissions", "unfinished_tasks", "recent_handoff", "dedup_map"):
            if not isinstance(getattr(self, name), tuple):
                raise ValueError(name + " must be an immutable tuple")
        if any(not isinstance(row, tuple) or len(row) != 3 or any(not isinstance(v, str) for v in row) or not row[0] for row in self.transcript):
            raise ValueError("transcript requires immutable (id,role,text) records")
        if len({r[0] for r in self.transcript}) != len(self.transcript):
            raise ValueError("duplicate transcript IDs")
        if any(not isinstance(v, str) for values in (self.owner_permissions, self.unfinished_tasks, self.recent_handoff) for v in values):
            raise ValueError("handoff entries must be strings")
        if any(not isinstance(row, tuple) or len(row) != 2 or any(not isinstance(v, str) or not v for v in row) for row in self.dedup_map):
            raise ValueError("invalid dedup mapping")
        if len({r[0] for r in self.dedup_map}) != len(self.dedup_map):
            raise ValueError("conflicting dedup mapping")

    @property
    def payload(self):
        return canonical({"schema": "xq.rotation.archive/v1", **asdict(self)})

    @property
    def digest(self):
        return digest(self.payload)


@dataclass(frozen=True)
class Summary:
    text: str
    evidence_ids: tuple
    snapshot_digest: str

    def validate(self, snapshot):
        if not self.text or self.snapshot_digest != snapshot.digest:
            raise ValueError("summary does not bind to the snapshot")
        if not isinstance(self.evidence_ids, tuple) or not set(self.evidence_ids) <= {r[0] for r in snapshot.transcript}:
            raise ValueError("summary citations are not in the archive")
        if snapshot.transcript and not self.evidence_ids:
            raise ValueError("summary needs archive evidence references")


@dataclass(frozen=True)
class Agent:
    agent_id: str
    handoff_payload: str
    dormant: bool


@dataclass(frozen=True)
class Switch:
    operation_id: str
    old_agent_id: str
    new_agent_id: str
    committed: bool
    snapshot_digest: str


@dataclass(frozen=True)
class SafetyPolicy:
    min_seconds_between: float = 3600
    min_completed_turns: int = 8
    min_observed_tokens: int = 1024
    failure_backoff_seconds: float = 300

    def __post_init__(self):
        import math
        if isinstance(self.min_seconds_between, bool) or not math.isfinite(self.min_seconds_between) or self.min_seconds_between < 0:
            raise ValueError("invalid rotation cooldown")
        if isinstance(self.failure_backoff_seconds, bool) or not math.isfinite(self.failure_backoff_seconds) or self.failure_backoff_seconds < 0:
            raise ValueError("invalid failure backoff")
        if any(type(v) is not int or v < 0 for v in (self.min_completed_turns, self.min_observed_tokens)):
            raise ValueError("invalid rotation thresholds")


@dataclass(frozen=True)
class RotationResult:
    status: str
    operation_id: str
    reason: str
    active_agent_id: str | None
    old_agent_retained: bool = True


class RotationJournal:
    """Contains opaque IDs, hashes and stage/error codes, never transcript text."""
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.transaction() as db:
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version == 0:
                if db.execute("SELECT 1 FROM sqlite_master WHERE type='table'").fetchone():
                    raise ValueError("foreign database")
                db.execute("CREATE TABLE operations (id TEXT PRIMARY KEY, conversation TEXT NOT NULL, snapshot TEXT NOT NULL, old_agent TEXT NOT NULL, new_agent TEXT, status TEXT NOT NULL, stage TEXT NOT NULL, code TEXT NOT NULL, started REAL NOT NULL, changed REAL NOT NULL)")
                db.execute("CREATE UNIQUE INDEX one_rotation ON operations(conversation) WHERE status IN ('running','uncertain')")
                db.execute("CREATE TABLE events (id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL, stage TEXT NOT NULL, code TEXT NOT NULL, at REAL NOT NULL)")
                db.execute("CREATE TABLE cooldown (conversation TEXT PRIMARY KEY, last_at REAL NOT NULL, turns INTEGER NOT NULL, tokens INTEGER NOT NULL)")
                db.execute("PRAGMA user_version=1")
            elif version != 1:
                raise ValueError("unsupported rotation database")
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("corrupt rotation database")

    @contextmanager
    def transaction(self):
        db = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA synchronous=FULL")
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        finally:
            if db.in_transaction:
                db.rollback()
            db.close()

    def get(self, operation):
        with self.transaction() as db:
            row = db.execute("SELECT * FROM operations WHERE id=?", (operation,)).fetchone()
            return dict(row) if row else None

    def start(self, operation, snapshot, policy, now):
        with self.transaction() as db:
            row = db.execute("SELECT * FROM operations WHERE id=?", (operation,)).fetchone()
            if row:
                return "existing"
            if db.execute("SELECT 1 FROM operations WHERE conversation=? AND status IN ('running','uncertain')", (snapshot.conversation_id,)).fetchone():
                return "reconciliation_pending"
            failed_at = db.execute("SELECT MAX(changed) FROM operations WHERE conversation=? AND status=\'failed\'", (snapshot.conversation_id,)).fetchone()[0]
            if failed_at is not None:
                if now < failed_at:
                    return "clock_regression"
                if now - failed_at < policy.failure_backoff_seconds:
                    return "failure_backoff"
            previous = db.execute("SELECT * FROM cooldown WHERE conversation=?", (snapshot.conversation_id,)).fetchone()
            if previous:
                if now < previous["last_at"]:
                    return "clock_regression"
                if now - previous["last_at"] < policy.min_seconds_between:
                    return "cooldown"
                if snapshot.completed_turns - previous["turns"] < policy.min_completed_turns:
                    return "turn_hysteresis"
                if snapshot.observed_tokens - previous["tokens"] < policy.min_observed_tokens:
                    return "context_hysteresis"
            elif snapshot.completed_turns < policy.min_completed_turns or snapshot.observed_tokens < policy.min_observed_tokens:
                return "initial_hysteresis"
            db.execute("INSERT INTO operations VALUES (?,?,?,?,NULL,'running','candidate','started',?,?)",
                       (operation, snapshot.conversation_id, snapshot.digest, snapshot.agent_id, now, now))
            db.execute("INSERT INTO events(operation_id,stage,code,at) VALUES (?,'candidate','started',?)", (operation, now))
            return "started"

    def record(self, operation, stage, code, now, *, status=None, new_agent=None):
        with self.transaction() as db:
            db.execute("UPDATE operations SET stage=?,code=?,changed=?,status=COALESCE(?,status),new_agent=COALESCE(?,new_agent) WHERE id=?",
                       (stage, code, now, status, new_agent, operation))
            db.execute("INSERT INTO events(operation_id,stage,code,at) VALUES (?,?,?,?)", (operation, stage, code, now))

    def committed(self, operation, snapshot, new_agent, now):
        with self.transaction() as db:
            db.execute("UPDATE operations SET status='committed',stage='commit',code='confirmed',new_agent=?,changed=? WHERE id=?", (new_agent, now, operation))
            db.execute("INSERT INTO cooldown VALUES (?,?,?,?) ON CONFLICT(conversation) DO UPDATE SET last_at=excluded.last_at,turns=excluded.turns,tokens=excluded.tokens",
                       (snapshot.conversation_id, now, snapshot.completed_turns, snapshot.observed_tokens))
            db.execute("INSERT INTO events(operation_id,stage,code,at) VALUES (?,'commit','confirmed',?)", (operation, now))

    def logs(self, operation):
        with self.transaction() as db:
            return [dict(r) for r in db.execute("SELECT stage,code,at FROM events WHERE operation_id=? ORDER BY id", (operation,))]


REQUIRED = frozenset({"safe_point_fencing", "dormant_agent", "idempotent_create_lookup",
                      "atomic_route_activate", "idempotent_commit_lookup", "retain_old_agent", "conversation_uncertainty_gate"})


class RotationCoordinator:
    """Ports are contracts, not live integrations; absent capabilities block work."""
    def __init__(self, journal, library, sessions, summarizer, *, policy=SafetyPolicy(), clock=time.time):
        self.journal, self.library, self.sessions, self.summarizer = journal, library, sessions, summarizer
        self.policy, self.clock = policy, clock

    @staticmethod
    def operation_id(snapshot):
        return "rotation-" + digest(snapshot.conversation_id + "\0" + snapshot.agent_id + "\0" + snapshot.digest)

    def _switch_valid(self, receipt, operation, snapshot, new_agent=None):
        return isinstance(receipt, Switch) and receipt.committed and receipt.operation_id == operation and receipt.old_agent_id == snapshot.agent_id and receipt.snapshot_digest == snapshot.digest and bool(receipt.new_agent_id) and (new_agent is None or receipt.new_agent_id == new_agent)

    def rotate(self, snapshot, decision):
        import math
        operation = self.operation_id(snapshot)
        now = self.clock()
        if not math.isfinite(now) or now < 0:
            raise ValueError("invalid clock")
        if decision.snapshot_digest != snapshot.digest or decision.recommendation != "rotate_next_turn":
            return RotationResult("kept_old", operation, "economic_permission_missing", snapshot.agent_id)
        if getattr(self.library, "connected", False) is not True:
            return RotationResult("kept_old", operation, "library_not_connected", snapshot.agent_id)
        if not REQUIRED <= set(getattr(self.sessions, "capabilities", ())):
            return RotationResult("kept_old", operation, "session_adapter_capabilities_missing", snapshot.agent_id)
        admission = self.journal.start(operation, snapshot, self.policy, now)
        if admission == "existing":
            row = self.journal.get(operation)
            active = row["new_agent"] if row["status"] == "committed" else None if row["status"] in ("running", "uncertain") else snapshot.agent_id
            return RotationResult(row["status"], operation, "durable_existing_operation_no_retry", active)
        if admission != "started":
            return RotationResult("kept_old", operation, admission, snapshot.agent_id)
        lease, stage, confirmed = None, "safe_point", None
        try:
            lease = self.sessions.acquire_safe_point(snapshot, operation)
            if lease is None:
                raise UnsafePoint("busy")
            self.journal.record(operation, stage, "acquired", self.clock())
            stage = "archive"
            archive_id = self.library.write("archive", operation + "/archive", snapshot.payload)
            if not archive_id or self.library.read(archive_id) != snapshot.payload:
                raise ValueError("archive readback mismatch")
            self.journal.record(operation, stage, "readback_verified", self.clock())
            stage = "summary"
            summary = self.summarizer.build(snapshot, archive_id, operation + "/summary")
            summary.validate(snapshot)
            summary_payload = canonical({"schema": "xq.rotation.summary/v1", "snapshot_digest": snapshot.digest,
                                         "archive_id": archive_id, "archive_digest": snapshot.digest,
                                         "revision": snapshot.revision, **asdict(summary)})
            summary_id = self.library.write("summary", operation + "/summary", summary_payload)
            if not summary_id or self.library.read(summary_id) != summary_payload:
                raise ValueError("summary readback mismatch")
            self.journal.record(operation, stage, "readback_verified", self.clock())
            handoff = canonical({
                "schema": "xq.rotation.handoff/v1", "operation_id": operation,
                "conversation_id": snapshot.conversation_id, "previous_session_id": snapshot.session_id,
                "previous_agent_id": snapshot.agent_id, "snapshot_revision": snapshot.revision,
                "inbound_revision": snapshot.inbound_revision, "snapshot_digest": snapshot.digest,
                "archive_id": archive_id, "archive_digest": snapshot.digest,
                "summary_id": summary_id, "summary": asdict(summary),
                "persona_version": snapshot.persona_version, "persona_text": snapshot.persona_text,
                "owner_id": snapshot.owner_id, "owner_permissions": snapshot.owner_permissions,
                "unfinished_tasks": snapshot.unfinished_tasks, "recent_handoff": snapshot.recent_handoff,
                "dedup_map": snapshot.dedup_map, "completed_turns": snapshot.completed_turns,
                "observed_tokens": snapshot.observed_tokens,
            })
            stage = "create"
            if not self.sessions.is_current(lease, snapshot):
                raise UnsafePoint("revision_changed")
            # Stable key across a timeout. Lookup must distinguish absence from unknown.
            try:
                created = self.sessions.create_dormant(handoff, operation)
            except OutcomeUnknown:
                created = self.sessions.lookup_created(operation)
                if created is None:
                    raise RuntimeError("create_confirmed_absent")
            if not isinstance(created, Agent) or not created.agent_id:
                raise ValueError("invalid created agent")
            actual = self.sessions.read_agent(created.agent_id)
            if actual.handoff_payload != handoff or actual.dormant is not True or actual.agent_id != created.agent_id:
                raise ValueError("agent handoff or dormant state mismatch")
            self.journal.record(operation, stage, "handoff_verified", self.clock(), new_agent=created.agent_id)
            stage = "commit"
            if not self.sessions.is_current(lease, snapshot):
                raise UnsafePoint("revision_changed")
            try:
                receipt = self.sessions.commit_rotation(lease, snapshot, created.agent_id, operation)
            except OutcomeUnknown:
                receipt = self.sessions.lookup_switch(operation)
                if receipt is None:
                    raise RuntimeError("commit_confirmed_absent")
            if not self._switch_valid(receipt, operation, snapshot, created.agent_id):
                # A malformed receipt does not establish whether a commit happened.
                raise OutcomeUnknown("unconfirmed_commit_receipt")
            confirmed = receipt
            self.journal.committed(operation, snapshot, created.agent_id, self.clock())
            return RotationResult("committed", operation, "archive_summary_handoff_and_switch_verified", created.agent_id)
        except Exception as error:
            uncertain = isinstance(error, OutcomeUnknown) or confirmed is not None
            status = "uncertain" if uncertain else "failed"
            code = type(error).__name__
            if uncertain and stage == "commit":
                try:
                    self.sessions.contain_uncertain(snapshot.conversation_id, operation)
                except Exception:
                    code = "containment_unconfirmed"
            try:
                self.journal.record(operation, stage, code, self.clock(), status=status)
            except Exception:
                # Cannot promise a log was persisted after a storage failure.
                return RotationResult("uncertain", operation, "journal_write_failed_reconcile_required", confirmed.new_agent_id if confirmed else None)
            return RotationResult(status, operation, stage + ":" + code,
                                  confirmed.new_agent_id if confirmed else None if stage == "commit" and uncertain else snapshot.agent_id)
        finally:
            if lease is not None:
                try:
                    # This releases a fence; it must never reactivate the old Agent.
                    self.sessions.release_safe_point(lease, operation)
                except Exception as error:
                    try:
                        self.journal.record(operation, "release", type(error).__name__, self.clock())
                    except Exception:
                        pass

    def reconcile(self, snapshot, *, execution_stopped=False):
        """Read-only external reconciliation; never recreates or blindly rolls back.

        A known-uncommitted operation is closed as failed. A later fresh snapshot
        can be reconsidered; the same snapshot never reruns side effects.
        """
        operation = self.operation_id(snapshot)
        if execution_stopped is not True:
            return RotationResult("uncertain", operation, "confirm_worker_stopped_before_reconciliation", None)
        row = self.journal.get(operation)
        if row is None:
            return RotationResult("kept_old", operation, "no_operation", snapshot.agent_id)
        if row["status"] == "committed":
            try:
                self.sessions.release_operation_fence(operation)
                self.sessions.clear_uncertain(snapshot.conversation_id, operation)
            except Exception:
                return RotationResult("uncertain", operation, "committed_fence_release_unconfirmed", row["new_agent"])
            return RotationResult("committed", operation, "already_recorded", row["new_agent"])
        try:
            receipt = self.sessions.lookup_switch(operation)
            if receipt is not None:
                if not self._switch_valid(receipt, operation, snapshot, row["new_agent"]):
                    raise OutcomeUnknown("invalid_switch_lookup")
                self.journal.committed(operation, snapshot, receipt.new_agent_id, self.clock())
                self.sessions.release_operation_fence(operation)
                self.sessions.clear_uncertain(snapshot.conversation_id, operation)
                return RotationResult("committed", operation, "commit_reconciled", receipt.new_agent_id)
            if self.sessions.current_agent(snapshot.conversation_id) != snapshot.agent_id:
                raise OutcomeUnknown("route_does_not_match_old")
            self.sessions.release_operation_fence(operation)
            self.sessions.clear_uncertain(snapshot.conversation_id, operation)
            self.journal.record(operation, "reconcile", "old_route_confirmed", self.clock(), status="failed")
            return RotationResult("kept_old", operation, "uncommitted_old_route_confirmed_no_retry", snapshot.agent_id)
        except Exception as error:
            self.journal.record(operation, "reconcile", type(error).__name__, self.clock(), status="uncertain")
            return RotationResult("uncertain", operation, "reconciliation_incomplete", None)
