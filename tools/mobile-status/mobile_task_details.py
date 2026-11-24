"""Read step metadata for the tasks already listed by the local owner-task engine."""
from contextlib import closing
from datetime import datetime
from hashlib import sha256
from pathlib import Path
import re
import sqlite3


# The current engine accepts twelve plan steps plus a possible final merge.
MAX_STEPS = 64
RECENT_EVENTS = 256
STEP_STATUSES = {"pending", "running", "succeeded", "failed", "blocked", "cancelled"}


def running_phases(db, task_id):
    # Limit by the existing (taskId,seq) index before looking inside progress events.
    # An older or unknown phase is optional. Never return free-form event notes.
    rows = db.execute("""
        WITH recent AS (
            SELECT seq FROM events WHERE taskId=? ORDER BY seq DESC LIMIT ?
        )
        SELECT e.stepId,
               CASE json_extract(e.data, '$.note')
                   WHEN '子代理启动中' THEN '子代理启动中'
                   WHEN '子代理执行中' THEN '子代理执行中'
               END AS phase
        FROM recent JOIN events e ON e.seq=recent.seq
        JOIN steps s ON s.taskId=e.taskId AND s.id=e.stepId
        WHERE e.type='step_progress' AND s.status='running'
          AND s.attempt=CASE WHEN json_valid(e.data) THEN json_extract(e.data, '$.attempt') END
        ORDER BY e.seq DESC
    """, (task_id, RECENT_EVENTS))
    phases = {}
    for step_id, phase in rows:
        phases.setdefault(step_id, phase)
    return phases


def valid_time(value):
    if value is None:
        return True
    try:
        return isinstance(value, str) and datetime.fromisoformat(value).tzinfo is not None
    except ValueError:
        return False


def task_details(db, task):
    identifier = task.get("id")
    if not isinstance(identifier, str) or not re.fullmatch(r"[1-9][0-9]{0,15}", identifier):
        return None
    task_id = int(identifier)
    if task_id > 9007199254740991:
        return None
    row = db.execute("SELECT createdAt, status, startedAt, finishedAt FROM tasks WHERE id=?", (task_id,)).fetchone()
    if (row is None or row["createdAt"] != task.get("createdAt") or row["status"] != task.get("status")
            or not valid_time(row["startedAt"]) or not valid_time(row["finishedAt"])):
        return None
    version = task.get("version")
    if row["status"] in ("queued", "running") and isinstance(version, str) and re.fullmatch(r"[0-9a-f]{64}", version):
        # Match the native snapshot's run generation even if a retry has the same counts and status.
        try:
            marker = db.execute("""
                SELECT seq FROM events WHERE taskId=? AND type IN ('task_created','task_requeued','task_recovered')
                ORDER BY seq DESC LIMIT 1
            """, (task_id,)).fetchone()
        except sqlite3.OperationalError:
            return None
        if marker is None or sha256(f"{task_id}/{row['createdAt']}/{marker['seq']}".encode()).hexdigest() != version:
            return None
    steps = db.execute("""
        SELECT id, substr(title,1,80) AS title, status, startedAt, finishedAt
        FROM steps WHERE taskId=? ORDER BY ord LIMIT ?
    """, (task_id, MAX_STEPS + 1)).fetchall()
    if (len(steps) > MAX_STEPS or len(steps) != task.get("total")
            or sum(s["status"] == "succeeded" for s in steps) != task.get("completed")):
        return None
    if any(s["status"] not in STEP_STATUSES or not isinstance(s["title"], str)
           or not valid_time(s["startedAt"]) or not valid_time(s["finishedAt"]) for s in steps):
        return None
    phases = {}
    if any(s["status"] == "running" for s in steps):
        try:
            phases = running_phases(db, task_id)
        except sqlite3.OperationalError:
            # Older schemas can still supply the step timeline without progress notes.
            pass
    return {
        "startedAt": row["startedAt"], "finishedAt": row["finishedAt"],
        "steps": [dict(title=s["title"], status=s["status"], startedAt=s["startedAt"],
                       finishedAt=s["finishedAt"], phase=phases.get(s["id"])) for s in steps],
    }


def attach_task_details(tasks, db_path):
    if not isinstance(tasks, list):
        return None
    result = [dict(task, steps=None, startedAt=None, finishedAt=None) if isinstance(task, dict) else task
              for task in tasks]
    if not result or db_path is None:
        return result
    try:
        uri = Path(db_path).resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True, timeout=0.25)) as db:
            db.row_factory = sqlite3.Row
            db.execute("BEGIN")
            for task in result:
                if isinstance(task, dict):
                    details = task_details(db, task)
                    if details is not None:
                        task.update(details)
    except (sqlite3.Error, OSError, ValueError):
        # All prior successful reads were from this same snapshot.
        pass
    return result
