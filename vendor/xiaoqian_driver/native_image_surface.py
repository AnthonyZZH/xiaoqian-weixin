"""Worker-only image measurement. Broker owns proof lifetime and one-shot capture."""
import hashlib
import math
from dataclasses import dataclass
from .image_native import ImageError as SurfaceError, require


def runtime_id(control):
    value = tuple(control.GetRuntimeId())
    require(value and len(value) <= 32 and all(type(x) is int for x in value), 'IMAGE_RUNTIME_ID_INVALID')
    return value


def rectangle(control):
    box = control.BoundingRectangle
    values = [box.left, box.top, box.right, box.bottom]
    require(all(isinstance(x, (int, float)) and math.isfinite(x) and int(x) == x for x in values), 'IMAGE_PHYSICAL_BOUNDS_REQUIRED')
    left, top, right, bottom = map(int, values)
    require(abs(left) <= 1000000 and abs(top) <= 1000000 and right > left and bottom > top, 'IMAGE_BOUNDS_INVALID')
    return dict(x=left, y=top, width=right-left, height=bottom-top)


def inside(a, b):
    return (a['x'] >= b['x'] and a['y'] >= b['y'] and
            a['x']+a['width'] <= b['x']+b['width'] and a['y']+a['height'] <= b['y']+b['height'])


def descendant(control, ancestor):
    target = runtime_id(ancestor)
    for _ in range(32):
        if control is None: return False
        if runtime_id(control) == target: return True
        control = control.GetParentControl()
    return False


