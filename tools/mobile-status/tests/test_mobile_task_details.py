import json
from hashlib import sha256
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mobile_task_details as details


CREATED = "2026-11-20T09:00:00.000Z"
STARTED = "2026-11-20T09:01:00.000Z"
FINISHED = "2026-11-20T09:02:00.000Z"


class TaskDetails(unittest.TestCase):
    def setUp(self):
        temp = self.enterContext(tempfile.TemporaryDirectory())
        self.path = Path(temp) / "任务 #1.sqlite3"
        self.writer = sqlite3.connect(self.path)
        self.addCleanup(self.writer.close)
        self.writer.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA wal_autocheckpoint=0;
            CREATE TABLE tasks (id INTEGER PRIMARY KEY, createdAt TEXT, status TEXT, startedAt TEXT,
                finishedAt TEXT, request TEXT DEFAULT 'private request');
            CREATE TABLE steps (taskId INTEGER, id TEXT, ord INTEGER, title TEXT, status TEXT, attempt INTEGER,
                startedAt TEXT, finishedAt TEXT, args TEXT DEFAULT 'private args', error TEXT DEFAULT 'private error',
                artifact TEXT DEFAULT 'private artifact', PRIMARY KEY(taskId,id));
            CREATE TABLE events (seq INTEGER PRIMARY KEY, taskId INTEGER, stepId TEXT, type TEXT, data TEXT);
            CREATE INDEX events_task ON events(taskId,seq);
        """)

    def task(self, task_id, status="running", *, total=1, completed=0):
        finished = FINISHED if status in {"succeeded", "failed", "cancelled"} else None
        self.writer.execute("INSERT INTO tasks(id,createdAt,status,startedAt,finishedAt) VALUES(?,?,?,?,?)",
                            (task_id, CREATED, status, STARTED, finished))
        marker = self.writer.execute("INSERT INTO events(taskId,type,data) VALUES(?,'task_created','{}')",
                                     (task_id,)).lastrowid
        version = sha256(f"{task_id}/{CREATED}/{marker}".encode()).hexdigest() if status in ("queued", "running") else None
        return {"id": str(task_id), "title": "任务", "status": status, "createdAt": CREATED, "completed": completed,
                "total": total, "version": version, "canCancel": version is not None}

    def step(self, task_id, step_id, order, status, attempt=1):
        started = STARTED if status in {"running", "succeeded", "failed"} else None
        finished = FINISHED if status in {"succeeded", "failed", "cancelled"} else None
        self.writer.execute("""
            INSERT INTO steps(taskId,id,ord,title,status,attempt,startedAt,finishedAt)
            VALUES(?,?,?,?,?,?,?,?)
        """, (task_id, step_id, order, "步骤 " + step_id, status, attempt, started, finished))

    def progress(self, task_id, step_id, attempt, note):
        self.writer.execute("INSERT INTO events(taskId,stepId,type,data) VALUES(?,?,'step_progress',?)",
                            (task_id, step_id, json.dumps({"attempt": attempt, "note": note, "trace": "private trace"})))

    def test_parallel_steps_follow_order_and_report_only_safe_current_attempt_phases(self):
        task = self.task(7, total=5, completed=1)
        self.step(7, "b", 3, "running", 2)
        self.step(7, "prev", 0, "succeeded")
        self.step(7, "a", 1, "running")
        self.step(7, "start", 2, "running")
        self.step(7, "pending", 4, "pending", 0)
        self.progress(7, "a", 1, "子代理执行中")
        self.progress(7, "b", 1, "子代理执行中")
        self.progress(7, "b", 2, "子代理启动中")
        self.progress(7, "b", 2, "private note")
        self.progress(7, "start", 1, "子代理启动中")
        self.progress(7, "start", 99, "子代理执行中")
        self.progress(7, "prev", 1, "子代理执行中")
        self.writer.commit()
        result, = details.attach_task_details([task], self.path)
        self.assertNotIn("steps", task)
        self.assertEqual({k: result[k] for k in task}, task)
        self.assertEqual((result["startedAt"], result["finishedAt"]), (STARTED, None))
        rows = result["steps"]
        self.assertEqual([s["title"] for s in rows], ["步骤 prev", "步骤 a", "步骤 start", "步骤 b", "步骤 pending"])
        self.assertEqual([s["phase"] for s in rows], [None, "子代理执行中", "子代理启动中", None, None])
        self.assertEqual(rows[0], {"title": "步骤 prev", "status": "succeeded", "startedAt": STARTED,
                                   "finishedAt": FINISHED, "phase": None})
        self.assertNotIn("private", json.dumps(result, ensure_ascii=False))

    def test_failed_and_blocked_steps_and_stale_native_rows(self):
        failed = self.task(1, "failed", total=2)
        self.step(1, "work", 0, "failed")
        self.step(1, "depends", 1, "blocked")
        self.writer.commit()
        stale = [dict(failed, id="2"), dict(failed, createdAt=STARTED), dict(failed, status="running"),
                 dict(failed, completed=1), dict(failed, total=3)]
        matching, *unavailable = details.attach_task_details([failed, *stale], self.path)
        self.assertEqual(matching["finishedAt"], FINISHED)
        self.assertEqual([s["status"] for s in matching["steps"]], ["failed", "blocked"])
        self.assertEqual(matching["steps"][1]["startedAt"], None)
        for native, row in zip(stale, unavailable, strict=True):
            self.assertEqual(row, dict(native, steps=None, startedAt=None, finishedAt=None))

    def test_committed_wal_updates_are_visible_only_after_the_current_snapshot(self):
        first, second = self.task(1), self.task(2)
        for task_id in (1, 2):
            self.step(task_id, "s1", 0, "running")
        self.writer.commit()
        original = details.task_details

        def with_writer(db, task):
            result = original(db, task)
            if task["id"] == "1":
                self.writer.execute("UPDATE tasks SET status='succeeded', finishedAt=? WHERE id=2", (FINISHED,))
                self.writer.execute("UPDATE steps SET status='succeeded', finishedAt=? WHERE taskId=2", (FINISHED,))
                self.writer.commit()
            return result

        with patch.object(details, "task_details", side_effect=with_writer):
            rows = details.attach_task_details([first, second], self.path)
        self.assertEqual([row["steps"][0]["status"] for row in rows], ["running", "running"])
        updated = dict(second, status="succeeded", completed=1, canCancel=False)
        row, = details.attach_task_details([updated], self.path)
        self.assertEqual(row["steps"][0]["finishedAt"], FINISHED)
        self.assertEqual(row["finishedAt"], FINISHED)

    def test_retry_with_unchanged_counts_and_status_invalidates_pre_retry_details(self):
        before = self.task(4)
        self.step(4, "one", 0, "running")
        self.writer.commit()
        self.assertIsNotNone(details.attach_task_details([before], self.path)[0]["steps"])
        marker = self.writer.execute("INSERT INTO events(taskId,type,data) VALUES(4,'task_requeued','{}')").lastrowid
        self.writer.execute("UPDATE steps SET attempt=2 WHERE taskId=4")
        self.progress(4, "one", 2, "子代理执行中")
        self.writer.commit()
        after = dict(before, version=sha256(f"4/{CREATED}/{marker}".encode()).hexdigest())
        stale, current = details.attach_task_details([before, after], self.path)
        self.assertIsNone(stale["steps"])
        self.assertEqual(stale["version"], before["version"])
        self.assertEqual(current["steps"][0]["phase"], "子代理执行中")

    def test_missing_db_and_invalid_schema_preserve_control_fields_without_creating_a_db(self):
        task = self.task(1)
        missing = self.path.with_name("missing.sqlite3")
        row, = details.attach_task_details([task], missing)
        self.assertFalse(missing.exists())
        self.assertEqual(row, dict(task, steps=None, startedAt=None, finishedAt=None))
        self.writer.execute("DROP TABLE steps")
        self.writer.commit()
        self.assertEqual(details.attach_task_details([task], self.path), [row])
        self.assertEqual(details.attach_task_details([], missing), [])
        self.assertIsNone(details.attach_task_details(None, missing))

    def test_missing_optional_events_keeps_step_details(self):
        task = dict(self.task(1), version=None, canCancel=False)
        self.step(1, "work", 0, "running")
        self.writer.execute("DROP TABLE events")
        self.writer.commit()
        result, = details.attach_task_details([task], self.path)
        self.assertEqual(result["steps"][0]["status"], "running")
        self.assertIsNone(result["steps"][0]["phase"])


if __name__ == "__main__":
    unittest.main()
