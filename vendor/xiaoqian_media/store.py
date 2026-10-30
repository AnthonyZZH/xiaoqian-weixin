"""Independent sticker catalog and review queue; never sends or acquires WeChat media."""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import unicodedata
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass, replace
from pathlib import Path

from .formats import MAX_BYTES, MediaInfo, inspect_bytes
from .safety import (IntegrityError, InvalidMedia, InvalidState, StoreBusy, UnknownMedia,
                     UnsafePath, checked_path, child, collection_id, media_id, plain_path,
                     read_regular)

_FORMATS = {"gif": ".gif", "webp": ".webp", "apng": ".png", "png": ".png", "jpeg": ".jpg"}
_STATUSES = {"pending", "kept", "discarded"}
_SOURCE_KINDS = {"original_file", "static_capture"}
_INDEX_LIMIT = 8 * 1024 * 1024
_PREVIEW_LIMIT = 1024 * 1024


def _text(value, maximum, *, required=False):
    if not isinstance(value, str) or "\x00" in value:
        raise ValueError("text must be a string without NUL")
    value = " ".join(unicodedata.normalize("NFC", value).split())
    if len(value) > maximum or (required and not value):
        raise ValueError(f"text must contain {'1' if required else '0'}..{maximum} characters")
    return value


def _tags(values):
    if not isinstance(values, (list, tuple)) or len(values) > 12:
        raise ValueError("tags must be a list or tuple of at most 12 strings")
    return tuple(dict.fromkeys(_text(v, 40, required=True) for v in values))


def _limit(value):
    if type(value) is not int or not 1 <= value <= 1000:
        raise ValueError("limit must be an integer in 1..1000")
    return value


def _hash(data):
    return hashlib.sha256(data).hexdigest()


def _digest(value):
    if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise IntegrityError("invalid catalog digest")
    return value


@dataclass(frozen=True)
class PreviewInfo:
    extension: str
    sha256: str
    byte_count: int
    static_preview: bool = True


@dataclass(frozen=True)
class MediaRecord:
    media_id: str
    collection_id: str
    status: str
    name: str
    description: str
    tags: tuple[str, ...]
    source_kind: str
    source_label: str
    sha256: str
    byte_count: int
    info: MediaInfo
    created_ns: int
    updated_ns: int
    preview: PreviewInfo | None = None

    def to_dict(self):
        row = asdict(self)
        row["tags"] = list(self.tags)
        row["original_animation_unknown"] = self.source_kind == "static_capture"
        return row


@dataclass(frozen=True)
class SendTarget:
    """A checked original file. Resolution grants no permission to actually send."""
    media_id: str
    collection_id: str
    path: Path
    sha256: str
    byte_count: int
    format: str
    animated: bool
    source_kind: str
    static_preview: bool = False


@dataclass(frozen=True)
class PreviewTarget:
    media_id: str
    path: Path
    label: str
    original_animated: bool
    original_animation_unknown: bool
    static_preview: bool = True
    render_mode: str = "first_frame_static"


