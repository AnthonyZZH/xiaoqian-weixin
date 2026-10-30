"""Backend implementations. Legacy UI imports occur only inside RealBackend._load."""
from __future__ import annotations

import importlib.util
import base64
import io
import json
import os
import sys
import time
from pathlib import Path
from typing import Protocol, runtime_checkable

from .protocol import Chat, DriverError, NotSent, SendUnknown


@runtime_checkable
class UIBackend(Protocol):
    """Platform backend boundary; implement without changing JSONL/client contracts.

    V1 supplies FakeBackend and the optional Windows RealBackend. A future native
    backend must preserve the same no-send/unknown distinction and serial caller.
    """
    def health(self) -> dict: ...
    def read(self, chat: Chat) -> list[dict]: ...
    def transcribe(self, chat: Chat, source_key: str) -> dict: ...
    def send(self, chat: Chat, text: str, at: list[str], max_chars: int) -> dict: ...
    def send_file(self, chat: Chat, path: str) -> dict: ...
    def extract_image(self, chat: Chat, source_key: str) -> dict: ...


class FakeBackend:
    def __init__(self, options: dict, generation: int, audit_path: str):
        self.options, self.generation = options, generation
        self.audit_path = Path(audit_path)
        self.calls: dict[str, int] = {}

    def _before(self, command: str):
        self.calls[command] = self.calls.get(command, 0) + 1
        with self.audit_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"command": command, "generation": self.generation,
                                     "pid": os.getpid(), "call": self.calls[command]}) + "\n")
        fault = self.options.get("faults", {}).get(command, {})
        if self.generation not in fault.get("generations", [1]):
            return
        if self.calls[command] not in fault.get("calls", [1]):
            return
        action = fault.get("action")
        if action == "hang":
            while True:
                time.sleep(0.1)
        if action == "crash":
            os._exit(73)
        if action == "delay":
            time.sleep(float(fault.get("seconds", 0.1)))
        if action == "failed":
            raise NotSent("fake_not_sent")
        if action == "unknown":
            raise SendUnknown("fake_send_unknown")
        if action == "error":
            raise RuntimeError("fake_private_error_must_not_escape")

    def health(self):
        self._before("health")
        return {"ready": True, "backend_loaded": True, "mode": "fake"}

    def read(self, chat: Chat):
        self._before("read")
        return self.options.get("snapshots", {}).get(chat.key, [])

    def transcribe(self, chat: Chat, source_key: str):
        self._before("transcribe")
        return {"text": self.options.get("transcripts", {}).get(source_key, "[语音]")}

    def send(self, chat: Chat, text: str, at: list[str], max_chars: int):
        self._before("send")
        return {"status": "success", "code": "sent", "confirmation": "fake",
                "missing_mentions": []}

    def send_file(self, chat: Chat, path: str):
        self._before("send_file")
        return {"status": "success", "code": "sent", "confirmation": "fake",
                "missing_mentions": []}

    def extract_image(self, chat: Chat, source_key: str):
        self._before("extract_image")
        encoded = self.options.get("images", {}).get(source_key)
        if not isinstance(encoded, str):
            raise DriverError("image_unavailable")
        return {"base64": encoded, "source_kind": "static_capture"}


class RealBackend:
    """Optional Windows UI backend; all legacy imports remain lazy."""
    def __init__(self, adapter_root: str):
        self.root = Path(adapter_root)
        if not self.root.is_absolute():
            raise DriverError("adapter_root_must_be_absolute")
        self.adapter = None
        self.module = None
        self.chat = None
        self.rows = {}

    def _load(self, chat: Chat):
        if os.name != "nt":
            raise DriverError("real_driver_requires_windows")
        if self.adapter is None:
            path = self.root / "wechat_adapter.py"
            if not path.is_file():
                raise DriverError("adapter_not_found")
            # No app/settings/persona/model imports; only the adapter and its own dependencies.
            # Patched adapters must not minimize the user's other application windows.
            os.environ["XQ_WECHAT_KEEP_FRONT"] = "0"
            sys.path.insert(0, str(self.root))
            spec = importlib.util.spec_from_file_location("_xiaoqian_driver_legacy_adapter", path)
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module  # dataclasses resolves its defining module here.
            spec.loader.exec_module(module)
            adapter = module.WeChatAdapter(chat.name, mode=chat.mode)
            self.module, self.adapter = module, adapter
        if self.chat != chat:
            self.adapter.set_target(chat.name, chat.mode)
            self.chat = chat
            self.rows.clear()
        return self.adapter

    def _select(self, chat: Chat):
        adapter = self._load(chat)
        adapter.open_chat(chat.name)
        adapter.validate()
        return adapter

    def health(self):
        # Health does not choose a recipient or initialize UI. Once loaded it probes the window.
        if self.adapter is not None:
            self.adapter.check_window()
        return {"ready": True, "backend_loaded": self.adapter is not None, "mode": "real"}

    def read(self, chat: Chat):
        self.last_controller_receipt=None
        if chat==getattr(self,'_edge_owner',None):
            from .owner_edge_controller import read_latest
            return read_latest(self,chat)
        adapter = self._select(chat)
        rows = adapter.read()
        self.rows = {row.key: row for row in rows}
        return [{"key": row.key, "text": row.text, "role": row.role,
                 "sender": row.sender, "image_available": row.image is not None,
                 "voice_available": row.voice is not None, "odd": row.odd} for row in rows]

    def transcribe(self, chat: Chat, source_key: str):
        adapter = self._select(chat)
        row = self.rows.get(source_key)
        if row is None:
            raise DriverError("message_handle_expired")
        return {"text": adapter.transcribe(row)}

    def send(self, chat: Chat, text: str, at: list[str], max_chars: int):
        try:
            adapter = self._select(chat)
        except DriverError as exc:
            code = exc.code if exc.code == "real_driver_requires_windows" else "preflight_failed"
            raise NotSent(code) from None
        except Exception:
            # No call to send yet, so no irreversible action can have happened.
            raise NotSent("preflight_failed") from None
        try:
            missing = adapter.send(text, max_chars=max_chars, at=at)
        except Exception as exc:
            if isinstance(exc,getattr(self.module,'SendNotAttempted',())):
                raise NotSent(exc.code) from None
            if isinstance(exc,getattr(self.module,'SendUncertain',())):
                raise SendUnknown(exc.code) from None
            raise SendUnknown("adapter_send_unknown") from None
        return {"status": "success", "code": "sent", "confirmation": "adapter_input_cleared",
                "missing_mentions": list(missing or [])}

    def send_file(self, chat: Chat, path: str):
        try:
            adapter = self._select(chat)
        except DriverError as exc:
            code = exc.code if exc.code == "real_driver_requires_windows" else "preflight_failed"
            raise NotSent(code) from None
        except Exception:
            raise NotSent("preflight_failed") from None
        try:
            adapter.send_image(path)
        except Exception:
            raise SendUnknown("adapter_media_send_unknown") from None
        return {"status": "success", "code": "sent", "confirmation": "adapter_input_cleared",
                "missing_mentions": []}

    def extract_image(self, chat: Chat, source_key: str):
        self._select(chat)
        row = self.rows.get(source_key)
        if row is None or row.image is None:
            raise DriverError("image_handle_expired")
        image = row.image.copy()
        image.thumbnail((448, 448))
        buffer = io.BytesIO()
        image.convert("RGB").save(buffer, format="PNG")
        if buffer.tell() > 1024 * 1024:
            raise DriverError("image_capture_too_large")
        return {"base64": base64.b64encode(buffer.getvalue()).decode("ascii"),
                "source_kind": "static_capture"}
