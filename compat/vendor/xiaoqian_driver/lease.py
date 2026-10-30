"""OS-held leases; locks release on process death, without stale PID guessing."""
from __future__ import annotations

import os
from pathlib import Path

from .protocol import DriverError


class FileLease:
    def __init__(self, path: Path):
        self._file = None
        path.parent.mkdir(parents=True, exist_ok=True)
        stream = open(path, "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                stream.seek(0, os.SEEK_END)
                if stream.tell() == 0:
                    stream.write(b"\0")
                    stream.flush()
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            stream.close()
            raise DriverError("driver_lease_busy") from None
        self._file = stream

    def close(self):
        if self._file is None:
            return
        try:
            if os.name == "nt":
                import msvcrt
                self._file.seek(0)
                msvcrt.locking(self._file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self._file.fileno(), fcntl.LOCK_UN)
        finally:
            self._file.close()
            self._file = None


# Local namespace is session-scoped. Identity comes from the OS token and window
# objects, never TEMP, usernames in environment variables, or client configuration.
import threading
from .protocol import digest

_desktop_registry_lock = threading.Lock()
_held_desktop_names: set[str] = set()


def desktop_mutex_name(identity=None) -> str:
    if identity is None:
        identity = _WindowsAPI().identity()
    sid, session, station, desktop = identity
    return "Local\\Xiaoqian.WeChat.UI.v1." + digest(
        [sid, int(session), station.casefold(), desktop.casefold()])


class _WindowsAPI:
    def __init__(self):
        if os.name != "nt":
            raise DriverError("real_driver_requires_windows")
        import ctypes as c
        from ctypes import wintypes as w
        self.ctypes, self.types = c, w
        self.kernel = c.WinDLL("kernel32", use_last_error=True)
        self.user = c.WinDLL("user32", use_last_error=True)
        self.security = c.WinDLL("advapi32", use_last_error=True)
        k, u, a = self.kernel, self.user, self.security
        declarations = [
            (k, "GetCurrentProcess", [], w.HANDLE),
            (k, "GetCurrentProcessId", [], w.DWORD),
            (k, "GetCurrentThreadId", [], w.DWORD),
            (k, "ProcessIdToSessionId", [w.DWORD, c.POINTER(w.DWORD)], w.BOOL),
            (k, "CreateMutexW", [c.c_void_p, w.BOOL, w.LPCWSTR], w.HANDLE),
            (k, "WaitForSingleObject", [w.HANDLE, w.DWORD], w.DWORD),
            (k, "ReleaseMutex", [w.HANDLE], w.BOOL),
            (k, "CloseHandle", [w.HANDLE], w.BOOL),
            (k, "LocalFree", [c.c_void_p], c.c_void_p),
            (u, "GetProcessWindowStation", [], w.HANDLE),
            (u, "GetThreadDesktop", [w.DWORD], w.HANDLE),
            (u, "GetUserObjectInformationW", [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.POINTER(w.DWORD)], w.BOOL),
            (a, "OpenProcessToken", [w.HANDLE, w.DWORD, c.POINTER(w.HANDLE)], w.BOOL),
            (a, "GetTokenInformation", [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.POINTER(w.DWORD)], w.BOOL),
            (a, "ConvertSidToStringSidW", [c.c_void_p, c.POINTER(c.c_void_p)], w.BOOL),
        ]
        for dll, name, args, result in declarations:
            function = getattr(dll, name)
            function.argtypes, function.restype = args, result

    def _object_name(self, handle):
        c, w = self.ctypes, self.types
        needed = w.DWORD()
        if not handle:
            raise DriverError("desktop_identity_unavailable")
        self.user.GetUserObjectInformationW(handle, 2, None, 0, c.byref(needed))
        if not needed.value:
            raise DriverError("desktop_identity_unavailable")
        buffer = c.create_unicode_buffer((needed.value + c.sizeof(c.c_wchar) - 1) // c.sizeof(c.c_wchar))
        if not self.user.GetUserObjectInformationW(handle, 2, buffer, c.sizeof(buffer), c.byref(needed)):
            raise DriverError("desktop_identity_unavailable")
        return buffer.value

    def identity(self):
        c, w, k, a = self.ctypes, self.types, self.kernel, self.security
        token, sid_text = w.HANDLE(), c.c_void_p()
        if not a.OpenProcessToken(k.GetCurrentProcess(), 0x0008, c.byref(token)):
            raise DriverError("desktop_identity_unavailable")
        try:
            needed = w.DWORD()
            a.GetTokenInformation(token, 1, None, 0, c.byref(needed))
            if not needed.value:
                raise DriverError("desktop_identity_unavailable")
            buffer = c.create_string_buffer(needed.value)
            if not a.GetTokenInformation(token, 1, buffer, len(buffer), c.byref(needed)):
                raise DriverError("desktop_identity_unavailable")
            # TOKEN_USER begins with SID_AND_ATTRIBUTES whose first field is PSID.
            sid = c.cast(buffer, c.POINTER(c.c_void_p))[0]
            if not a.ConvertSidToStringSidW(sid, c.byref(sid_text)):
                raise DriverError("desktop_identity_unavailable")
            sid_string = c.wstring_at(sid_text)
        finally:
            if sid_text.value:
                k.LocalFree(sid_text)
            k.CloseHandle(token)
        session = w.DWORD()
        if not k.ProcessIdToSessionId(k.GetCurrentProcessId(), c.byref(session)):
            raise DriverError("desktop_identity_unavailable")
        station = self._object_name(self.user.GetProcessWindowStation())
        desktop = self._object_name(self.user.GetThreadDesktop(k.GetCurrentThreadId()))
        return sid_string, session.value, station, desktop


class DesktopLease:
    """Nonblocking OS mutex for the current user's actual session and desktop.

    Real worker only; no files, configurable lock roots, or security changes.
    WAIT_ABANDONED permits recovery after the owning process dies.
    """
    def __init__(self):
        self._handle = None
        try:
            self._api = _WindowsAPI()
            self.name = desktop_mutex_name(self._api.identity())
        except DriverError:
            raise
        except Exception:
            raise DriverError("desktop_identity_unavailable") from None
        k = self._api.kernel
        with _desktop_registry_lock:
            if self.name in _held_desktop_names:
                raise DriverError("driver_lease_busy")
            handle = k.CreateMutexW(None, False, self.name)
            if not handle:
                raise DriverError("desktop_lease_unavailable")
            status = k.WaitForSingleObject(handle, 0)
            if status not in (0, 0x80):
                k.CloseHandle(handle)
                if status == 0x102:
                    raise DriverError("driver_lease_busy")
                raise DriverError("desktop_lease_unavailable")
            self._handle = handle
            self._owner_thread = k.GetCurrentThreadId()
            _held_desktop_names.add(self.name)

    def close(self):
        with _desktop_registry_lock:
            if self._handle is None:
                return
            k = self._api.kernel
            if k.GetCurrentThreadId() != self._owner_thread:
                raise DriverError("desktop_lease_wrong_thread")
            if not k.ReleaseMutex(self._handle):
                raise DriverError("desktop_lease_release_failed")
            k.CloseHandle(self._handle)
            self._handle = None
            _held_desktop_names.discard(self.name)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
