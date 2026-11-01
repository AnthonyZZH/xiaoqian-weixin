import copy
import importlib.util
from pathlib import Path
import sys
import types
import unittest

SOURCE = Path(__file__).resolve().parents[2]/"compat/vendor/xiaoqian_driver/native_image_surface.py"
spec = importlib.util.spec_from_file_location("tested_native_image_surface", SOURCE)
surface = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = surface
spec.loader.exec_module(surface)


class Control:
    def __init__(self, rid, kind="PaneControl", klass="Synthetic", aid="", box=(0, 0, 600, 600), name="", parent=None):
        self.rid = rid
        self.ControlTypeName, self.ClassName, self.AutomationId = kind, klass, aid
        self.BoundingRectangle = types.SimpleNamespace(left=box[0], top=box[1], right=box[2], bottom=box[3])
        self.Name, self.IsOffscreen = name, False
        self.NativeWindowHandle = 0
        self.parent, self.children = parent, []
        if parent is not None:
            parent.children.append(self)

    def GetRuntimeId(self):
        return (self.rid,)

    def GetParentControl(self):
        return self.parent

    def GetChildren(self):
        return list(self.children)


class API:
    def __init__(self):
        self.foreground, self.pid, self.clear, self.captures = 99, 7, True, []
        self.after_capture = None
        self.bad_length = False

    def foreground_window(self):
        return self.foreground

    def window_pid(self, hwnd):
        return self.pid

    def candidates(self, row, selector):
        matches = []
        todo = list(row.children)
        while todo:
            item = todo.pop()
            if all(getattr(item, key, None) == value for key, value in selector.items()):
                matches.append(item)
            todo.extend(item.children)
        return matches

    def occlusion_free(self, hwnd, control, bounds):
        return self.clear

    def capture_rgba(self, bounds):
        self.captures.append(copy.deepcopy(bounds))
        if self.after_capture:
            self.after_capture()
        return bytes([0, 255, 0, 255])*(bounds["width"]*bounds["height"]-(1 if self.bad_length else 0))


def fixture():
    window = Control(1, "WindowControl", box=(-100, -50, 800, 700))
    window.NativeWindowHandle = 99
    row_control = Control(2, box=(10, 20, 400, 250), name="SYNTHETIC IMAGE ROW", parent=window)
    # Avatar is not selected by the exact accepted content-image class.
    Control(3, "ImageControl", "SyntheticAvatar", box=(12, 25, 42, 55), parent=row_control)
    image = Control(4, "ImageControl", "SyntheticContentImage", box=(60, 40, 180, 160), parent=row_control)
    row = types.SimpleNamespace(role="user", image=object(), native_row=row_control)
    chat = types.SimpleNamespace(name="SYNTHETIC OWNER", mode="private", key="synthetic-chat-key")
    adapter = types.SimpleNamespace(window=window, hwnd=99, target=chat.name, mode=chat.mode, draft="SYNTHETIC DRAFT")
    adapter.validate = lambda: "SYNTHETIC EDIT"
    adapter.input_value = lambda edit: adapter.draft
    backend = types.SimpleNamespace(adapter=adapter, module=types.SimpleNamespace(KEEP_FRONT=False), chat=chat)
    api = API()
    profile = {"verified": True, "evidenceId": "SYNTHETIC ONLY", "contentImage": {"ControlTypeName": "ImageControl", "ClassName": "SyntheticContentImage"}}
    provider = surface.NativeUIASurface(backend, profile, api)
    return types.SimpleNamespace(window=window, native=row_control, image=image, row=row, chat=chat, adapter=adapter,
                                 backend=backend, api=api, profile=profile, provider=provider)


