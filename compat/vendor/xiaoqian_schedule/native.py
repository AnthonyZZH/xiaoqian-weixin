"""Pure contract for the installed DSH 0.2.1-rc.3 Host scheduler.

No SSH, network, model, native service calls or registrations happen here.
"""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json

from .config import number


class NativeProfileError(RuntimeError):
    pass


_REQUIRED = frozenset({"agents", "sessions", "storageDomain", "sessionController", "sessionPersistence", "schedule"})


@dataclass(frozen=True)
class NativeProfile:
    profile_id: str
    session_id: str
    services: frozenset[str]
    composition: str
    durable_session_store: bool
    flush_acknowledged: bool
    delegation_depth: int = 0

    def require_ready(self):
        if not self.profile_id or not self.session_id:
            raise NativeProfileError("explicit profile and original Session binding are required")
        if self.composition != "native-web" or not _REQUIRED <= self.services:
            raise NativeProfileError("native Web Host services are required; headless is not scheduling support")
        if self.durable_session_store is not True or self.flush_acknowledged is not True:
            raise NativeProfileError("a persistence backend and session/flush acknowledgment are required")
        if type(self.delegation_depth) is not int or self.delegation_depth != 0:
            raise NativeProfileError("delegated Sessions cannot arm native reminders")


class NativeScheduleContract:
    """Build one-shot Host requests; caller executes only in a verified native profile.

    The Host's create method is in-process create(sessionId, request, signal?),
    not an advertised Remote create API. A web/profile integration owns that call.
    """
    schema = "xiaoqian.schedule.tick/v1"

    def __init__(self, profile: NativeProfile):
        profile.require_ready()
        self.profile = profile
        self.marker = json.dumps({"schema": self.schema, "profile_id": profile.profile_id}, sort_keys=True, separators=(",", ":"))

    def create_request(self, wake_at, *, now):
        now, wake_at = number(now, "now"), number(wake_at, "wake_at")
        if wake_at <= now:
            raise ValueError("native at must be strictly future; poll pending work before rearming")
        at = datetime.fromtimestamp(wake_at, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        # Millisecond normalization must not round down into an invalid target.
        if datetime.fromisoformat(at.replace("Z", "+00:00")).timestamp() <= now:
            raise ValueError("target needs at least one future millisecond")
        return {"operation": "schedule.create", "sessionId": self.profile.session_id,
                "request": {"title": "Xiaoqian policy wake", "prompt": self.marker, "at": at}}

    def accept_delivery(self, *, producer_kind, session_id, schedule_id, expected_schedule_id, occurrence_at, reminder_prompt):
        """Validate a parsed native envelope, not arbitrary user-role text.

        DSH may redeliver after Session flush/task-put crashes. Stable delivery_key
        can be stored by the core inbox; poll/claim also deduplicate policy events.
        """
        if producer_kind != "schedule" or session_id != self.profile.session_id:
            raise NativeProfileError("untrusted producer or wrong original Session")
        if not isinstance(schedule_id, str) or not schedule_id or schedule_id != expected_schedule_id:
            raise NativeProfileError("delivery must match the durably recorded Host task id")
        if reminder_prompt != self.marker:
            raise NativeProfileError("delivery belongs to a different policy profile")
        try:
            stamp = datetime.fromisoformat(occurrence_at.replace("Z", "+00:00"))
            if stamp.tzinfo is None or stamp.utcoffset() is None:
                raise ValueError()
            canonical = stamp.astimezone(timezone.utc).isoformat(timespec="milliseconds")
        except (AttributeError, TypeError, ValueError):
            raise NativeProfileError("occurrence_at must be an aware absolute instant") from None
        key = hashlib.sha256((schedule_id + "\0" + canonical).encode()).hexdigest()
        return {"kind": "schedule.tick", "profile_id": self.profile.profile_id, "delivery_key": key, "occurrence_at": canonical}
