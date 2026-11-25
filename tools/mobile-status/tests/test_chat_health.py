import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import local_status_panel as panel


NOW = panel.timestamp("2026-11-25T14:03:00Z")
CONFIG = {"chats": [{"id": "a", "title": "A", "mode": "private"}, {"id": "b", "title": "B", "mode": "private"}],
          "inboxMode": "top-private"}
WATCH = {"pid": 7, "at": "2026-11-25T14:03:00Z", "outcome": "listening"}
START = "2026-11-25T14:00:00Z"


def view(*, chats=None, cursors=None, watch=WATCH):
    status, detail, rows = panel.snapshot(CONFIG, {"chats": chats or {}}, {}, (7, NOW-100), NOW, watch, cursors)
    return status, detail, {key: dict(zip(panel.STATUS_FIELDS, values)) for key, values in rows}


class ChatHealth(unittest.TestCase):
    def test_one_account_stays_pending_while_the_other_listens_or_sends(self):
        cursors = {"a": {"pending": True, "pendingSince": START, "pendingCode": "snapshot_without_order_anchor"},
                   "b": {"unread": 0}}
        chats = {"b": {"lastConfirmedSentAt": START, "lastReceivedAt": START}}
        for current in ("listening", "read_pending"):
            status, detail, rows = view(chats=chats, cursors=cursors, watch=dict(WATCH, outcome=current))
            self.assertIn("1 个会话", status)
            self.assertIn("窗口", detail)
            self.assertIn("3 分钟", rows["a"]["waiting"])
            self.assertEqual(rows["b"]["health"], "首行监听中")
            self.assertEqual(rows["b"]["waiting"], "")
            self.assertEqual(rows["b"]["lastSent"], panel.local_time(panel.timestamp(START)))
        self.assertEqual(view(cursors={})[0], "运行中")

    def test_legacy_pending_and_unknown_counts_are_independent_of_current_delivery(self):
        chats = {"a": {"deliveries": {"1": {"status": "unknown"}, "2": {"status": "unknown", "reviewed": True},
                                       "3": {"status": "sending", "startedAt": START}}},
                 "b": {"messages": {"m": {"grantId": "g", "status": "accepted"}}, "deliveries": {
                     "x": {"grantId": "g", "status": "rejected"}}}}
        status, detail, rows = view(chats=chats, cursors={"a": {"pending": True}})
        self.assertIn("2 个会话", status)
        self.assertIn("1 笔历史", detail)
        self.assertIn("起始时间未记录", rows["a"]["waiting"])
        self.assertIn("等待微信发送回执 · 3 分钟", rows["a"]["waiting"])
        self.assertEqual(rows["a"]["unconfirmedSends"], 1)
        self.assertEqual(rows["b"]["reply"], "发送失败")

    def test_receipt_time_fallback_excludes_unknown_and_marks_old_start_times(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state/"driver").mkdir()
            file = state/"driver/driver.sqlite3"
            with sqlite3.connect(file) as db:
                db.executescript("CREATE TABLE send_scope(operation_id TEXT,chat_key TEXT,reserved_at TEXT);"
                                 "CREATE TABLE sends(operation_id TEXT,status TEXT)")
                scope = hashlib.sha256(json.dumps({"mode":"private","name":"A"},separators=(",",":")).encode()).hexdigest()
                db.executemany("INSERT INTO send_scope VALUES(?,?,?)", [("1",scope,START),("2",scope,WATCH["at"])])
                db.executemany("INSERT INTO sends VALUES(?,?)", [("1","success"),("2","unknown")])
            db.close()
            times = panel.legacy_sent_times(state, CONFIG["chats"])
            self.assertEqual(times, {"a": panel.local_time(panel.timestamp(START)) + "（发起）"})

    def test_stopped_host_explains_supervised_recovery_without_reporting_a_stale_running_state(self):
        state = {"version": 1, "phase": "backoff", "reason": "host_exit", "pid": os.getpid(), "retryAt": WATCH["at"]}
        self.assertEqual(panel.launcher_summary(state, "fallback", NOW)[0], "等待自动恢复")
        self.assertEqual(panel.launcher_summary(dict(state, pid=-1), "fallback", NOW), ("已停止", "fallback"))
        self.assertIn("次数", panel.launcher_summary(dict(state, phase="exhausted"), "", NOW)[1])
        self.assertEqual(panel.launcher_summary(dict(state, phase="running"), "fallback", NOW), ("已停止", "fallback"))
        exhausted = dict(state, phase="exhausted", reason="library_exit", updatedAt=WATCH["at"])
        with_host = panel.snapshot(CONFIG, {}, {}, (7, NOW-100), NOW, WATCH, {}, launcher=exhausted)
        self.assertEqual(with_host[0], "微信运行中 · 记忆库需人工处理")
        stale = panel.snapshot(CONFIG, {}, {}, (7, NOW-1), NOW, WATCH, {}, launcher=dict(exhausted, updatedAt=START))
        self.assertEqual(stale[0], "运行中")


if __name__ == "__main__":
    unittest.main()
