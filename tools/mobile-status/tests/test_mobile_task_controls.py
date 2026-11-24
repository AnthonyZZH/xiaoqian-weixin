import http.client
import json
import socket
import sys
import threading
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mobile_status_server as panel


INSTANCE = "00000000-0000-4000-8000-000000000001"
VERSION = "b" * 64
ORIGIN = "http://127.0.0.1:8791"
TASK = {
    "id": "7", "title": "测试任务" * 30, "status": "running", "completed": 1, "total": 3,
    "createdAt": "2026-11-01T09:10:11.000Z", "version": VERSION, "canCancel": True,
    "prompt": "private test input", "artifact": "private test result",
}
TARGET = {"instance": INSTANCE, "id": "7", "version": VERSION}
STEP = {"title": "核对清单", "status": "running", "startedAt": TASK["createdAt"],
        "finishedAt": None, "phase": "子代理执行中"}


class MobileTaskControls(unittest.TestCase):
    def setUp(self):
        with patch.object(panel, "PORT", 0), patch.object(panel, "viewer_key", side_effect=[b"reader", b"manager"]):
            self.site = panel.StatusSite()
        self.addCleanup(self.site.server_close)
        thread = threading.Thread(target=self.site.serve_forever, kwargs={"poll_interval": 0.01})
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.site.shutdown)
        self.native = self.enterContext(patch.object(panel, "native", return_value={"instance": INSTANCE, "tasks": [TASK]}))
        self.enterContext(patch.object(panel, "current_status", return_value=("运行中", "监听中", [], None, 123)))
        state_dir = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.object(panel, "bridge_config", return_value={"stateDir": state_dir}))

    def request(self, path="/api/status", *, key="reader", payload=None, origin=ORIGIN, kind="application/json"):
        method = "GET" if payload is None else "POST"
        body = b"" if payload is None else json.dumps(payload).encode()
        headers = {"Host": "127.0.0.1", "Content-Type": kind, "Content-Length": str(len(body))}
        if key:
            headers["Authorization"] = "Bearer " + key
        if origin:
            headers["Origin"] = origin
        lines = [f"{method} {path} HTTP/1.1", *(f"{k}: {v}" for k, v in headers.items()), "", ""]
        # Send these small requests together so early rejections cannot race a separate body write.
        with socket.create_connection(self.site.server_address, timeout=2) as connection:
            connection.sendall("\r\n".join(lines).encode() + body)
            with http.client.HTTPResponse(connection) as response:
                response.begin()
                reply = response.read()
                return response.status, json.loads(reply) if reply else None

    def test_status_limits_reader_and_manager_fields_even_with_shared_cache(self):
        self.assertEqual(self.request(key=None)[0], 401)
        def add_steps(tasks, database):
            self.assertNotIn("prompt", tasks[0])
            self.assertNotIn("artifact", tasks[0])
            return [dict(tasks[0], steps=[STEP], startedAt=STEP["startedAt"], finishedAt=None)]
        details = self.enterContext(patch.object(panel, "attach_task_details", side_effect=add_steps))
        status, manager = self.request(key="manager")
        self.assertEqual(status, 200)
        reader_summary = {k: TASK[k] for k in ("id", "status", "completed", "total", "createdAt")}
        reader_summary.update(title=TASK["title"][:80], steps=[STEP], startedAt=STEP["startedAt"], finishedAt=None)
        manager_summary = dict(reader_summary, version=VERSION, canCancel=True)
        self.assertEqual(manager["tasks"], [manager_summary])
        status, reader = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(reader["tasks"], [reader_summary])
        self.assertNotIn("instance", reader)
        self.native.assert_called_once_with("/state")
        details.assert_called_once()

    def test_missing_details_still_shows_task_title_and_manager_action(self):
        status, reader = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(reader["tasks"][0]["title"], TASK["title"][:80])
        self.assertIsNone(reader["tasks"][0]["steps"])
        self.assertNotIn("canCancel", reader["tasks"][0])
        self.assertTrue(self.request(key="manager")[1]["tasks"][0]["canCancel"])

    def test_offline_and_older_backends_are_distinct_from_empty_queue(self):
        self.native.side_effect = [panel.ControlError(503, "离线"), {}, {"tasks": None}, {"tasks": []}]
        for expected in (None, None, None, []):
            self.site.expires = 0
            status, view = self.request()
            self.assertEqual(status, 200)
            self.assertEqual(view["tasks"], expected)

    def test_cancel_requires_manager_browser_origin_and_json(self):
        for key, origin, kind, expected in (
                ("reader", ORIGIN, "application/json", 403), (None, ORIGIN, "application/json", 403),
                ("manager", None, "application/json", 403), ("manager", "https://example.com", "application/json", 403),
                ("manager", ORIGIN, "text/plain", 415)):
            with self.subTest(key=key, origin=origin, kind=kind):
                status, _ = self.request("/api/cancel-task", key=key, payload=TARGET, origin=origin, kind=kind)
                self.assertEqual(status, expected)
        self.native.assert_not_called()

    def test_cancel_rejects_wildcards_malformed_or_incomplete_targets(self):
        invalid = [{"instance": INSTANCE}, {**TARGET, "all": True}, {**TARGET, "version": "x" * 64},
                   {**TARGET, "instance": "-" * 36}, *({**TARGET, "id": value} for value in
                   ("*", "all", "01", "0", "-1", "9007199254740992", "1/../restart", 7, True))]
        for payload in invalid:
            with self.subTest(payload=payload):
                self.assertEqual(self.request("/api/cancel-task", key="manager", payload=payload)[0], 400)
        self.assertEqual(self.request("/api/stop", key="manager", payload=TARGET)[0], 404)
        self.native.assert_not_called()

    def test_forwards_only_the_versioned_task_and_preserves_stale_conflict(self):
        self.native.return_value = {"message": "任务已取消。"}
        self.assertEqual(self.request("/api/cancel-task", key="manager", payload=TARGET),
                         (202, {"message": "任务已取消。"}))
        self.native.assert_called_once_with("/cancel-task", TARGET)
        self.native.reset_mock()
        self.native.side_effect = panel.ControlError(409, "任务状态已更新。")
        self.assertEqual(self.request("/api/cancel-task", key="manager", payload=TARGET),
                         (409, {"message": "任务状态已更新。"}))
        self.native.assert_called_once_with("/cancel-task", TARGET)
        self.assertEqual(self.site.expires, 0)


if __name__ == "__main__":
    unittest.main()
