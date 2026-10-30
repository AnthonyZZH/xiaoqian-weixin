"""Public, versioned driver contracts. No UI or third-party imports."""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from typing import Any, Literal

VERSION = 1
MAX_LINE = 2 * 1024 * 1024
Outcome = Literal["success", "failed", "unknown"]


class DriverError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class NotSent(DriverError):
    """Backend guarantees it has not attempted the irreversible send."""


class SendUnknown(DriverError):
    pass


@dataclass(frozen=True)
class Chat:
    name: str
    mode: Literal["private", "group"] = "private"

    def __post_init__(self):
        if not isinstance(self.name, str) or not self.name.strip() or len(self.name) > 256:
            raise ValueError("invalid_chat_name")
        if self.mode not in ("private", "group"):
            raise ValueError("invalid_chat_mode")

    @property
    def key(self) -> str:
        return digest(self.to_dict())

    def to_dict(self) -> dict[str, str]:
        return {"name": self.name, "mode": self.mode}


@dataclass(frozen=True)
class Message:
    message_id: str
    source_key: str
    chat_key: str
    text: str
    role: str
    sender: str = ""
    image_available: bool = False
    voice_available: bool = False
    odd: bool = False

    @classmethod
    def from_row(cls, chat: Chat, row: dict[str, Any]) -> "Message":
        key = row.get("key")
        if not isinstance(key, str) or not key or len(key) > 1024:
            raise DriverError("unstable_message_key")
        if row.get("role") not in ("user", "assistant") or not isinstance(row.get("text"), str):
            raise DriverError("invalid_message")
        sender = row.get("sender", "")
        if not isinstance(sender, str):
            raise DriverError("invalid_message")
        return cls(digest([chat.key, key]), key, chat.key, row["text"], row["role"], sender,
                   bool(row.get("image_available")), bool(row.get("voice_available")),
                   bool(row.get("odd")))


@dataclass(frozen=True)
class ReadResult:
    messages: tuple[Message, ...]
    observed_count: int
    duplicate_count: int


@dataclass(frozen=True)
class SendResult:
    operation_id: str
    status: Outcome
    code: str
    confirmation: str = ""
    missing_mentions: tuple[str, ...] = ()
    cached: bool = False


@dataclass(frozen=True)
class DriverConfig:
    mode: Literal["fake", "real"] = "fake"
    allow_real: bool = False
    adapter_root: str | None = None
    media_root: str | None = None
    allowed_chats: tuple[Chat, ...] = ()
    owner_edge_chat: Chat | None = None
    command_timeout: float = 5.0
    startup_timeout: float = 5.0
    queue_size: int = 128
    max_chars: int = 1000
    fake_options: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if self.owner_edge_chat is not None and (not isinstance(self.owner_edge_chat, Chat) or self.owner_edge_chat.mode != "private" or self.owner_edge_chat not in self.allowed_chats):
            raise ValueError("invalid_owner_edge_chat")
        if self.mode not in ("fake", "real"):
            raise ValueError("invalid_driver_mode")
        for number in (self.command_timeout, self.startup_timeout):
            if isinstance(number, bool) or not math.isfinite(number) or number <= 0:
                raise ValueError("invalid_timeout")
        if not 1 <= self.queue_size <= 4096 or not 1 <= self.max_chars <= 10000:
            raise ValueError("invalid_limits")
        if self.mode == "real" and not (self.allow_real and self.adapter_root and self.allowed_chats):
            raise ValueError("real_mode_requires_explicit_configuration")
        if self.mode == "fake" and self.allow_real:
            raise ValueError("contradictory_mode")


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def encode(value: dict[str, Any]) -> str:
    line = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(line.encode("utf-8")) > MAX_LINE:
        raise DriverError("ipc_frame_too_large")
    return line + "\n"


def decode(line: str) -> dict[str, Any]:
    if not line.endswith("\n") or len(line.encode("utf-8")) > MAX_LINE:
        raise DriverError("invalid_ipc_frame")
    try:
        value = json.loads(line)
    except (ValueError, TypeError):
        raise DriverError("invalid_ipc_json") from None
    if not isinstance(value, dict) or value.get("v") != VERSION:
        raise DriverError("unsupported_protocol")
    return value
