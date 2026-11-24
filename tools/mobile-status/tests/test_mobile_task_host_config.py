import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import local_status_panel as monitor
from mobile_status_server import allowed_origins


class HostConfiguration(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.patch = self.root / "wechat.patch.json"
        self.enterContext(patch.dict(os.environ, {"XQ_MOBILE_PATCH": str(self.patch),
                                                  "XQ_MOBILE_NODE": "", "XQ_MOBILE_DSH_BIN": ""}))
        self.config = {"stateDir": str(self.root / "private state"), "chats": []}
        self.bridge = {"id": "xiaoqian-wechat-native", "config": self.config}

    def test_array_and_single_insert_select_only_the_bridge(self):
        decoy = {"id": "other", "config": self.config}
        for document in ([{"insert": [decoy, self.bridge]}], [{"insert": decoy}, {"insert": self.bridge}],
                         {"insert": self.bridge}):
            with self.subTest(document=document):
                self.patch.write_text(json.dumps(document), encoding="utf-8")
                self.assertEqual(monitor.bridge_config(), self.config)
        for plugins in ([decoy], [self.bridge, self.bridge], [dict(self.bridge, disabled=True)]):
            self.patch.write_text(json.dumps([{"insert": plugins}]), encoding="utf-8")
            with self.assertRaises(ValueError):
                monitor.bridge_config()

    def test_pid_must_run_dsh_with_the_selected_patch(self):
        process = Mock(pid=17)
        process.name.return_value = "node.exe"
        exe = self.root / "node.exe"
        entry = self.root / "apps/@deepseek-ai/dsh/lib/bin.js"
        process.exe.return_value = str(exe)
        process.cwd.return_value = str(self.root)
        process.create_time.return_value = 100
        with patch.object(monitor.psutil, "Process", return_value=process):
            for args in (["--patch", str(self.patch)], ["--patch=wechat.patch.json"]):
                process.cmdline.return_value = [str(exe), str(entry), "--profile", "web", *args]
                self.assertEqual(monitor.local_host(17), (17, 100))
            process.cmdline.return_value = [str(exe), str(entry), "--patch", "other.patch.json"]
            self.assertIsNone(monitor.local_host(17))
            custom = self.root / "custom.js"
            process.cmdline.return_value = [str(exe), str(custom), "--patch", str(self.patch)]
            self.assertIsNone(monitor.local_host(17))
            with patch.dict(os.environ, {"XQ_MOBILE_NODE": str(exe), "XQ_MOBILE_DSH_BIN": str(custom)}):
                self.assertEqual(monitor.local_host(17), (17, 100))
            with patch.dict(os.environ, {"XQ_MOBILE_NODE": str(self.root / "other-node.exe")}):
                process.cmdline.return_value = [str(exe), str(entry), "--patch", str(self.patch)]
                self.assertIsNone(monitor.local_host(17))

    def test_remote_origin_is_exact_optional_and_https(self):
        local = {"http://127.0.0.1:8791", "http://localhost:8791"}
        self.assertEqual(allowed_origins(None), local)
        self.assertEqual(allowed_origins("https://Panel.example.org:443/"), local | {"https://panel.example.org"})
        self.assertIn("https://panel.example.org:8443", allowed_origins("https://panel.example.org:8443"))
        for invalid in ("http://panel.example.org", "https://panel.example.org/task", "https://*.example.org",
                        "https://one.example.org,https://two.example.org", "https://u:p@panel.example.org",
                        "https://panel.example.org#fragment", "https://panel.example.org?view"):
            with self.subTest(origin=invalid), self.assertRaises(ValueError):
                allowed_origins(invalid)


if __name__ == "__main__":
    unittest.main()