class Tests(unittest.TestCase):
    def test_measure_does_not_capture_or_modify_draft_and_state_is_detached(self):
        f = fixture()
        proof = f.provider.measure(f.chat, f.row)
        self.assertEqual([], f.api.captures)
        self.assertEqual("SYNTHETIC DRAFT", f.adapter.draft)
        self.assertEqual({"x": 60, "y": 40, "width": 120, "height": 120}, proof.state["imageBounds"])
        changed = proof.state
        changed["imageBounds"]["x"] = 0
        self.assertEqual(60, proof.state["imageBounds"]["x"])
        self.assertTrue(f.provider.current(proof))

    def test_capture_only_exact_image_region_and_rgba(self):
        f = fixture()
        proof = f.provider.measure(f.chat, f.row)
        result = f.provider.capture(proof)
        self.assertEqual(proof.state["imageBounds"], result["bounds"])
        self.assertEqual([proof.state["imageBounds"]], f.api.captures)
        self.assertEqual(bytes([0, 255, 0, 255])*14400, result["rgba"])

    def test_native_image_flag_accepts_without_legacy_broad_crop(self):
        f = fixture();f.row.image = None;f.row.native_image_available = True
        proof = f.provider.measure(f.chat, f.row)
        self.assertTrue(f.provider.current(proof))
        self.assertEqual(120*120*4, len(f.provider.capture(proof)["rgba"]))
        for flag in (False, None):
            f = fixture();f.row.image = None;f.row.native_image_available = flag
            with self.subTest(flag=flag), self.assertRaisesRegex(surface.SurfaceError, "IMAGE_INCOMING_REQUIRED"):
                f.provider.measure(f.chat, f.row)

    def test_missing_or_generic_profile_fails_without_native_api(self):
        f = fixture()
        for profile in ({}, {"verified": True, "evidenceId": "x", "contentImage": {"ControlTypeName": "ImageControl"}},
                        {"verified": True, "evidenceId": "x", "contentImage": {"ControlTypeName": "ImageControl", "ClassName": "Image"}}):
            with self.subTest(profile=profile), self.assertRaises(surface.SurfaceError):
                surface.NativeUIASurface(f.backend, profile, f.api)

    def test_ambiguous_or_missing_exact_content_control_rejected(self):
        for duplicate in (False, True):
            f = fixture()
            if duplicate:
                Control(5, "ImageControl", "SyntheticContentImage", box=(200, 40, 300, 140), parent=f.native)
            else:
                f.image.ClassName = "UnknownControl"
            with self.subTest(duplicate=duplicate), self.assertRaisesRegex(surface.SurfaceError, "IMAGE_CONTROL_NOT_UNIQUE"):
                f.provider.measure(f.chat, f.row)

    def test_wrong_chat_role_native_row_keep_front_or_foreground_rejected(self):
        mutations = [lambda f: setattr(f.backend, "chat", object()), lambda f: setattr(f.row, "role", "assistant"),
                     lambda f: setattr(f.row, "native_row", None), lambda f: setattr(f.backend.module, "KEEP_FRONT", True),
                     lambda f: setattr(f.api, "foreground", 123)]
        for mutation in mutations:
            f = fixture();mutation(f)
            with self.subTest(mutation=mutation), self.assertRaises(surface.SurfaceError):
                f.provider.measure(f.chat, f.row)
            self.assertEqual([], f.api.captures)

    def test_offscreen_external_overlay_and_outside_row_rejected(self):
        mutations = [lambda f: setattr(f.native, "IsOffscreen", True), lambda f: setattr(f.image, "IsOffscreen", True),
                     lambda f: setattr(f.api, "clear", False), lambda f: setattr(f.image.BoundingRectangle, "right", 500)]
        for mutation in mutations:
            f = fixture();mutation(f)
            with self.subTest(mutation=mutation), self.assertRaises(surface.SurfaceError):
                f.provider.measure(f.chat, f.row)

    def test_recycled_control_row_window_pid_draft_bounds_are_stale(self):
        mutations = [lambda f: setattr(f.native, "rid", 22), lambda f: setattr(f.image, "rid", 44),
                     lambda f: setattr(f.window, "rid", 11), lambda f: setattr(f.api, "pid", 9),
                     lambda f: setattr(f.adapter, "draft", "CHANGED"), lambda f: setattr(f.native, "Name", "CHANGED"),
                     lambda f: setattr(f.image.BoundingRectangle, "left", 61)]
        for mutation in mutations:
            f = fixture();proof = f.provider.measure(f.chat, f.row);mutation(f)
            with self.subTest(mutation=mutation):
                self.assertFalse(f.provider.current(proof))
                with self.assertRaisesRegex(surface.SurfaceError, "IMAGE_SNAPSHOT_STALE"):
                    f.provider.capture(proof)
                self.assertEqual([], f.api.captures)

    def test_forged_and_other_surface_measurements_are_rejected(self):
        f, other = fixture(), fixture()
        real = other.provider.measure(other.chat, other.row)
        for forged in (real, real.state, {"verified": True}, None):
            with self.subTest(forged=type(forged)):
                self.assertFalse(f.provider.current(forged))

    def test_change_during_capture_discards_frame(self):
        f = fixture();proof = f.provider.measure(f.chat, f.row)
        f.api.after_capture = lambda: setattr(f.adapter, "draft", "changed during screenshot")
        with self.assertRaisesRegex(surface.SurfaceError, "IMAGE_SNAPSHOT_STALE"):
            f.provider.capture(proof)

    def test_bad_frame_length_and_fractional_or_oversized_bounds_fail(self):
        f = fixture();proof = f.provider.measure(f.chat, f.row);f.api.bad_length = True
        with self.assertRaisesRegex(surface.SurfaceError, "IMAGE_NATIVE_FRAME_INVALID"):
            f.provider.capture(proof)
        for right in (180.5, 700):
            g = fixture();g.native.BoundingRectangle.right = 790;g.image.BoundingRectangle.right = right
            with self.subTest(right=right), self.assertRaises(surface.SurfaceError):
                g.provider.measure(g.chat, g.row)

    def test_native_z_order_intersection_and_hit_test_reject_occlusion(self):
        import ctypes
        from ctypes import wintypes
        f = fixture()
        api = surface.WindowsNativeAPI.__new__(surface.WindowsNativeAPI)
        api.c, api.w = ctypes, wintypes
        overlay = types.SimpleNamespace(box=(500, 500, 550, 550), dwm_status=0)
        def get_rect(hwnd, pointer):
            value = ctypes.cast(pointer, ctypes.POINTER(wintypes.RECT)).contents
            value.left, value.top, value.right, value.bottom = overlay.box
            return True
        def dwm(hwnd, attribute, pointer, size):
            ctypes.cast(pointer, ctypes.POINTER(wintypes.DWORD)).contents.value = 0
            return overlay.dwm_status
        api.user = types.SimpleNamespace(GetWindow=lambda hwnd, command: 100 if hwnd == 99 else 0,
                                         IsWindowVisible=lambda hwnd: True, GetWindowRect=get_rect)
        api.dwm = types.SimpleNamespace(DwmGetWindowAttribute=dwm)
        api.auto = types.SimpleNamespace(ControlFromPoint=lambda x, y: f.image)
        bounds = {"x": 60, "y": 40, "width": 120, "height": 120}
        self.assertTrue(api.occlusion_free(99, f.image, bounds))
        overlay.box = (70, 60, 90, 80)
        self.assertFalse(api.occlusion_free(99, f.image, bounds))
        overlay.box = (500, 500, 550, 550)
        overlay.dwm_status = 1
        self.assertFalse(api.occlusion_free(99, f.image, bounds))
        overlay.dwm_status = 0
        api.auto.ControlFromPoint = lambda x, y: f.native
        self.assertFalse(api.occlusion_free(99, f.image, bounds))

    def test_native_z_order_loop_fails_closed(self):
        import ctypes
        from ctypes import wintypes
        f = fixture()
        api = surface.WindowsNativeAPI.__new__(surface.WindowsNativeAPI)
        api.c, api.w = ctypes, wintypes
        api.user = types.SimpleNamespace(GetWindow=lambda hwnd, command: 100, IsWindowVisible=lambda hwnd: False)
        self.assertFalse(api.occlusion_free(99, f.image, {"x": 60, "y": 40, "width": 120, "height": 120}))

    def test_small_internal_sibling_overlay_is_rejected_without_pixel_sampling(self):
        f = fixture()
        api = surface.WindowsNativeAPI.__new__(surface.WindowsNativeAPI)
        bounds = {"x": 60, "y": 40, "width": 120, "height": 120}
        self.assertTrue(api.internal_clear(99, f.image, bounds))
        overlay = Control(50, "PaneControl", "SyntheticPopover", box=(70, 70, 74, 74), parent=f.native)
        self.assertFalse(api.internal_clear(99, f.image, bounds))
        overlay.IsOffscreen = True
        self.assertTrue(api.internal_clear(99, f.image, bounds))


if __name__ == "__main__":
    unittest.main()
