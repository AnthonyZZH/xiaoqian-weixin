"""Independent mobile status and owner controls. Runtime data stays outside this source tree."""
import hmac
import http.client
import json
import os
import secrets
import re
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from time import monotonic
from urllib.parse import urlsplit

import win32crypt

from local_status_panel import STATUS_FIELDS, bridge_config, current_status, local_host, local_time, timestamp
from mobile_task_details import attach_task_details


ASSETS = Path(__file__).with_name("mobile-status")
KEY_FILE = Path(os.environ["LOCALAPPDATA"]) / "Xiaoqian" / "MobileStatus" / "viewer.dpapi"
PORT = 8791
TASK_STATUSES = {"queued", "running", "succeeded", "failed", "cancelled"}
INSTANCE_PATTERN = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"


def allowed_origins(remote):
    origins = {"http://127.0.0.1:8791", "http://localhost:8791"}
    if not remote:
        return origins
    url = urlsplit(remote)
    if (url.scheme != "https" or not url.hostname or url.username is not None or url.password is not None
            or url.path not in ("", "/") or "?" in remote or "#" in remote
            or not re.fullmatch(r"(?:[A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\])(?::[0-9]+)?", url.netloc)
            or any(character.isspace() for character in remote)):
        raise ValueError("XQ_MOBILE_ORIGIN must be one HTTPS origin e.g. https://panel.example.org")
    host = url.hostname.lower()
    authority = f"[{host}]" if ":" in host else host
    port = url.port
    origins.add("https://" + authority + (f":{port}" if port not in (443, None) else ""))
    return origins


def valid_task_id(value):
    return (isinstance(value, str) and re.fullmatch(r"[1-9][0-9]{0,15}", value) is not None
            and int(value) <= 9007199254740991)


def task_summaries(tasks):
    if not isinstance(tasks, list):
        return None
    summaries = []
    for task in tasks:
        if (not isinstance(task, dict) or not valid_task_id(task.get("id"))
                or not isinstance(task.get("status"), str) or task["status"] not in TASK_STATUSES
                or any(type(task.get(field)) is not int or task[field] < 0 for field in ("completed", "total"))
                or not isinstance(task.get("createdAt"), str)):
            return None
        try:
            datetime.fromisoformat(task["createdAt"])
        except ValueError:
            return None
        summary = {field: task[field] for field in ("id", "status", "completed", "total", "createdAt")}
        valid_version = isinstance(task.get("version"), str) and re.fullmatch(r"[a-f0-9]{64}", task["version"]) is not None
        title = task.get("title")
        summary.update(title=title[:80] if isinstance(title, str) else "",
                       version=task["version"] if valid_version else None,
                       canCancel=bool(valid_version and task.get("canCancel") is True
                                      and task["status"] in ("queued", "running")))
        summaries.append(summary)
    return summaries


def viewer_key(file=KEY_FILE):
    if not file.is_file():
        file.parent.mkdir(parents=True, exist_ok=True)
        protected = win32crypt.CryptProtectData(secrets.token_urlsafe(32).encode("ascii"),
                                               "Xiaoqian mobile status", None, None, None, 1)
        try:
            with file.open("xb") as f:
                f.write(protected)
        except FileExistsError:
            pass
    return win32crypt.CryptUnprotectData(file.read_bytes(), None, None, None, 1)[1]


class ControlError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def native(route, payload=None):
    try:
        record = json.loads(KEY_FILE.with_name("native.json").read_bytes())
        host = local_host(record["pid"])
        if not host:
            raise ValueError("stale process")
        conn = http.client.HTTPConnection("127.0.0.1", int(record["port"]), timeout=8)
        try:
            headers = {"Authorization": "Bearer " + record["token"], "Content-Type": "application/json"}
            conn.request("GET" if payload is None else "POST", route,
                         None if payload is None else json.dumps(payload).encode(), headers)
            response = conn.getresponse()
            body = json.loads(response.read(128 * 1024))
            if response.status not in (200, 202):
                raise ControlError(409 if response.status == 409 else 503,
                                   body.get("message") or "本机控制暂不可用。")
            return body
        finally:
            conn.close()
    except (OSError, KeyError, ValueError, TypeError, http.client.HTTPException) as err:
        raise ControlError(503, "无法确认本机状态，请刷新后查看结果。") from err