class MediaLibrary:
    """One isolated collection. Constructing/importing this module has no network/UI effects.

    Multiple instances/processes may share a collection: each write takes an exclusive
    lock file and reloads the atomic JSON index. A busy/stale lock fails closed.
    Storage and import roots must be operator-controlled directories.
    """

    def __init__(self, root: str | Path, collection: str = "default", *,
                 allowed_import_roots=(), max_bytes=MAX_BYTES, max_pending=300, require_existing=False):
        self.collection_id = collection_id(collection)
        if type(max_bytes) is not int or not 1 <= max_bytes <= MAX_BYTES:
            raise ValueError("max_bytes must be in 1..20 MiB")
        if type(max_pending) is not int or not 1 <= max_pending <= 10000:
            raise ValueError("max_pending must be in 1..10000")
        self.max_bytes, self.max_pending = max_bytes, max_pending
        self._thread_lock = threading.RLock()
        root = plain_path(root)
        if type(require_existing) is not bool:
            raise ValueError("require_existing must be boolean")
        if require_existing and not root.is_dir():
            raise InvalidState("media root missing; refusing an empty replacement library")
        checked_path(root, missing=True)
        if root.is_dir() and child(root, "index.json", missing=True).exists():
            raise InvalidState("direct index at media root; check legacy schema or extra collection nesting")
        if require_existing:
            folder = child(root, self.collection_id)
            for part in ("originals", "previews"):
                if not child(folder, part).is_dir():
                    raise InvalidState("media collection directory missing")
            child(folder, "index.json", file=True)
        root.mkdir(parents=True, exist_ok=True)
        checked_path(root)
        if not root.is_dir():
            raise UnsafePath("storage root must be a directory")
        self.root = root.resolve()
        self._root_identity = self._identity(self.root)
        self.folder = child(self.root, self.collection_id, missing=True)
        self.folder.mkdir(exist_ok=True)
        self._folder_identity = self._identity(checked_path(self.folder))
        self.originals = child(self.folder, "originals", missing=True)
        self.previews = child(self.folder, "previews", missing=True)
        self.originals.mkdir(exist_ok=True)
        self.previews.mkdir(exist_ok=True)
        self._originals_identity = self._identity(checked_path(self.originals))
        self._previews_identity = self._identity(checked_path(self.previews))
        roots = []
        for value in allowed_import_roots:
            candidate = checked_path(plain_path(value))
            if not candidate.is_dir():
                raise UnsafePath("import root must be a directory")
            roots.append((candidate.resolve(), self._identity(candidate)))
        self._import_roots = tuple(roots)
        self._assert_layout()
        self._load()  # corrupt existing indexes never silently become an empty library

    @staticmethod
    def _identity(path):
        info = path.lstat()
        return info.st_dev, info.st_ino

    def _assert_layout(self):
        for path, expected in ((self.root, self._root_identity), (self.folder, self._folder_identity),
                               (self.originals, self._originals_identity), (self.previews, self._previews_identity)):
            checked_path(path)
            if not path.is_dir() or self._identity(path) != expected:
                raise UnsafePath("configured storage directory was replaced")

    @contextmanager
    def _operation(self, *, write=False):
        with self._thread_lock:
            self._assert_layout()
            token = None
            lock = child(self.folder, ".write.lock", missing=True)
            if write:
                try:
                    fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
                except FileExistsError:
                    raise StoreBusy("collection is locked; do not remove a lock until its owner is confirmed stopped") from None
                try:
                    token = self._identity(lock)
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(f"pid={os.getpid()}\n".encode("ascii"))
                except BaseException:
                    if token is not None and self._identity(lock) == token:
                        lock.unlink()
                    raise
            try:
                yield
            finally:
                if token is not None:
                    self._assert_layout()
                    checked_path(lock, file=True)
                    if self._identity(lock) != token:
                        raise UnsafePath("write lock was replaced")
                    lock.unlink()

    def _decode_record(self, row, key):
        try:
            expected_fields = set(MediaRecord.__dataclass_fields__) | {"original_animation_unknown"}
            if not isinstance(row, dict) or set(row) != expected_fields:
                raise IntegrityError("unknown or missing catalog fields")
            if media_id(row["media_id"]) != media_id(key) or row["collection_id"] != self.collection_id:
                raise IntegrityError("catalog ID mismatch")
            if row["status"] not in _STATUSES or row["source_kind"] not in _SOURCE_KINDS:
                raise IntegrityError("invalid catalog state/provenance")
            info = MediaInfo(**row["info"])
            if info.format not in _FORMATS or info.extension != _FORMATS[info.format] or info.inspection != "container_only":
                raise IntegrityError("invalid catalog format")
            if (type(info.animated) is not bool or type(info.frame_count) is not int
                    or not 1 <= info.frame_count <= 10000 or info.animated != (info.frame_count > 1)
                    or type(info.width) is not int or type(info.height) is not int
                    or not 0 < info.width <= 16384 or not 0 < info.height <= 16384
                    or info.width * info.height > 100_000_000):
                raise IntegrityError("invalid catalog image metadata")
            if type(row["byte_count"]) is not int or not 1 <= row["byte_count"] <= self.max_bytes:
                raise IntegrityError("invalid catalog byte count")
            if any(type(row[k]) is not int or row[k] < 0 for k in ("created_ns", "updated_ns")):
                raise IntegrityError("invalid catalog timestamps")
            preview = PreviewInfo(**row["preview"]) if row["preview"] is not None else None
            if preview and (preview.extension not in (".png", ".jpg") or preview.static_preview is not True
                            or type(preview.byte_count) is not int or not 0 < preview.byte_count <= _PREVIEW_LIMIT):
                raise IntegrityError("invalid preview metadata")
            if preview:
                _digest(preview.sha256)
            if (row["source_kind"] == "static_capture" and info.animated
                    or row["original_animation_unknown"] is not (row["source_kind"] == "static_capture")):
                raise IntegrityError("invalid static capture provenance")
            record = MediaRecord(key, self.collection_id, row["status"], _text(row["name"], 120),
                                 _text(row["description"], 1000), _tags(row["tags"]), row["source_kind"],
                                 _text(row["source_label"], 120), _digest(row["sha256"]), row["byte_count"],
                                 info, row["created_ns"], row["updated_ns"], preview)
            if record.status == "kept" and not record.description:
                raise IntegrityError("kept media must have a description")
            return record
        except (KeyError, TypeError, ValueError) as exc:
            raise IntegrityError("invalid catalog record") from exc

    def _load(self):
        path = child(self.folder, "index.json", missing=True)
        if not path.exists():
            return {}
        try:
            def unique(pairs):
                out = {}
                for key, value in pairs:
                    if key in out:
                        raise IntegrityError("duplicate JSON catalog key")
                    out[key] = value
                return out
            document = json.loads(read_regular(path, _INDEX_LIMIT), object_pairs_hook=unique)
            if (not isinstance(document, dict) or set(document) != {"schema_version", "collection_id", "records"}
                    or type(document["schema_version"]) is not int or document["schema_version"] != 1
                    or document["collection_id"] != self.collection_id or not isinstance(document["records"], dict)
                    or len(document["records"]) > 10000):
                raise IntegrityError("unsupported or invalid catalog schema")
            return {key: self._decode_record(row, key) for key, row in document["records"].items()}
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise IntegrityError("catalog JSON is corrupt; explicit recovery is required") from exc

    def _atomic_write(self, directory, filename, data):
        self._assert_layout()
        destination = child(directory, filename, missing=True)
        if destination.exists():
            checked_path(destination, file=True)
        temporary = child(directory, f".tmp_{uuid.uuid4().hex}", missing=True)
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            self._assert_layout()
            child(directory, filename, missing=True)
            os.replace(temporary, destination)
        finally:
            if temporary.exists():
                checked_path(temporary, file=True)
                temporary.unlink()

    def _save(self, records):
        document = {"schema_version": 1, "collection_id": self.collection_id,
                    "records": {key: row.to_dict() for key, row in records.items()}}
        data = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(data) > _INDEX_LIMIT:
            raise InvalidState("catalog metadata capacity reached")
        self._atomic_write(self.folder, "index.json", data)

    def _original_path(self, record):
        return child(self.originals, media_id(record.media_id) + _FORMATS[record.info.format], file=True)

    def _payload(self, record):
        path = self._original_path(record)
        data = read_regular(path, self.max_bytes)
        if len(data) != record.byte_count or _hash(data) != record.sha256 or inspect_bytes(data, self.max_bytes) != record.info:
            raise IntegrityError("original media changed since import")
        return path, data

    @staticmethod
    def _find(records, key, *, active=True):
        media_id(key)
        if key not in records:
            raise UnknownMedia(key)
        row = records[key]
        if active and row.status == "discarded":
            raise InvalidState("discarded media is unavailable")
        return row

    def import_bytes(self, data: bytes, *, description="", name="", tags=(), source_kind="original_file",
                     source_label="provided-file", deduplicate=True) -> MediaRecord:
        if type(deduplicate) is not bool:
            raise ValueError("deduplicate must be boolean")
        info = inspect_bytes(data, self.max_bytes)
        if source_kind not in _SOURCE_KINDS:
            raise ValueError("source_kind must be original_file or static_capture")
        if source_kind == "static_capture" and info.animated:
            raise InvalidMedia("static captures must contain one static frame")
        description, name = _text(description, 1000), _text(name, 120)
        tags, source_label = _tags(tags), _text(source_label, 120)
        digest = _hash(data)
        with self._operation(write=True):
            records = self._load()
            for row in records.values():
                if deduplicate and row.status != "discarded" and row.sha256 == digest and row.source_kind == source_kind:
                    self._payload(row)  # duplicates do not conceal missing/tampered originals
                    return row
            if sum(row.status == "pending" for row in records.values()) >= self.max_pending or len(records) >= 10000:
                raise InvalidState("review queue or catalog capacity reached")
            key, now = "m_" + uuid.uuid4().hex, time.time_ns()
            row = MediaRecord(key, self.collection_id, "pending", name, description, tags, source_kind,
                              source_label, digest, len(data), info, now, now)
            filename = key + info.extension
            if child(self.originals, filename, missing=True).exists():
                raise IntegrityError("new media ID collides with an existing file")
            self._atomic_write(self.originals, filename, data)
            records[key] = row
            try:
                self._save(records)
            except BaseException:
                child(self.originals, filename, file=True).unlink()
                raise
            return row

    def import_file(self, source: str | Path, **metadata) -> MediaRecord:
        source = plain_path(source)
        # Check lexical containment before any file read, then validate all parents.
        root = next(((r, identity) for r, identity in self._import_roots if source.is_relative_to(r)), None)
        if root is None:
            raise UnsafePath("source is outside explicitly configured import roots")
        checked_path(root[0])
        if self._identity(root[0]) != root[1]:
            raise UnsafePath("configured import root was replaced")
        checked_path(source, file=True)
        if not source.resolve().is_relative_to(root[0]) or source.resolve().is_relative_to(self.root):
            raise UnsafePath("source escapes import root or refers to managed storage")
        extension = source.suffix.lower()
        if extension not in (".gif", ".webp", ".png", ".apng", ".jpg", ".jpeg"):
            raise InvalidMedia("unsupported source extension")
        data = read_regular(source, self.max_bytes)
        info = inspect_bytes(data, self.max_bytes)
        allowed = {".png": {"png", "apng"}, ".apng": {"apng"}, ".gif": {"gif"},
                   ".webp": {"webp"}, ".jpg": {"jpeg"}, ".jpeg": {"jpeg"}}
        if info.format not in allowed[extension]:
            raise InvalidMedia("source extension and container signature disagree")
        if "source_kind" in metadata:
            raise ValueError("import_file provenance is always original_file; use import_static_capture for screenshots")
        return self.import_bytes(data, source_kind="original_file", **metadata)

    def import_static_capture(self, data: bytes, **metadata) -> MediaRecord:
        if "source_kind" in metadata:
            raise ValueError("capture provenance cannot be overridden")
        metadata.setdefault("source_label", "static-screen-capture")
        return self.import_bytes(data, source_kind="static_capture", **metadata)

    def get(self, key) -> MediaRecord:
        with self._operation():
            return self._find(self._load(), key, active=False)

    def catalog(self, *, status="kept", limit=60) -> list[MediaRecord]:
        _limit(limit)
        if status not in _STATUSES:
            raise ValueError("invalid status")
        with self._operation():
            rows = [row for row in self._load().values() if row.status == status]
        return sorted(rows, key=lambda row: (row.created_ns, row.media_id))[:limit]

    def pending(self, limit=300) -> list[MediaRecord]:
        return self.catalog(status="pending", limit=limit)

    def search(self, query, *, status="kept", limit=20) -> list[MediaRecord]:
        _limit(limit)
        query = _text(query, 200).casefold()
        if status not in _STATUSES:
            raise ValueError("invalid status")
        with self._operation():
            rows = sorted((r for r in self._load().values() if r.status == status),
                          key=lambda r: (r.created_ns, r.media_id))
        if not query:
            return rows[:limit]
        tokens = set(query.split())
        scored = []
        for row in rows:
            text = unicodedata.normalize("NFC", " ".join((row.name, row.description, *row.tags))).casefold()
            score = 3 * int(query in text) + sum(token in text for token in tokens)
            if score:
                scored.append((score, row))
        scored.sort(key=lambda pair: (-pair[0], pair[1].created_ns, pair[1].media_id))
        return [row for _, row in scored[:limit]]

    def set_description(self, key, description, *, name=None, tags=None) -> MediaRecord:
        description = _text(description, 1000, required=True)
        with self._operation(write=True):
            records = self._load()
            row = self._find(records, key)
            row = replace(row, description=description, name=_text(name, 120) if name is not None else row.name,
                          tags=_tags(tags) if tags is not None else row.tags, updated_ns=time.time_ns())
            records[key] = row
            self._save(records)
            return row

    def keep(self, key) -> MediaRecord:
        with self._operation(write=True):
            records = self._load()
            row = self._find(records, key)
            if not row.description:
                raise InvalidState("a human/model description is required before keeping")
            self._payload(row)
            row = replace(row, status="kept", updated_ns=time.time_ns())
            records[key] = row
            self._save(records)
            return row

    def discard(self, key) -> MediaRecord:
        with self._operation(write=True):
            records = self._load()
            row = self._find(records, key, active=False)
            if row.status == "discarded":
                remaining = child(self.originals, row.media_id + row.info.extension, missing=True)
                if remaining.exists():
                    self._payload(row)[0].unlink()
                if row.preview:
                    remaining_preview = child(self.previews, row.media_id + "_" + row.preview.sha256 + row.preview.extension, missing=True)
                    if remaining_preview.exists():
                        self._checked_preview(row).unlink()
                return row
            path, _ = self._payload(row)
            preview_path = self._checked_preview(row) if row.preview else None
            row = replace(row, status="discarded", updated_ns=time.time_ns())
            records[key] = row
            # Tombstone first: a crash cannot leave an outgoing-eligible catalog entry.
            self._save(records)
            checked_path(path, file=True).unlink()
            if preview_path:
                checked_path(preview_path, file=True).unlink()
            return row

    def attach_preview(self, key, data: bytes) -> MediaRecord:
        info = inspect_bytes(data, _PREVIEW_LIMIT)
        if info.animated or info.format not in ("png", "jpeg"):
            raise InvalidMedia("derived previews must be static PNG or JPEG")
        with self._operation(write=True):
            records = self._load()
            row = self._find(records, key)
            preview = PreviewInfo(info.extension, _hash(data), len(data))
            preview_name = key + "_" + preview.sha256 + preview.extension
            created = not child(self.previews, preview_name, missing=True).exists()
            self._atomic_write(self.previews, preview_name, data)
            old = row.preview
            row = replace(row, preview=preview, updated_ns=time.time_ns())
            records[key] = row
            try:
                self._save(records)
            except BaseException:
                if created:
                    child(self.previews, preview_name, file=True).unlink()
                raise
            if old and old != preview:
                child(self.previews, key + "_" + old.sha256 + old.extension, file=True).unlink()
            return row

    def _checked_preview(self, row):
        preview = row.preview
        path = child(self.previews, row.media_id + "_" + preview.sha256 + preview.extension, file=True)
        data = read_regular(path, _PREVIEW_LIMIT)
        if _hash(data) != preview.sha256 or len(data) != preview.byte_count:
            raise IntegrityError("derived preview changed since attachment")
        info = inspect_bytes(data, _PREVIEW_LIMIT)
        if info.animated or info.format not in ("png", "jpeg"):
            raise IntegrityError("derived preview is not static")
        return path

    def preview_target(self, key) -> PreviewTarget:
        with self._operation():
            row = self._find(self._load(), key)
            original, _ = self._payload(row)
            path = self._checked_preview(row) if row.preview else original
            unknown = row.source_kind == "static_capture"
            label = ("静态截图；原始动画未知，无法从截图复原" if unknown else
                     "首帧静态预览；发送仍使用原始动画文件" if row.info.animated else "静态预览")
            return PreviewTarget(key, path, label, row.info.animated, unknown)

    def _send(self, key, allow_static_capture):
        if type(allow_static_capture) is not bool:
            raise ValueError("allow_static_capture must be boolean")
        row = self._find(self._load(), key)
        if row.status != "kept":
            raise InvalidState("pending media cannot be sent before review")
        if row.source_kind == "static_capture" and not allow_static_capture:
            raise InvalidState("static capture needs explicit caller opt-in; it is not an original animation")
        path, data = self._payload(row)
        return SendTarget(key, self.collection_id, path, row.sha256, row.byte_count, row.info.format,
                          row.info.animated, row.source_kind), data

    def resolve_send_target(self, key, *, allow_static_capture=False) -> SendTarget:
        """Resolve only an issued kept ID; verify bytes and boundary again immediately before send."""
        with self._operation():
            return self._send(key, allow_static_capture)[0]

    def read_for_send(self, key, *, allow_static_capture=False) -> tuple[SendTarget, bytes]:
        """Return the exact verified bytes for a caller-owned adapter; no file reopening needed."""
        with self._operation():
            return self._send(key, allow_static_capture)
