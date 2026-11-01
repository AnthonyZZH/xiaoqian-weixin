"""Exact native message-image measurement and bounded screenshot acquisition.

No selection, focus, scrolling, viewer, file or network operations. The worker
must already own DesktopLease and the canonical row. Importing this module does
not import UIA/PIL or capture anything. Profile provenance is trusted host code.
"""
from __future__ import annotations

import copy
import hashlib
import math
import weakref
from dataclasses import dataclass

MAX_EDGE = 512
MAX_PIXELS = 262144


class SurfaceError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


NativeImageSurfaceError = SurfaceError


def require(value, code):
    if not value:
        raise SurfaceError(code)


def runtime_id(control):
    value = tuple(control.GetRuntimeId())
    require(value and len(value) <= 32 and all(type(x) is int for x in value), "IMAGE_RUNTIME_ID_INVALID")
    return value


def rectangle(control):
    box = control.BoundingRectangle
    values = [box.left, box.top, box.right, box.bottom]
    require(all(isinstance(x, (int, float)) and math.isfinite(x) and int(x) == x for x in values), "IMAGE_PHYSICAL_BOUNDS_REQUIRED")
    left, top, right, bottom = map(int, values)
    require(abs(left) <= 1000000 and abs(top) <= 1000000 and right > left and bottom > top, "IMAGE_BOUNDS_INVALID")
    return {"x": left, "y": top, "width": right-left, "height": bottom-top}


def inside(a, b):
    return (a["x"] >= b["x"] and a["y"] >= b["y"] and
            a["x"]+a["width"] <= b["x"]+b["width"] and
            a["y"]+a["height"] <= b["y"]+b["height"])


def descendant(control, ancestor):
    target = runtime_id(ancestor)
    current = control
    for _ in range(32):
        if current is None:
            return False
        if runtime_id(current) == target:
            return True
        current = current.GetParentControl()
    return False


def text_hash(value):
    require(isinstance(value, str), "IMAGE_CONTEXT_INVALID")
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True, eq=False)
class NativeImageMeasurement:
    _state: dict
    _chat: object
    _row: object
    _image: object
    _window: object

    @property
    def state(self):
        return copy.deepcopy(self._state)