def text_hash(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


@dataclass(eq=False)
class Measurement:
    state: dict
    context: dict
    chat: object
    row: object
    pixels: bytes | None = None


class NativeUIASurface:
    context_error = 'IMAGE_CONTEXT_INVALID'

    def __init__(self, backend, profile, api=None):
        self.backend, self.profile = backend, dict(profile)
        self.api = api if api is not None else WindowsNativeAPI(backend.module)
        require(profile.get('verified') is True and isinstance(profile.get('evidenceId'), str) and profile['evidenceId'], 'IMAGE_CONTROL_PROFILE_REQUIRED')
        if isinstance(self, NativeRowImageSurface):
            mode = profile.get('boundaryMode')
            require(mode in ('pure-photo-row/v1', 'photo-sticker-row/v2') and
                    profile.get('layoutRevision') == ('incoming-avatar64-content2of3/v2' if mode == 'photo-sticker-row/v2' else 'incoming-avatar64/v1') and
                    isinstance(profile.get('ownerChatKey'), str) and profile['ownerChatKey'], 'IMAGE_ROW_PROFILE_REQUIRED')
            self.static_sticker_profile = mode == 'photo-sticker-row/v2'
        else:
            selector = profile.get('contentImage')
            require(isinstance(selector, dict) and set(selector) <= {'ControlTypeName', 'ClassName', 'AutomationId'} and
                    selector.get('ControlTypeName') == 'ImageControl', 'IMAGE_CONTROL_PROFILE_REQUIRED')
            positive = [selector[k] for k in ('ClassName', 'AutomationId') if k in selector]
            require(positive and all(isinstance(x, str) and 0 < len(x) <= 200 for x in positive), 'IMAGE_CONTROL_PROFILE_REQUIRED')
            require(selector.get('AutomationId') or selector.get('ClassName') not in {'Image', 'ImageControl', 'Static', 'Picture'}, 'IMAGE_CONTROL_PROFILE_AMBIGUOUS')
            self.selector = dict(selector)

    def _base_context(self, chat, row):
        backend, adapter = self.backend, self.backend.adapter
        require(getattr(backend.module, 'KEEP_FRONT', None) is False, 'IMAGE_NONACTIVATING_ADAPTER_REQUIRED')
        require(backend.chat == chat and adapter.target == chat.name and adapter.mode == chat.mode, 'IMAGE_CHAT_CHANGED')
        require(getattr(row, 'role', None) == 'user' and
                (getattr(row, 'native_image_available', False) is True or getattr(row, 'image', None) is not None), 'IMAGE_INCOMING_REQUIRED')
        native = getattr(row, 'native_row', None)
        require(native is not None, 'IMAGE_NATIVE_ROW_REQUIRED')
        edit = adapter.validate()
        window, hwnd = adapter.window, int(adapter.hwnd)
        pid = int(self.api.window_pid(hwnd))
        require(hwnd > 0 and pid > 0 and self.api.foreground_window() == hwnd, 'IMAGE_WINDOW_NOT_FOREGROUND')
        require(not window.IsOffscreen and not native.IsOffscreen and descendant(native, window), 'IMAGE_ROW_NOT_VISIBLE')
        state = dict(window=dict(hwnd=hwnd, pid=pid, runtimeId=list(runtime_id(window))),
                     rowBounds=rectangle(native), rowRuntimeId=list(runtime_id(native)),
                     rowNameHash=text_hash(native.Name or ''), draftHash=text_hash(adapter.input_value(edit)))
        return state, native, window

    def _context(self, chat, row):
        state, native, window = self._base_context(chat, row)
        candidates = self.api.candidates(native, self.selector)
        require(len(candidates) == 1, 'IMAGE_CONTROL_NOT_UNIQUE')
        control = candidates[0]
        require(all(getattr(control, k, None) == v for k, v in self.selector.items()), 'IMAGE_CONTROL_CHANGED')
        require(not control.IsOffscreen and descendant(control, native), 'IMAGE_CONTROL_NOT_VISIBLE')
        bounds = rectangle(control)
        require(inside(bounds, state['rowBounds']) and inside(bounds, rectangle(window)), 'IMAGE_CONTROL_OUTSIDE_ROW')
        require(bounds['width'] <= 512 and bounds['height'] <= 512, 'IMAGE_NATIVE_PIXEL_LIMIT')
        require(self.api.occlusion_free(state['window']['hwnd'], control, bounds) is True, 'IMAGE_CONTROL_OCCLUDED')
        return dict(state, imageBounds=bounds, viewportBounds=dict(bounds), imageRuntimeId=list(runtime_id(control)))

    def observe(self, chat, row):
        try:
            context = self._context(chat, row)
            return Measurement(context, context, chat, row)
        except SurfaceError: raise
        except Exception: raise SurfaceError(self.context_error) from None

    def resolve(self, observation):
        require(self.current(observation), 'IMAGE_SNAPSHOT_STALE')
        return observation

    def current(self, proof):
        try: return self._context(proof.chat, proof.row) == proof.context
        except Exception: return False

    def capture(self, proof):
        require(self.current(proof), 'IMAGE_SNAPSHOT_STALE')
        bounds = proof.state['imageBounds']
        if proof.state.get('mediaKind') == 'animated_sticker_static_frame':
            pixels, proof.pixels = proof.pixels, None
            require(pixels is not None, 'IMAGE_CAPTURE_ALREADY_ATTEMPTED')
        else:
            pixels = self.api.capture_rgba(bounds)
        require(isinstance(pixels, bytes) and len(pixels) == bounds['width']*bounds['height']*4, 'IMAGE_NATIVE_FRAME_INVALID')
        if 'pixelSHA256' in proof.state:
            require(hashlib.sha256(pixels).hexdigest() == proof.state['pixelSHA256'], 'IMAGE_CONTENT_CHANGED')
        require(self.current(proof), 'IMAGE_SNAPSHOT_STALE')
        return dict(bounds=dict(bounds), rgba=pixels)


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
        return [self.auto.Control.CreateControlFromElement(elements.GetElement(i)) for i in range(min(2, elements.Length))]

    def occlusion_free(self, hwnd, image, bounds):
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
        xs = sorted({bounds["x"], bounds["x"]+bounds["width"]//2, bounds["x"]+bounds["width"]-1})
        ys = sorted({bounds["y"], bounds["y"]+bounds["height"]//2, bounds["y"]+bounds["height"]-1})
        for x in xs:
            for y in ys:
                hit = self.auto.ControlFromPoint(x, y)
                if hit is None or not descendant(hit, image):
                    return False
        return True

    def internal_clear(self, hwnd, image, bounds):
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


class NativeRowImageSurface(NativeUIASurface):
    context_error = 'IMAGE_ROW_CONTEXT_INVALID'

    def _context(self, chat, row):
        from .row_image_geometry import pure_photo_row, search_bounds
        require(chat.mode == 'private' and chat.key == self.profile['ownerChatKey'], 'IMAGE_OWNER_PRIVATE_INCOMING_REQUIRED')
        require(getattr(row, 'native_image_available', False) is True, 'IMAGE_NATIVE_ROW_REQUIRED')
        state, native, window = self._base_context(chat, row)
        kind = pure_photo_row(native.ClassName, native.Name, private=True, incoming=True,
                              allow_static_sticker=self.static_sticker_profile)
        hwnd = state['window']['hwnd']
        dpi = self.api.window_dpi(hwnd)
        listing = window.ListControl(AutomationId='chat_message_list')
        require(listing.Exists(.2) and not listing.IsOffscreen and descendant(native, listing) and descendant(listing, window), 'IMAGE_ROW_NOT_VISIBLE')
        viewport, window_bounds = rectangle(listing), rectangle(window)
        require(inside(state['rowBounds'], window_bounds), 'IMAGE_ROW_CLIPPED')
        search = search_bounds(state['rowBounds'], viewport, dpi, incoming_content_only=self.static_sticker_profile)
        require(self.api.occlusion_free(hwnd, native, search) is True, 'IMAGE_CONTROL_OCCLUDED')
        return dict(state, windowBounds=window_bounds, viewportBounds=viewport, dpi=dpi, searchBounds=search,
                    mediaKind=kind, sourceKind='static_screenshot', animationFramesAnalyzed=False)

    def resolve(self, observation):
        from .row_image_geometry import tight_photo
        require(self.current(observation), 'IMAGE_SNAPSHOT_STALE')
        context = observation.context
        try: pixels = self.api.capture_rgba(context['searchBounds'])
        except Exception: raise SurfaceError('IMAGE_MEASUREMENT_CAPTURE_UNKNOWN') from None
        content = tight_photo(context['searchBounds'], pixels, context['dpi'],
                              verified_owner_photo=context['mediaKind']=='photo_static_frame')
        require(self.current(observation), 'IMAGE_MEASUREMENT_STALE')
        state = {k: context[k] for k in ('window', 'rowBounds', 'rowRuntimeId', 'rowNameHash', 'draftHash', 'dpi', 'mediaKind', 'sourceKind', 'animationFramesAnalyzed')}
        state.update(imageBounds=content['bounds'], viewportBounds=dict(content['bounds']), pixelSHA256=content['sha256'],
                     boundaryMethod='native-photo-sticker-tight-content/v2' if self.static_sticker_profile else content['boundaryMethod'])
        # Keep only the validated tight sticker crop: its animation can advance before capture.
        pixels = content['rgba'] if context['mediaKind'] == 'animated_sticker_static_frame' else None
        return Measurement(state, context, observation.chat, observation.row, pixels)