class StatusSite(ThreadingHTTPServer):
    def __init__(self):
        self.origins = allowed_origins(os.environ.get("XQ_MOBILE_ORIGIN"))
        self.auth = b"Bearer " + viewer_key()
        self.manage = b"Bearer " + viewer_key(KEY_FILE.with_name("operator.dpapi"))
        self.pages = {
            route: (kind + "; charset=utf-8", (ASSETS / filename).read_bytes())
            for route, kind, filename in [
                ("/", "text/html", "xiaoqian.html"),
                ("/app.css", "text/css", "xiaoqian.css"),
                ("/app.js", "text/javascript", "xiaoqian.js"),
            ]
        }
        self.lock = threading.Lock()
        self.cached = b""
        self.expires = 0
        super().__init__(("127.0.0.1", PORT), Viewer)

    def status(self, manager=False):
        with self.lock:
            if monotonic() >= self.expires:
                config = bridge_config()
                state, detail, rows, _, at = current_status(config)
                try:
                    live = native("/state")
                except ControlError:
                    live = {}
                tasks = task_summaries(live.get("tasks"))
                if tasks:
                    database = Path(config["stateDir"]) / "owner-tasks" / "tasks.sqlite3"
                    tasks = attach_task_details(tasks, database)
                live_chats = {row["id"]: row for row in live.get("conversations", [])}
                chats = []
                for chat_id, values in rows:
                    row = dict(zip(STATUS_FIELDS, values))
                    receipt = live_chats.get(chat_id, {})
                    if receipt.get("receivedAt"):
                        row["retryReceived"] = local_time(timestamp(receipt["receivedAt"]))
                        if row.get("lastReceived", "—") == "—":
                            row["lastReceived"] = row["retryReceived"]
                        row["reply"] = receipt["phase"]
                    row.update(id=chat_id, version=receipt.get("version"), canRetry=receipt.get("canRetry", False))
                    chats.append(row)
                self.cached = {
                    "status": state, "detail": detail, "at": int(at * 1000),
                    "chats": chats, "instance": live.get("instance"), "canRestart": live.get("canRestart", False),
                    "restarting": live.get("restarting", False),
                    "tasks": tasks,
                }
                self.expires = monotonic() + 2
            result = dict(self.cached, manager=manager)
            if not manager:
                result.pop("instance")
                result.pop("canRestart")
                result["chats"] = [{k: v for k, v in row.items() if k not in ("id","version","canRetry","retryReceived")}
                                   for row in result["chats"]]
                if result["tasks"]:
                    visible = ("id", "title", "status", "createdAt", "startedAt", "finishedAt", "completed", "total", "steps")
                    result["tasks"] = [{field: task[field] for field in visible} for task in result["tasks"]]
            return json.dumps(result, ensure_ascii=False).encode("utf-8")


class Viewer(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, kind="text/plain; charset=utf-8", body=b""):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        if self.path in self.server.pages:
            return self.reply(200, *self.server.pages[self.path])
        if self.path != "/api/status":
            return self.reply(404)
        provided = self.headers.get("Authorization", "").encode("latin-1")
        manager = hmac.compare_digest(provided, self.server.manage)
        if not manager and not hmac.compare_digest(provided, self.server.auth):
            return self.reply(401)
        try:
            body = self.server.status(manager)
        except (OSError, ValueError, KeyError, TypeError):
            return self.reply(503)
        return self.reply(200, "application/json; charset=utf-8", body)

    do_HEAD = do_GET

    def do_POST(self):
        paths = {"/api/restart": "/restart", "/api/retry": "/retry", "/api/cancel-task": "/cancel-task"}
        if self.path not in paths:
            return self.reply(404)
        if not hmac.compare_digest(self.headers.get("Authorization", "").encode("latin-1"), self.server.manage):
            return self.reply(403)
        if self.headers.get("Origin") not in self.server.origins:
            return self.reply(403)
        if self.headers.get_content_type() != "application/json":
            return self.reply(415)
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 1024:
                return self.reply(400)
            payload = json.loads(self.rfile.read(size))
            keys = {"instance"} if self.path == "/api/restart" else {"instance","id","version"}
            if not isinstance(payload,dict) or set(payload) != keys or not all(isinstance(x,str) for x in payload.values()):
                return self.reply(400)
            if not re.fullmatch(INSTANCE_PATTERN, payload["instance"]):
                return self.reply(400)
            if "id" in payload:
                valid_id = (valid_task_id(payload["id"]) if self.path == "/api/cancel-task"
                            else re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", payload["id"]))
                if not valid_id or not re.fullmatch(r"[a-f0-9]{64}", payload["version"]):
                    return self.reply(400)
            body = native(paths[self.path], payload)
            code = 202
        except (ValueError, TypeError):
            return self.reply(400)
        except ControlError as err:
            code, body = err.status, {"message": str(err)}
        with self.server.lock:
            self.server.expires = 0
        return self.reply(code, "application/json; charset=utf-8", json.dumps(body, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    bridge_config()
    with StatusSite() as site:
        site.serve_forever()
