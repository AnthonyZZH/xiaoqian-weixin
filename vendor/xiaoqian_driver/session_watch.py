"""Remembers which chats WeChat's conversation list shows, so the bridge can recognise a renamed group.

Read-only: it only reads the names in the visible list; it never clicks, types or opens anything.
The file it keeps holds, for every configured chat, the list as it looked the last time that chat
was in it. When a group is renamed, the old name disappears and exactly one unknown name appears;
the bridge compares the two lists and follows the rename.
"""
import json
import os
import time
from pathlib import Path


class SessionWatch:
    def __init__(self, path, names, interval=20.0, clock=time.monotonic):
        self.path, self.names, self.interval, self.clock = Path(path), tuple(names), interval, clock
        self.next = 0.0
        self.state = {"version": 1, "current": None, "lastSeen": {}}
        try:
            saved = json.loads(self.path.read_text(encoding="utf-8"))
            if saved.get("version") == 1 and isinstance(saved.get("lastSeen"), dict):
                self.state = saved
        except (OSError, ValueError):
            pass

    def note(self, backend, force=False):
        """Never raises: a bookkeeping problem must not turn into a failed read."""
        try:
            now = self.clock()
            if not force and now < self.next:
                return
            self.next = now + self.interval
            adapter = getattr(backend, "adapter", None)
            if adapter is None:
                return
            names = sorted({str(n)[:200] for n in adapter.sessions() if isinstance(n, str) and n})[:200]
            if not names:
                return
            stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            changed = False
            if (self.state.get("current") or {}).get("names") != names:
                self.state["current"] = {"at": stamp, "names": names}
                changed = True
            for name in self.names:
                if name in names and (self.state["lastSeen"].get(name) or {}).get("names") != names:
                    self.state["lastSeen"][name] = {"at": stamp, "names": names}
                    changed = True
            if changed:
                temp = self.path.with_name(self.path.name + ".tmp")
                temp.write_text(json.dumps(self.state, ensure_ascii=False), encoding="utf-8")
                os.replace(temp, self.path)
        except Exception:
            pass
