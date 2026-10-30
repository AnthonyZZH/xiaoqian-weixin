"""Lightweight synchronous client with a bounded FIFO and killable UI worker."""
from __future__ import annotations

import os
import queue
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import Future
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .owner_edge_controller import client_options, verify as verify_owner_edge
from .lease import FileLease
from .protocol import Chat, DriverConfig, DriverError, ReadResult, SendResult, VERSION, MAX_LINE, decode, digest, encode
from .state import StateStore


@dataclass
class _Job:
    command: str
    args: dict[str, Any]
    deadline: float
    future: Future


class DriverClient:
    """One client per durable state directory. All UI commands are serialized."""

    def __init__(self, state_dir: str | Path, config: DriverConfig | None = None):
        self.config = config or DriverConfig()
        self.state_dir = Path(state_dir).resolve()
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self._lease = FileLease(self.state_dir / "client.lock")
        try:
            self._state = StateStore(self.state_dir / "driver.sqlite3")
        except Exception:
            self._lease.close()
            raise DriverError("state_unavailable") from None
        self._queue: queue.Queue[_Job] = queue.Queue(maxsize=self.config.queue_size)
        self._closing = threading.Event()
        self._submission_lock = threading.Lock()
        self._closed = False
        self._process_lock = threading.RLock()
        self._process: subprocess.Popen | None = None
        self._events = None
        self._generation = 0
        self._quarantined = False
        self._worker_ready = False
        self._dispatcher = threading.Thread(target=self._run, name="xiaoqian-ui-queue", daemon=True)
        self._dispatcher.start()

    def _submit(self, command: str, args: dict, timeout: float | None):
        import math
        budget = self.config.command_timeout if timeout is None else timeout
        if isinstance(budget, bool) or not math.isfinite(budget) or budget <= 0:
            raise ValueError("invalid_timeout")
        future = Future()
        job = _Job(command, args, time.monotonic() + budget, future)
        with self._submission_lock:
            if self._closing.is_set():
                raise DriverError("client_closed")
            try:
                self._queue.put_nowait(job)
            except queue.Full:
                if command in ("send", "send_file"):
                    return SendResult(args["operation_id"], "failed", "queue_full")
                raise DriverError("queue_full") from None
        return future.result()

    def _run(self):
        try:
            while not self._closing.is_set():
                try:
                    job = self._queue.get(timeout=0.05)
                except queue.Empty:
                    continue
                try:
                    if job.command in ("send", "send_file"):
                        result = self._send(job)
                    else:
                        self._remaining(job.deadline, "queue_timeout")
                        if job.command == "restart":
                            self._stop_worker()
                            self._ensure_worker(job.deadline)
                            result = {"generation": self._generation, "pid": self._process.pid}
                        else:
                            self._ensure_worker(job.deadline)
                            result = self._request(job.command, job.args, job.deadline)
                            if job.command == "read":
                                rows = result.get("rows")
                                if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                                    raise DriverError("invalid_read_response")
                                chat=Chat(**job.args["chat"])
                                if self.config.mode=='real' and chat in getattr(self,'_edge_chats',()):
                                    receipt=result.get('controller_receipt')
                                    if verify_owner_edge(self,receipt,chat,rows) is None:raise DriverError('owner_edge_receipt_unverified')
                                    result=self._state.ingest(chat,rows,recovery_receipt=receipt,verify_recovery=lambda value:verify_owner_edge(self,value,chat,rows))
                                else:
                                    result=self._state.ingest(chat,rows)
                            elif job.command == "health":
                                result = {**result, "generation": self._generation, "pid": self._process.pid}
                    job.future.set_result(result)
                except Exception as exc:
                    job.future.set_exception(exc)
                finally:
                    self._queue.task_done()
        finally:
            while True:
                try:
                    abandoned = self._queue.get_nowait()
                except queue.Empty:
                    break
                if abandoned.command in ("send", "send_file"):
                    abandoned.future.set_result(SendResult(abandoned.args["operation_id"], "failed", "client_closed_before_dispatch"))
                else:
                    abandoned.future.set_exception(DriverError("client_closed"))
                self._queue.task_done()

    @staticmethod
    def _remaining(deadline: float, code: str = "command_timeout") -> float:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise DriverError(code)
        return remaining

    @staticmethod
    def _reader(process, events):
        try:
            while True:
                line = process.stdout.readline(MAX_LINE + 2)
                if not line:
                    events.put(("eof", None))
                    return
                events.put(("line", line))
        except (OSError, ValueError):
            events.put(("eof", None))

    def _ensure_worker(self, deadline: float):
        try:
            with self._process_lock:
                if self._closing.is_set():
                    raise DriverError("client_closed")
                if self._quarantined:
                    raise DriverError("worker_stop_unconfirmed")
                if self._process is not None:
                    if self._process.poll() is None and getattr(self, "_worker_ready", False):
                        return
                    self._stop_worker()
                self._remaining(deadline)
                allowed = ("SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "COMSPEC", "LANG")
                env = {key: os.environ[key] for key in allowed if key in os.environ}
                env.update(PYTHONIOENCODING="utf-8", PYTHONDONTWRITEBYTECODE="1")
                try:
                    process = subprocess.Popen(
                        [sys.executable, "-B", "-u", "-m", "xiaoqian_driver.worker"],
                        cwd=str(Path(__file__).resolve().parent.parent), env=env,
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                        text=True, encoding="utf-8", bufsize=1, close_fds=True,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                except OSError:
                    raise DriverError("worker_start_failed") from None
                self._process, self._events = process, queue.Queue()
                self._worker_ready = False
                self._generation += 1
                threading.Thread(target=self._reader, args=(process, self._events), daemon=True).start()
            hello_deadline = min(deadline, time.monotonic() + self.config.startup_timeout)
            owner_edge=client_options(self)
            result = self._request("hello", {"config": asdict(self.config), "generation": self._generation, "owner_edge":owner_edge,
                                            "audit_path": str(self.state_dir / "fake-events.jsonl")}, hello_deadline)
            if result.get("protocol") != VERSION or result.get("mode") != self.config.mode:
                raise DriverError("handshake_mismatch")
            with self._process_lock:
                if self._closing.is_set() or self._process is not process or process.poll() is not None:
                    raise DriverError("worker_unavailable")
                self._worker_ready = True
        except BaseException:
            # Initialization is all-or-nothing. Alive alone never means protocol-ready.
            self._stop_worker()
            raise

    def _request(self, command: str, args: dict, deadline: float) -> dict:
        self._remaining(deadline)
        if command != "hello" and not getattr(self, "_worker_ready", False):
            raise DriverError("worker_not_ready")
        request_id = uuid.uuid4().hex
        line = encode({"v": VERSION, "id": request_id, "command": command, "args": args})
        process, events = self._process, self._events
        if process is None:
            raise DriverError("worker_unavailable")

        def write():
            try:
                process.stdin.write(line)
                process.stdin.flush()
            except (OSError, ValueError):
                events.put(("write_error", None))

        # A full stdin pipe must not defeat the hard timeout.
        threading.Thread(target=write, name="xiaoqian-ipc-writer", daemon=True).start()
        try:
            try:
                kind, value = events.get(timeout=self._remaining(deadline))
            except queue.Empty:
                raise DriverError("command_timeout") from None
            if kind != "line":
                raise DriverError("worker_crashed")
            response = decode(value)
            if response.get("id") != request_id or not isinstance(response.get("ok"), bool):
                raise DriverError("ipc_response_mismatch")
            if response["ok"]:
                if not isinstance(response.get("result"), dict):
                    raise DriverError("invalid_response")
                return response["result"]
            error = response.get("error")
            if not isinstance(error, dict) or not isinstance(error.get("code"), str):
                raise DriverError("invalid_error_response")
            exc = DriverError(error["code"])
            exc.send_status = error.get("send_status")
            raise exc
        except DriverError as exc:
            # Valid backend errors do not require destroying the UI process. IPC/timeouts do.
            if command == "hello" or not hasattr(exc, "send_status"):
                self._stop_worker()
            raise

    def _stop_worker(self):
        with self._process_lock:
            self._worker_ready = False
            process = self._process
            if process is None:
                return
            if process.poll() is None:
                try:
                    process.kill()
                except OSError:
                    pass
                try:
                    process.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    self._quarantined = True
                    raise DriverError("worker_stop_unconfirmed") from None
            # Exit is confirmed before another worker may start. Only our own process is killed.
            for stream in (process.stdin, process.stdout):
                if stream is not None:
                    try:
                        stream.close()
                    except (OSError, ValueError):
                        pass
            self._process, self._events = None, None

    def _send(self, job: _Job) -> SendResult:
        operation_id = job.args["operation_id"]
        payload = {key: value for key, value in job.args.items() if key != "operation_id"}
        fingerprint = digest(payload)
        cached = self._state.cached_send(operation_id, fingerprint)
        if cached is not None:
            return cached
        try:
            self._remaining(job.deadline, "queue_timeout")
            self._ensure_worker(job.deadline)
            self._remaining(job.deadline)
        except DriverError as exc:
            return SendResult(operation_id, "failed", exc.code)
        # FULL sync commit BEFORE IPC. A client crash from here onward is conservatively unknown.
        try:
            self._state.reserve(operation_id, fingerprint, payload)
        except sqlite3.Error:
            return SendResult(operation_id, "failed", "state_reservation_failed")
        try:
            raw = self._request(job.command, payload, job.deadline)
            if raw.get("status") not in ("success", "failed", "unknown") or not isinstance(raw.get("code"), str):
                raise DriverError("invalid_send_response")
            confirmation, missing = raw.get("confirmation", ""), raw.get("missing_mentions", [])
            if not isinstance(confirmation, str) or not isinstance(missing, list) or any(not isinstance(item, str) for item in missing):
                raise DriverError("invalid_send_response")
            result = SendResult(operation_id, raw["status"], raw["code"], confirmation, tuple(missing))
        except DriverError as exc:
            status = "failed" if getattr(exc, "send_status", None) == "failed" else "unknown"
            result = SendResult(operation_id, status, exc.code)
        except Exception:
            self._stop_worker()
            result = SendResult(operation_id, "unknown", "send_receipt_unavailable")
        try:
            self._state.finish(result)
        except sqlite3.Error:
            return SendResult(operation_id, "unknown", "state_commit_failed_unknown")
        return result

    def health(self, *, timeout: float | None = None) -> dict:
        return self._submit("health", {}, timeout)

    def restart(self, *, timeout: float | None = None) -> dict:
        """Restart only the owned worker, never WeChat or any server service."""
        return self._submit("restart", {}, timeout)

    def read(self, chat: Chat, *, timeout: float | None = None) -> ReadResult:
        return self._submit("read", {"chat": chat.to_dict()}, timeout)

    def pending(self, chat: Chat):
        return self._state.pending(chat)

    def ack(self, message_ids) -> int:
        return self._state.ack(list(message_ids))

    def send_status(self, operation_id: str) -> SendResult | None:
        return self._state.send_status(operation_id)

    def send(self, chat: Chat, text: str, *, operation_id: str, at=(), timeout: float | None = None) -> SendResult:
        if not isinstance(operation_id, str) or not operation_id or len(operation_id) > 256:
            raise ValueError("invalid_operation_id")
        if not isinstance(text, str) or not text or "\n" in text or "\r" in text or len(text) > self.config.max_chars:
            raise ValueError("invalid_send_text")
        members = list(at)
        if len(members) > 20 or any(not isinstance(member, str) or not member or len(member) > 128 for member in members):
            raise ValueError("invalid_mentions")
        return self._submit("send", {"chat": chat.to_dict(), "text": text, "at": members,
                                     "operation_id": operation_id}, timeout)

    def send_file(self, chat: Chat, path: str, sha256: str, *, operation_id: str,
                  timeout: float | None = None) -> SendResult:
        if not isinstance(operation_id, str) or not operation_id or len(operation_id) > 256:
            raise ValueError("invalid_operation_id")
        if not isinstance(path, str) or not path or not isinstance(sha256, str) or len(sha256) != 64:
            raise ValueError("invalid_media_target")
        return self._submit("send_file", {"chat": chat.to_dict(), "path": path,
                                          "sha256": sha256, "operation_id": operation_id}, timeout)

    def transcribe(self, chat: Chat, source_key: str, *, timeout: float | None = None) -> str:
        result = self._submit("transcribe", {"chat": chat.to_dict(), "source_key": source_key}, timeout)
        if not isinstance(result.get("text"), str):
            raise DriverError("invalid_transcription_response")
        return result["text"]

    def extract_image(self, chat: Chat, source_key: str, *, timeout: float | None = None) -> str:
        result = self._submit("extract_image", {"chat": chat.to_dict(), "source_key": source_key}, timeout)
        encoded = result.get("base64")
        if not isinstance(encoded, str) or not encoded or len(encoded) > 2 * 1024 * 1024:
            raise DriverError("invalid_capture_response")
        return encoded

    def close(self):
        if self._closed:
            return
        with self._submission_lock:
            self._closing.set()
        self._stop_worker()
        self._dispatcher.join(timeout=2.0)
        if self._dispatcher.is_alive():
            raise DriverError("shutdown_incomplete")
        self._state.close()
        self._lease.close()
        self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
