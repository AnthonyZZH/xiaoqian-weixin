"""Private JSONL subprocess; one serial UI execution lane and no listener/socket."""
from __future__ import annotations

import contextlib
import hashlib
import os
import queue
import sys
import threading
from pathlib import Path

from .backends import FakeBackend, RealBackend
from .owner_edge_controller import configure as configure_owner_edge
from .lease import DesktopLease
from .protocol import Chat, DriverConfig, DriverError, NotSent, SendUnknown, VERSION, decode, encode, MAX_LINE


def checked_media(config, raw_path, expected_hash):
    """Reject arbitrary paths and changed originals before any UI send attempt."""
    if not config.media_root or not isinstance(raw_path, str) or not isinstance(expected_hash, str) or len(expected_hash) != 64:
        raise NotSent("media_target_invalid")
    try:
        root = Path(config.media_root).resolve(strict=True)
        candidate = Path(raw_path)
        if not candidate.is_absolute() or candidate.is_symlink() or getattr(candidate, "is_junction", lambda: False)():
            raise ValueError()
        actual = candidate.resolve(strict=True)
        if not actual.is_relative_to(root) or not actual.is_file() or actual.stat().st_size > 20 * 1024 * 1024:
            raise ValueError()
        relative = actual.relative_to(root)
        if len(relative.parts) != 3 or relative.parts[1] != "originals":
            raise ValueError()
        current = root
        for part in relative.parts:
            current = current / part
            if current.is_symlink() or getattr(current, "is_junction", lambda: False)():
                raise ValueError()
        if hashlib.sha256(actual.read_bytes()).hexdigest() != expected_hash:
            raise ValueError()
        return str(actual)
    except (OSError, ValueError):
        raise NotSent("media_target_invalid") from None


def stdin_reader(incoming):
    while True:
        line = sys.stdin.readline(MAX_LINE + 2)
        if not line:
            incoming.put(None)
            # Closing the parent's pipe is also a watchdog for a hung orphan. Keep the
            # desktop lease until process exit, so another client cannot overlap UI work.
            timer = threading.Timer(1.0, lambda: os._exit(0))
            timer.daemon = True
            timer.start()
            return
        incoming.put(line)


def serve():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8", newline="\n", write_through=True)
    incoming = queue.Queue(maxsize=128)
    threading.Thread(target=stdin_reader, args=(incoming,), daemon=True).start()
    backend, config, lease = None, None, None
    try:
        while True:
            line = incoming.get()
            if line is None:
                return
            request_id, command = None, None
            try:
                request = decode(line)
                request_id = request.get("id")
                command = request.get("command")
                args = request.get("args", {})
                if not isinstance(request_id, str) or not request_id or not isinstance(args, dict):
                    raise DriverError("invalid_request")
                # Adapter prints can never corrupt the JSONL output. The parent discards stderr.
                with contextlib.redirect_stdout(sys.stderr):
                    if command == "hello":
                        if backend is not None:
                            raise DriverError("already_initialized")
                        raw = args["config"]
                        chats = tuple(Chat(**item) for item in raw.pop("allowed_chats", []))
                        owner = raw.pop("owner_edge_chat", None)
                        config = DriverConfig(**raw, allowed_chats=chats, owner_edge_chat=Chat(**owner) if owner else None)
                        if config.mode == "real":
                            # Fixed per-user/session desktop lease shared by all state directories.
                            lease = DesktopLease()
                            backend = RealBackend(config.adapter_root)
                            if args.get("owner_edge"):configure_owner_edge(backend,args["owner_edge"],config.allowed_chats,config.owner_edge_chat)
                        else:
                            backend = FakeBackend(config.fake_options, args["generation"], args["audit_path"])
                        result = {"protocol": VERSION, "pid": os.getpid(), "mode": config.mode}
                    else:
                        if backend is None:
                            raise DriverError("not_initialized")
                        if command == "ping":
                            result = {"pid": os.getpid(), "mode": config.mode}
                        elif command == "health":
                            result = backend.health()
                        elif command in ("read", "send", "send_file", "transcribe", "extract_image"):
                            chat = Chat(**args["chat"])
                            if config.mode == "real" and chat not in config.allowed_chats:
                                raise NotSent("chat_not_allowed")
                            if command == "read":
                                result = {"rows": backend.read(chat)}
                                if getattr(backend,"last_controller_receipt",None):result["controller_receipt"]=backend.last_controller_receipt
                            elif command == "transcribe":
                                key = args.get("source_key")
                                if not isinstance(key, str) or not key:
                                    raise DriverError("invalid_source_key")
                                result = backend.transcribe(chat, key)
                            elif command == "extract_image":
                                key = args.get("source_key")
                                if not isinstance(key, str) or not key:
                                    raise DriverError("invalid_source_key")
                                result = backend.extract_image(chat, key)
                            elif command == "send_file":
                                path = checked_media(config, args.get("path"), args.get("sha256"))
                                result = backend.send_file(chat, path)
                            else:
                                text, at = args.get("text"), args.get("at", [])
                                if not isinstance(text, str) or not text or len(text) > config.max_chars or "\n" in text or "\r" in text:
                                    raise NotSent("invalid_send_text")
                                if not isinstance(at, list) or len(at) > 20 or any(not isinstance(name, str) or not name or len(name) > 128 for name in at):
                                    raise NotSent("invalid_mentions")
                                result = backend.send(chat, text, at, config.max_chars)
                        else:
                            raise DriverError("unknown_command")
                response = {"v": VERSION, "id": request_id, "ok": True, "result": result}
            except NotSent as exc:
                response = {"v": VERSION, "id": request_id, "ok": False,
                            "error": {"code": exc.code, "send_status": "failed"}}
            except SendUnknown as exc:
                response = {"v": VERSION, "id": request_id, "ok": False,
                            "error": {"code": exc.code, "send_status": "unknown"}}
            except Exception as exc:
                code = exc.code if isinstance(exc, DriverError) else "backend_error"
                response = {"v": VERSION, "id": request_id, "ok": False,
                            "error": {"code": code, "send_status": "unknown" if command in ("send", "send_file") else None}}
            try:
                sys.stdout.write(encode(response))
                sys.stdout.flush()
            except Exception:
                # An unrepresentable response gives no reliable send receipt; parent fails closed.
                return
    finally:
        if lease is not None:
            lease.close()


if __name__ == "__main__":
    serve()
