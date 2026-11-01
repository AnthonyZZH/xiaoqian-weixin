"""Conservative tight-content bounds for an accepted native media row.

All pixels stay in the worker. This is not OCR, arbitrary-region capture, or a
generic classifier for reference/video rows. The observed static-sticker
class/label pair requires its separately accepted layout. Border pixels matching the
chat background may be omitted; no native image subcontrol is required.
"""
import hashlib
import math


class GeometryError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(value, code):
    if not value:
        raise GeometryError(code)


PURE_CLASS = 'mmui::ChatImageItemView'
PURE_LABELS = frozenset(('图片', '[图片]', 'Photo', '[Photo]', 'Image', '[Image]'))


def pure_photo_row(klass, name, *, private, incoming, allow_static_sticker=False, authorized_group=False, allow_refer_photo=False):
    require((private is True or authorized_group is True) and incoming is True, 'IMAGE_OWNER_PRIVATE_INCOMING_REQUIRED')
    # This exact native class/label pair is present in the retained real r7
    # screenshot, not inferred from the word Refer. It is a single static frame.
    if allow_static_sticker and klass=='mmui::ChatBubbleReferItemView':
        label=name.strip() if isinstance(name,str) else None
        require(label=='\u52a8\u753b\u8868\u60c5' or allow_refer_photo and label in PURE_LABELS,'IMAGE_PURE_NATIVE_LABEL_REQUIRED')
        return 'animated_sticker_static_frame' if label=='\u52a8\u753b\u8868\u60c5' else 'photo_static_frame'
    if allow_refer_photo and klass=='mmui::ChatBubbleReferItemView' and isinstance(name,str) and name.strip() in PURE_LABELS:
        return 'photo_static_frame'
    # The r4 cat itself used ChatBubbleReferItemView. A missing accepted
    # boundary profile does not establish mixed content or prohibit stickers.
    require(klass == PURE_CLASS, 'IMAGE_ROW_BOUNDARY_UNVERIFIED')
    require(isinstance(name, str) and name.strip() in PURE_LABELS, 'IMAGE_PURE_NATIVE_LABEL_REQUIRED')
    return 'photo_static_frame'


def inside(a, b):
    return a['x'] >= b['x'] and a['y'] >= b['y'] and a['x']+a['width'] <= b['x']+b['width'] and a['y']+a['height'] <= b['y']+b['height']


def search_bounds(row, viewport, dpi, *, incoming_content_only=False):
    require(all(type(a.get(k)) is int for a in (row, viewport) for k in ('x', 'y', 'width', 'height')), 'IMAGE_PHYSICAL_BOUNDS_REQUIRED')
    require(inside(row, viewport), 'IMAGE_ROW_CLIPPED')
    require(type(dpi) is int and 96 <= dpi <= 240, 'IMAGE_DPI_UNSUPPORTED')
    # The accepted incoming layout excludes the entire avatar column before any
    # screenshot. A mandatory empty gap below rejects an incorrect layout/zoom.
    guard = round(64*dpi/96)
    require(0 < row['height'] <= 512 and guard+32 < row['width'] <= 2048, 'IMAGE_ROW_FRAME_LIMIT')
    # The real r7 row includes a scrollbar at the far right. The accepted
    # incoming-side layout measures only the left two-thirds, as the existing
    # adapter's incoming bubble path does. Crossing this edge is still refused
    # by tight_photo's mandatory background guard; no broad row is transmitted.
    right = row['width']*2//3 if incoming_content_only else row['width']
    require(right-guard >= 32, 'IMAGE_ROW_FRAME_LIMIT')
    return {'x': row['x']+guard, 'y': row['y'], 'width': right-guard, 'height': row['height']}


def tight_photo(frame_bounds, rgba, dpi):
    """Inspect only the already avatar-excluded row. Return cropped RGBA.

    Reject uncertain backgrounds, loading rectangles, disconnected labels or
    content reaching any search edge. No raw frame is returned or persisted.
    """
    w, h = frame_bounds['width'], frame_bounds['height']
    require(type(w) is int and type(h) is int and 32 <= w <= 2048 and 8 <= h <= 512, 'IMAGE_ROW_FRAME_LIMIT')
    require(type(dpi) is int and 96 <= dpi <= 240, 'IMAGE_DPI_UNSUPPORTED')
    require(isinstance(rgba, bytes) and len(rgba) == w*h*4, 'IMAGE_FRAME_INVALID')
    require(all(rgba[i] == 255 for i in range(3, len(rgba), 4)), 'IMAGE_ALPHA_UNSUPPORTED')
    strip = [rgba[(y*w+x)*4:(y*w+x)*4+3] for y in range(h) for x in range(w-4, w)]
    bg = tuple(sorted(p[c] for p in strip)[len(strip)//2] for c in range(3))
    require(all(max(abs(p[c]-bg[c]) for c in range(3)) <= 3 for p in strip), 'IMAGE_BACKGROUND_UNCERTAIN')
    mask = bytearray(w*h)
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            i = (y*w+x)*4
            if max(abs(rgba[i+c]-bg[c]) for c in range(3)) > 12:
                mask[y*w+x] = 1
                xs.append(x); ys.append(y)
    require(xs, 'IMAGE_EMPTY_OR_LOADING')
    left, top, right, bottom = min(xs), min(ys), max(xs)+1, max(ys)+1
    gap = max(2, round(2*dpi/96))
    require(left >= gap and top >= gap and w-right >= gap and h-bottom >= gap, 'IMAGE_CONTENT_TOUCHES_GUARD')
    cw, ch = right-left, bottom-top
    require(16 <= cw <= 512 and 16 <= ch <= 512, 'IMAGE_CONTENT_SIZE_UNSUPPORTED')
    require(sum(mask) >= cw*ch*.72, 'IMAGE_CONTENT_SPARSE_OR_MIXED')
    require(all(sum(mask[y*w+left:y*w+right]) >= cw*.3 for y in range(top, bottom)), 'IMAGE_DISCONNECTED_CONTENT')
    require(all(sum(mask[y*w+x] for y in range(top, bottom)) >= ch*.3 for x in range(left, right)), 'IMAGE_DISCONNECTED_CONTENT')
    crop = b''.join(rgba[(y*w+left)*4:(y*w+right)*4] for y in range(top, bottom))
    colors = {crop[i:i+3] for i in range(0, len(crop), 4)}
    require(len(colors) >= 16, 'IMAGE_EMPTY_OR_LOADING')
    values = [sum(crop[i:i+3])/3 for i in range(0, len(crop), 4)]
    mean = sum(values)/len(values)
    require(math.sqrt(sum((v-mean)**2 for v in values)/len(values)) >= 18, 'IMAGE_EMPTY_OR_LOADING')
    return {'bounds': {'x': frame_bounds['x']+left, 'y': frame_bounds['y']+top, 'width': cw, 'height': ch},
            'rgba': crop, 'sha256': hashlib.sha256(crop).hexdigest(),
            'boundaryMethod': 'pure-photo-row-tight-content/v1'}