class NativeUIASurface:
    revision = "native-image-surface/v1"

    def __init__(self, backend, profile, api=None):
        require(isinstance(profile, dict) and profile.get("verified") is True and
                isinstance(profile.get("evidenceId"), str) and bool(profile["evidenceId"]), "IMAGE_CONTROL_PROFILE_REQUIRED")
        selector = profile.get("contentImage")
        require(isinstance(selector, dict) and set(selector) <= {"ControlTypeName", "ClassName", "AutomationId"} and
                selector.get("ControlTypeName") == "ImageControl", "IMAGE_CONTROL_PROFILE_REQUIRED")
        positive = [selector.get(key) for key in ("ClassName", "AutomationId") if key in selector]
        require(positive and all(isinstance(x, str) and 0 < len(x) <= 200 for x in positive), "IMAGE_CONTROL_PROFILE_REQUIRED")
        require(bool(selector.get("AutomationId")) or selector.get("ClassName") not in
                {"Image", "ImageControl", "Static", "Picture"}, "IMAGE_CONTROL_PROFILE_AMBIGUOUS")
        self.backend = backend
        self.selector = dict(selector)
        self.api = api if api is not None else WindowsNativeAPI(backend.module)
        self._issued = weakref.WeakSet()

    def _context(self, chat, row, image=None):
        backend = self.backend
        adapter = backend.adapter
        # validate() must never invoke the legacy keep_front() path.
        require(getattr(backend.module, "KEEP_FRONT", None) is False, "IMAGE_NONACTIVATING_ADAPTER_REQUIRED")
        require(backend.chat == chat and adapter.target == chat.name and adapter.mode == chat.mode, "IMAGE_CHAT_CHANGED")
        require(getattr(row, "role", None) == "user" and
                (getattr(row, "native_image_available", False) is True or getattr(row, "image", None) is not None), "IMAGE_INCOMING_REQUIRED")
        native_row = getattr(row, "native_row", None)
        require(native_row is not None, "IMAGE_NATIVE_ROW_REQUIRED")
        edit = adapter.validate()
        window = adapter.window
        hwnd = int(adapter.hwnd)
        pid = int(self.api.window_pid(hwnd))
        require(hwnd > 0 and pid > 0 and self.api.foreground_window() == hwnd, "IMAGE_WINDOW_NOT_FOREGROUND")
        require(not window.IsOffscreen and not native_row.IsOffscreen and descendant(native_row, window), "IMAGE_ROW_NOT_VISIBLE")
        candidates = self.api.candidates(native_row, self.selector)
        require(len(candidates) == 1, "IMAGE_CONTROL_NOT_UNIQUE")
        control = candidates[0]
        require(all(getattr(control, key, None) == value for key, value in self.selector.items()), "IMAGE_CONTROL_CHANGED")
        require(not control.IsOffscreen and descendant(control, native_row), "IMAGE_CONTROL_NOT_VISIBLE")
        if image is not None:
            require(runtime_id(control) == runtime_id(image), "IMAGE_CONTROL_CHANGED")
        bounds, row_bounds, window_bounds = rectangle(control), rectangle(native_row), rectangle(window)
        require(inside(bounds, row_bounds) and inside(bounds, window_bounds), "IMAGE_CONTROL_OUTSIDE_ROW")
        require(bounds["width"] <= MAX_EDGE and bounds["height"] <= MAX_EDGE and
                bounds["width"]*bounds["height"] <= MAX_PIXELS, "IMAGE_NATIVE_PIXEL_LIMIT")
        require(self.api.occlusion_free(hwnd, control, bounds) is True, "IMAGE_CONTROL_OCCLUDED")
        state = {"imageBounds": bounds, "viewportBounds": dict(bounds), "rowBounds": row_bounds,
                 "window": {"hwnd": hwnd, "pid": pid, "runtimeId": list(runtime_id(window))},
                 "rowRuntimeId": list(runtime_id(native_row)), "imageRuntimeId": list(runtime_id(control)),
                 "rowNameHash": text_hash(native_row.Name or ""),
                 "draftHash": text_hash(adapter.input_value(edit))}
        return state, native_row, control, window

    def measure(self, chat, row):
        try:
            state, native_row, control, window = self._context(chat, row)
            result = NativeImageMeasurement(state, chat, row, control, window)
            self._issued.add(result)
            return result
        except SurfaceError:
            raise
        except Exception:
            raise SurfaceError("IMAGE_CONTEXT_INVALID") from None

    def current(self, proof):
        if not isinstance(proof, NativeImageMeasurement) or proof not in self._issued:
            return False
        try:
            state, *_ = self._context(proof._chat, proof._row, proof._image)
            return state == proof._state
        except Exception:
            return False

    def capture(self, proof):
        require(self.current(proof), "IMAGE_SNAPSHOT_STALE")
        bounds = proof.state["imageBounds"]
        try:
            rgba = self.api.capture_rgba(bounds)
        except SurfaceError:
            raise
        except Exception:
            raise SurfaceError("IMAGE_NATIVE_CAPTURE_FAILED") from None
        require(isinstance(rgba, bytes) and len(rgba) == bounds["width"]*bounds["height"]*4, "IMAGE_NATIVE_FRAME_INVALID")
        require(self.current(proof), "IMAGE_SNAPSHOT_STALE")
        return {"bounds": bounds, "rgba": rgba}


