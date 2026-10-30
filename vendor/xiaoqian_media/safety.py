"""Boundary checks shared by the store. No network, desktop, or model imports."""
from __future__ import annotations

import os
import re
import stat
from pathlib import Path


class MediaError(Exception):
    """Base class for predictable module failures."""


class UnsafePath(MediaError, ValueError):
    pass


class InvalidMedia(MediaError, ValueError):
    pass


class IntegrityError(MediaError):
    pass


class StoreBusy(MediaError):
    pass


class InvalidState(MediaError, ValueError):
    pass


class UnknownMedia(MediaError, KeyError):
    pass


_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)),
             *(f"lpt{i}" for i in range(1, 10))}


def collection_id(value: str) -> str:
    if (not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,47}", value)
            or value in _RESERVED):
        raise UnsafePath("collection_id must be a simple non-reserved lowercase identifier")
    return value


def media_id(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"m_[0-9a-f]{32}", value):
        raise UnsafePath("media_id must be an issued opaque ID, never a filename or path")
    return value


def plain_path(value: str | Path) -> Path:
    raw = os.fspath(value)
    # ADS, UNC/device paths, and non-drive colons are never accepted. The same
    # checks run on POSIX so a catalog cannot become dangerous when moved to Windows.
    if not isinstance(raw, str) or not raw or "\x00" in raw:
        raise UnsafePath("empty or invalid path")
    if raw.startswith(("\\\\", "//")) or ":" in raw[2:] or (":" in raw and not re.match(r"^[A-Za-z]:[/\\]", raw)):
        raise UnsafePath("UNC, device, alternate-stream, or ambiguous drive path")
    path = Path(raw)
    if not path.is_absolute() or ".." in path.parts:
        raise UnsafePath("an absolute path without parent traversal is required")
    return path


def is_link(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def checked_path(path: Path, *, file: bool = False, missing: bool = False) -> Path:
    """Reject symlinks and Windows junction/reparse points on every existing component."""
    path = plain_path(path)
    for part in [*reversed(path.parents), path]:
        try:
            info = part.lstat()
        except FileNotFoundError:
            if missing:
                continue
            raise UnsafePath("path does not exist") from None
        if is_link(info):
            raise UnsafePath("symlinks and reparse points are not allowed")
        if part != path and not stat.S_ISDIR(info.st_mode):
            raise UnsafePath("a parent component is not a directory")
    if file:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise UnsafePath("only regular, non-hardlinked files are allowed")
    return path


def child(root: Path, name: str, *, file: bool = False, missing: bool = False) -> Path:
    if (not isinstance(name, str) or not name or name in {".", ".."}
            or any(c in name for c in '/\\:\x00') or name.endswith((" ", "."))):
        raise UnsafePath("invalid single path component")
    checked_path(root)
    path = checked_path(root / name, file=file, missing=missing)
    if path.resolve().parent != root.resolve():
        raise UnsafePath("path escapes its configured directory")
    return path


def read_regular(path: Path, limit: int) -> bytes:
    checked_path(path, file=True)
    before = path.lstat()
    if before.st_size > limit:
        raise InvalidMedia("file exceeds byte limit")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)):
            raise UnsafePath("file changed during boundary validation")
        data = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
    checked_path(path, file=True)
    current = path.lstat()
    if len(data) > limit:
        raise InvalidMedia("file exceeds byte limit")
    identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
    if identity(before) != identity(after) or identity(after) != identity(current):
        raise IntegrityError("file changed while reading")
    return data
