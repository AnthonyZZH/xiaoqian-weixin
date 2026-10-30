"""Durable business state, separate from diagnostics. No send bodies are stored."""
from __future__ import annotations

import json
import sqlite3
import threading
from dataclasses import asdict
from pathlib import Path

from .protocol import Chat, DriverError, Message, ReadResult, SendResult, digest
from . import snapshot_identity


class StateStore:
    def __init__(self, path: Path):
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False, timeout=1)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS sends (
                operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
                status TEXT NOT NULL, result TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS inbox (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT UNIQUE NOT NULL, chat_key TEXT NOT NULL,
                payload TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0);
        """)
        snapshot_identity.initialize(self.db)
        # Client owns an exclusive lease. A previous pending send can no longer finish.
        with self.lock, self.db:
            for (operation_id,) in self.db.execute("SELECT operation_id FROM sends WHERE status='pending'").fetchall():
                result = SendResult(operation_id, "unknown", "client_interrupted")
                self.db.execute("UPDATE sends SET status=?, result=? WHERE operation_id=?",
                                ("unknown", self._dump(asdict(result)), operation_id))

    @staticmethod
    def _dump(value):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def _send(raw: str, cached: bool = False) -> SendResult:
        data = json.loads(raw)
        data["missing_mentions"] = tuple(data.get("missing_mentions", []))
        data["cached"] = cached
        return SendResult(**data)

    def cached_send(self, operation_id: str, fingerprint: str) -> SendResult | None:
        with self.lock:
            row = self.db.execute("SELECT fingerprint,status,result FROM sends WHERE operation_id=?",
                                  (operation_id,)).fetchone()
            if row is None:
                return None
            if row[0] != fingerprint:
                raise DriverError("operation_id_conflict")
            if row[1] == "pending":
                return SendResult(operation_id, "unknown", "send_in_progress", cached=True)
            return self._send(row[2], cached=True)

    def reserve(self, operation_id: str, fingerprint: str, payload=None):
        with self.lock, self.db:
            if payload is not None: snapshot_identity.remember_send(self.db,operation_id,payload)
            self.db.execute("INSERT INTO sends VALUES (?,?,'pending','{}')", (operation_id, fingerprint))

    def finish(self, result: SendResult):
        with self.lock, self.db:
            self.db.execute("UPDATE outbound_identity SET status=? WHERE op=?", (result.status,result.operation_id))
            self.db.execute("UPDATE sends SET status=?,result=? WHERE operation_id=?",
                            (result.status, self._dump(asdict(result)), result.operation_id))

    def send_status(self, operation_id: str) -> SendResult | None:
        with self.lock:
            row = self.db.execute("SELECT status,result FROM sends WHERE operation_id=?", (operation_id,)).fetchone()
            if row is None:
                return None
            if row[0] == "pending":
                return SendResult(operation_id, "unknown", "send_in_progress", cached=True)
            return self._send(row[1], cached=True)

    def ingest(self, chat: Chat, rows: list[dict]) -> ReadResult:
        # Validate the whole snapshot first; malformed batches do not partly enter the inbox.
        messages = [Message.from_row(chat, row) for row in rows]
        duplicates = 0
        with self.lock, self.db:
            messages,self.last_identity_defer=snapshot_identity.messages(self.db,chat,rows,Message,digest)
            for message in messages:
                old = self.db.execute("SELECT payload FROM inbox WHERE message_id=?", (message.message_id,)).fetchone()
                payload = self._dump(asdict(message))
                if old:
                    previous = json.loads(old[0])
                    # The old adapter may later resolve a voice/media label. Identity and role stay fixed.
                    if previous["role"] != message.role:
                        raise DriverError("message_identity_conflict")
                    if previous.get("text_complete") is not True:
                        self.db.execute("UPDATE inbox SET payload=? WHERE message_id=? AND acked=0",
                                        (payload, message.message_id))
                    duplicates += 1
                else:
                    self.db.execute("INSERT INTO inbox (message_id,chat_key,payload) VALUES (?,?,?)",
                                    (message.message_id, chat.key, payload))
            pending = self.db.execute("SELECT payload FROM inbox WHERE chat_key=? AND acked=0 ORDER BY sequence",
                                      (chat.key,)).fetchall()
        values = tuple(Message(**json.loads(row[0])) for row in pending)
        return ReadResult(tuple(m for m in values if m.text_complete is True), len(rows), duplicates,
                          tuple(m for m in values if m.text_complete is not True))

    def pending(self, chat: Chat) -> tuple[Message, ...]:
        with self.lock:
            rows = self.db.execute("SELECT payload FROM inbox WHERE chat_key=? AND acked=0 ORDER BY sequence",
                                   (chat.key,)).fetchall()
            return tuple(Message(**json.loads(row[0])) for row in rows
                         if json.loads(row[0]).get("text_complete") is True)

    def ack(self, message_ids: list[str]) -> int:
        with self.lock, self.db:
            count = 0
            for key in set(message_ids):
                row = self.db.execute("SELECT payload FROM inbox WHERE message_id=? AND acked=0",(key,)).fetchone()
                if row and json.loads(row[0]).get("text_complete") is True:
                    count += self.db.execute("UPDATE inbox SET acked=1 WHERE message_id=? AND acked=0", (key,)).rowcount
                    # Retire an older pending preview only after the complete v2 row is ACKed.
                    current=json.loads(row[0])
                    for legacy_id in current.get("legacy_message_ids", []):
                        previous=self.db.execute("SELECT payload FROM inbox WHERE message_id=? AND chat_key=?",(legacy_id,current["chat_key"])).fetchone()
                        if previous and json.loads(previous[0]).get("role")==current["role"]:
                            self.db.execute("UPDATE inbox SET acked=1 WHERE message_id=?",(legacy_id,))
            return count

    def close(self):
        with self.lock:
            self.db.close()