class WindowsNativeAPI:
    """Read-only native calls; instantiated only by an explicitly active worker."""
    def __init__(self, module):
        import ctypes as c
        from ctypes import wintypes as w
        import uiautomation as auto
        self.c, self.w, self.auto, self.module = c, w, auto, module
        self.user = c.WinDLL("user32", use_last_error=True)
        self.dwm = c.WinDLL("dwmapi", use_last_error=True)
        self.user.GetWindow.argtypes = [w.HWND, w.UINT]
        self.user.GetWindow.restype = w.HWND
        self.user.IsWindowVisible.argtypes = [w.HWND]
        self.user.IsWindowVisible.restype = w.BOOL
        self.user.GetWindowRect.argtypes = [w.HWND, c.POINTER(w.RECT)]
        self.user.GetWindowRect.restype = w.BOOL
        self.user.GetDpiForWindow.argtypes = [w.HWND]
        self.user.GetDpiForWindow.restype = w.UINT
        self.dwm.DwmGetWindowAttribute.argtypes = [w.HWND, w.DWORD, c.c_void_p, w.DWORD]
        self.dwm.DwmGetWindowAttribute.restype = c.c_long

    def foreground_window(self):
        return int(self.module.foreground())

    def window_pid(self, hwnd):
        return int(self.module.window_pid(hwnd))

    def window_dpi(self, hwnd):
        return int(self.user.GetDpiForWindow(hwnd))

    def candidates(self, row, selector):
        from uiautomation.uiautomation import _AutomationClient
        holder = _AutomationClient.instance()
        client = holder.IUIAutomation
        condition = client.CreatePropertyCondition(self.auto.PropertyId.ControlTypeProperty, self.auto.ControlType.ImageControl)
        for name in ("ClassName", "AutomationId"):
            if name in selector:
                condition = client.CreateAndCondition(condition, client.CreatePropertyCondition(getattr(self.auto.PropertyId, name+"Property"), selector[name]))
        elements = row.Element.FindAll(holder.UIAutomationCore.TreeScope_Descendants, condition)
        # Two is sufficient evidence of ambiguity; no unbounded tree traversal.
        return [self.auto.Control.CreateControlFromElement(elements.GetElement(i)) for i in range(min(2, elements.Length))]

    def occlusion_free(self, hwnd, image, bounds):
        # Inspect every top-level window above this actual WeChat HWND. Even
        # transparent/unknown intersecting windows fail closed. No activation.
        current = self.user.GetWindow(hwnd, 3)  # GW_HWNDPREV
        seen = set()
        while current:
            if current in seen or len(seen) >= 256:
                return False
            seen.add(current)
            if self.user.IsWindowVisible(current):
                cloaked = self.w.DWORD()
                status = self.dwm.DwmGetWindowAttribute(current, 14, self.c.byref(cloaked), self.c.sizeof(cloaked))
                box = self.w.RECT()
                if status != 0 or not self.user.GetWindowRect(current, self.c.byref(box)):
                    return False
                if not cloaked.value and (box.left < bounds["x"]+bounds["width"] and box.right > bounds["x"] and
                                          box.top < bounds["y"]+bounds["height"] and box.bottom > bounds["y"]):
                    return False
            current = self.user.GetWindow(current, 3)
        if not self.internal_clear(hwnd, image, bounds):
            return False
        # Native hit tests also reject child popovers/menus at image boundaries
        # and center; the accepted image-control profile remains mandatory.
        xs = sorted({bounds["x"], bounds["x"]+bounds["width"]//2, bounds["x"]+bounds["width"]-1})
        ys = sorted({bounds["y"], bounds["y"]+bounds["height"]//2, bounds["y"]+bounds["height"]-1})
        for x in xs:
            for y in ys:
                hit = self.auto.ControlFromPoint(x, y)
                if hit is None or not descendant(hit, image):
                    return False
        return True

    def internal_clear(self, hwnd, image, bounds):
        # Inspect siblings along the exact UIA ancestor chain, rather than just
        # a few pixels: any visible sibling whose bounds overlap is uncertain,
        # including a small child popover missed by corner/center hit tests.
        chain = [image]
        for _ in range(32):
            if getattr(chain[-1], "NativeWindowHandle", 0) == hwnd:
                break
            parent = chain[-1].GetParentControl()
            if parent is None:
                return False
            chain.append(parent)
        else:
            return False
        for child, parent in zip(chain, chain[1:]):
            children = parent.GetChildren()
            if len(children) > 256:
                return False
            child_id = runtime_id(child)
            if sum(runtime_id(item) == child_id for item in children) != 1:
                return False
            for item in children:
                if runtime_id(item) == child_id or item.IsOffscreen:
                    continue
                try:
                    box = rectangle(item)
                except Exception:
                    return False
                if (box["x"] < bounds["x"]+bounds["width"] and box["x"]+box["width"] > bounds["x"] and
                        box["y"] < bounds["y"]+bounds["height"] and box["y"]+box["height"] > bounds["y"]):
                    return False
        return True

    def capture_rgba(self, bounds):
        from PIL import ImageGrab
        image = ImageGrab.grab(bbox=(bounds["x"], bounds["y"], bounds["x"]+bounds["width"], bounds["y"]+bounds["height"]), all_screens=True)
        converted = None
        try:
            require(image.size == (bounds["width"], bounds["height"]), "IMAGE_PHYSICAL_CAPTURE_MISMATCH")
            converted = image.convert("RGBA")
            return converted.tobytes()
        finally:
            if converted is not None:
                converted.close()
            image.close()


@dataclass(frozen=True, eq=False)
class RowImageMeasurement:
    _state: dict
    _context: dict
    _chat: object
    _row: object

    @property
    def state(self):
        return copy.deepcopy(self._state)


class NativeRowImageSurface:
    """Tight image content in an explicitly pure photo row, with no child UIA.

    A bounded local-only, avatar-excluded measurement frame establishes content
    bounds. Only the exact crop can leave the worker. Both screenshot stages
    validate the same owner, row, draft, window, viewport, DPI and occlusion.
    An explicitly accepted r7 profile also admits the observed native animated
    sticker label. Other reference/caption/video rows remain unverified.
    """
    revision = 'photo-sticker-row-surface/v2'

    def __init__(self, backend, profile, api=None):
        require(isinstance(profile, dict) and profile.get('verified') is True and
                isinstance(profile.get('evidenceId'), str) and bool(profile['evidenceId']) and
                profile.get('boundaryMode') in ('pure-photo-row/v1', 'photo-sticker-row/v2') and
                profile.get('layoutRevision') == ('incoming-avatar64-content2of3/v2' if profile.get('boundaryMode') == 'photo-sticker-row/v2' else 'incoming-avatar64/v1') and
                isinstance(profile.get('ownerChatKey'), str) and bool(profile['ownerChatKey']), 'IMAGE_ROW_PROFILE_REQUIRED')
        self.backend, self.profile = backend, copy.deepcopy(profile)
        self.static_sticker_profile = profile['boundaryMode'] == 'photo-sticker-row/v2'
        self.api = api if api is not None else WindowsNativeAPI(backend.module)
        self._issued = weakref.WeakSet()
        self._observed = weakref.WeakSet()
        self._measurement_attempted = weakref.WeakSet()
        self._static_sticker_frames = weakref.WeakKeyDictionary()

    def _context(self, chat, row, *, defer_group_header=False):
        from .row_image_geometry import pure_photo_row, search_bounds
        backend, adapter = self.backend, self.backend.adapter
        group_keys=self.profile.get('groupChatKeys',[])
        require(isinstance(group_keys,list) and len(group_keys)<=1 and all(isinstance(k,str) and k for k in group_keys),'IMAGE_GROUP_SCOPE_UNAUTHORIZED')
        is_group=chat.mode=='group' and chat.key in group_keys
        require((chat.mode=='private' and chat.key==self.profile['ownerChatKey']) or is_group,'IMAGE_GROUP_SCOPE_UNAUTHORIZED')
        require(getattr(backend.module, 'KEEP_FRONT', None) is False, 'IMAGE_NONACTIVATING_ADAPTER_REQUIRED')
        require(backend.chat == chat and adapter.target == chat.name and adapter.mode == chat.mode, 'IMAGE_CHAT_CHANGED')
        native = getattr(row, 'native_row', None)
        require(native is not None and getattr(row, 'role', None) == 'user' and
                getattr(row, 'native_image_available', False) is True, 'IMAGE_NATIVE_ROW_REQUIRED')
        media_kind = pure_photo_row(native.ClassName, native.Name, private=chat.mode=='private', incoming=True,authorized_group=is_group,
                                   allow_static_sticker=self.static_sticker_profile,allow_refer_photo=self.profile.get('allowReferPhotos') is True)
        edit = adapter.validate()
        window, hwnd = adapter.window, int(adapter.hwnd)
        pid, dpi = int(self.api.window_pid(hwnd)), self.api.window_dpi(hwnd)
        require(hwnd > 0 and pid > 0 and self.api.foreground_window() == hwnd, 'IMAGE_WINDOW_NOT_FOREGROUND')
        listing = window.ListControl(AutomationId='chat_message_list')
        require(listing.Exists(.2) and not window.IsOffscreen and not listing.IsOffscreen and
                not native.IsOffscreen and descendant(native, listing) and descendant(listing, window), 'IMAGE_ROW_NOT_VISIBLE')
        row_bounds, viewport, window_bounds = rectangle(native), rectangle(listing), rectangle(window)
        require(inside(row_bounds, window_bounds), 'IMAGE_ROW_CLIPPED')
        measured_row=dict(row_bounds);header_proof=None
        if is_group and not defer_group_header:
            sender=getattr(row,'sender','')
            require(isinstance(sender,str) and bool(sender),'IMAGE_GROUP_SENDER_UNAVAILABLE')
            pending=[(native,0)];headers=[];visited=0
            while pending:
                control,depth=pending.pop();visited+=1
                require(visited<=96,'IMAGE_GROUP_HEADER_UNVERIFIED')
                if depth>5:continue
                if getattr(control,'ControlTypeName',None)=='TextControl' and not control.IsOffscreen and control.Name==sender:
                    box=rectangle(control);scale=dpi/96
                    if (inside(box,row_bounds) and box['x']>=row_bounds['x']+round(64*scale) and
                        6*scale<=box['height']<=28*scale and box['y']>=row_bounds['y'] and box['y']+box['height']<=row_bounds['y']+round(40*scale)):
                        headers.append((control,box))
                pending.extend((c,depth+1) for c in control.GetChildren())
            require(len(headers)==1,'IMAGE_GROUP_HEADER_UNVERIFIED')
            header,header_bounds=headers[0];top=header_bounds['y']+header_bounds['height']+round(2*dpi/96)
            measured_row.update(y=top,height=row_bounds['y']+row_bounds['height']-top)
            header_proof={'runtimeId':list(runtime_id(header)),'bounds':header_bounds,'nameHash':text_hash(header.Name)}
        search = search_bounds(measured_row, viewport, dpi, incoming_content_only=self.static_sticker_profile)
        require(self.api.occlusion_free(hwnd, native, search) is True, 'IMAGE_CONTROL_OCCLUDED')
        return {'window': {'hwnd': hwnd, 'pid': pid, 'runtimeId': list(runtime_id(window))},
                'windowBounds': window_bounds, 'viewportBounds': viewport, 'rowBounds': row_bounds,
                'rowRuntimeId': list(runtime_id(native)), 'rowNameHash': text_hash(native.Name or ''),
                'draftHash': text_hash(adapter.input_value(edit)), 'dpi': dpi, 'searchBounds': search,
                'groupHeader':header_proof,'mediaKind': media_kind, 'sourceKind': 'static_screenshot', 'animationFramesAnalyzed': False}

    def observe(self, chat, row):
        """Read-stage native context only. Existing/ACKed photos cost no pixels."""
        try:
            context = self._context(chat, row,defer_group_header=True)
            proof = RowImageMeasurement({'phase': 'observed'}, context, chat, row)
            self._observed.add(proof)
            return proof
        except Exception as error:
            code = getattr(error, 'code', None)
            raise SurfaceError(code if isinstance(code, str) else 'IMAGE_ROW_CONTEXT_INVALID') from None

    def resolve(self, observation):
        from .row_image_geometry import tight_photo
        require(isinstance(observation, RowImageMeasurement) and observation in self._observed, 'IMAGE_OBSERVATION_UNKNOWN')
        require(observation not in self._measurement_attempted, 'IMAGE_MEASUREMENT_ALREADY_ATTEMPTED')
        require(self.current(observation), 'IMAGE_SNAPSHOT_STALE')
        self._measurement_attempted.add(observation)
        chat, row = observation._chat, observation._row
        context = self._context(chat,row) if chat.mode=='group' else observation._context
        try:
            try:
                pixels = self.api.capture_rgba(context['searchBounds'])
            except Exception:
                raise SurfaceError('IMAGE_MEASUREMENT_CAPTURE_UNKNOWN') from None
            content = tight_photo(context['searchBounds'], pixels, context['dpi'])
            require(self._context(chat, row) == context, 'IMAGE_MEASUREMENT_STALE')
            state = {key: copy.deepcopy(context[key]) for key in ('window', 'rowBounds', 'rowRuntimeId', 'rowNameHash', 'draftHash')}
            state.update(imageBounds=content['bounds'], viewportBounds=dict(content['bounds']),
                         boundaryMethod='native-photo-sticker-tight-content/v2' if self.static_sticker_profile else content['boundaryMethod'], pixelSHA256=content['sha256'], dpi=context['dpi'],
                         mediaKind=context['mediaKind'], sourceKind='static_screenshot', animationFramesAnalyzed=False)
            result = RowImageMeasurement(state, context, chat, row)
            self._issued.add(result)
            if context['mediaKind'] == 'animated_sticker_static_frame':
                # An animation can advance between two screen grabs. Preserve
                # only the tight crop of this one already validated frame,
                # never the search frame/row/avatar. Driver epoch, row context,
                # TTL, and one-shot capability checks remain authoritative.
                self._static_sticker_frames[result] = bytes(content['rgba'])
            return result
        except Exception as error:
            code = getattr(error, 'code', None)
            if isinstance(code, str):
                raise SurfaceError(code) from None
            raise SurfaceError('IMAGE_ROW_CONTEXT_INVALID') from None

    def measure(self, chat, row):
        return self.resolve(self.observe(chat, row))

    def current(self, proof):
        if not isinstance(proof, RowImageMeasurement) or (proof not in self._issued and proof not in self._observed):
            return False
        try:
            return self._context(proof._chat, proof._row,defer_group_header=proof.state.get('phase')=='observed') == proof._context
        except Exception:
            return False

    def capture(self, proof):
        require(proof in self._issued, 'IMAGE_CONTENT_NOT_MEASURED')
        require(self.current(proof), 'IMAGE_SNAPSHOT_STALE')
        bounds = proof.state['imageBounds']
        if proof.state.get('mediaKind') == 'animated_sticker_static_frame':
            pixels = self._static_sticker_frames.pop(proof, None)
            require(pixels is not None, 'IMAGE_CAPTURE_ALREADY_ATTEMPTED')
        else:
            pixels = self.api.capture_rgba(bounds)
        require(isinstance(pixels, bytes) and len(pixels) == bounds['width']*bounds['height']*4 and
                hashlib.sha256(pixels).hexdigest() == proof.state['pixelSHA256'], 'IMAGE_CONTENT_CHANGED')
        require(self.current(proof), 'IMAGE_SNAPSHOT_STALE')
        return {'bounds': bounds, 'rgba': pixels}
