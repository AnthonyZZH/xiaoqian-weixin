"""Bounded container inspection, not pixel decoding. All source bytes stay untouched."""
from __future__ import annotations

import struct
import zlib
from dataclasses import asdict, dataclass

from .safety import InvalidMedia

MAX_BYTES = 20 * 1024 * 1024
MAX_DIMENSION = 16384
MAX_PIXELS = 100_000_000
MAX_FRAMES = 10000


@dataclass(frozen=True)
class MediaInfo:
    format: str
    extension: str
    width: int
    height: int
    animated: bool
    frame_count: int
    inspection: str = "container_only"

    def to_dict(self):
        return asdict(self)


def _require(ok, message="invalid image container"):
    if not ok:
        raise InvalidMedia(message)


def _dimensions(width, height):
    _require(0 < width <= MAX_DIMENSION and 0 < height <= MAX_DIMENSION
             and width * height <= MAX_PIXELS, "image dimensions exceed bounds")


def _legacy_footer(tail):
    """Observed legacy container suffix, not a checksum/authenticity assertion.

    Exactly 0x21 0xFE followed by 32 ASCII hex characters. This is accepted only
    AFTER a valid image end marker. The full original bytes (including this
    suffix) remain stored and hashed; nothing is repaired or re-encoded.
    """
    return (len(tail) == 34 and tail[:2] == b"!\xfe"
            and all(value in b"0123456789abcdefABCDEF" for value in tail[2:]))


def _gif(data):
    _require(len(data) >= 14)
    width, height = struct.unpack_from("<HH", data, 6)
    _dimensions(width, height)
    packed = data[10]
    pos = 13 + (3 * (2 ** ((packed & 7) + 1)) if packed & 0x80 else 0)
    frames = 0

    def subblocks(pos):
        while True:
            _require(pos < len(data), "truncated GIF subblocks")
            count = data[pos]
            pos += 1
            if count == 0:
                return pos
            _require(pos + count <= len(data), "truncated GIF data")
            pos += count

    while pos < len(data):
        marker = data[pos]
        pos += 1
        if marker == 0x3B:
            _require(frames > 0 and (pos == len(data) or _legacy_footer(data[pos:])), "invalid GIF trailer or unsupported trailing data")
            return MediaInfo("gif", ".gif", width, height, frames > 1, frames)
        if marker == 0x21:
            _require(pos < len(data))
            pos = subblocks(pos + 1)  # extension label followed by size-prefixed blocks
        elif marker == 0x2C:
            _require(pos + 9 <= len(data))
            left, top, fw, fh, flags = struct.unpack_from("<HHHHB", data, pos)
            _dimensions(fw, fh)
            _require(left + fw <= width and top + fh <= height, "GIF frame outside canvas")
            pos += 9 + (3 * (2 ** ((flags & 7) + 1)) if flags & 0x80 else 0)
            _require(pos < len(data) and 2 <= data[pos] <= 8, "invalid GIF LZW code size")
            pos = subblocks(pos + 1)
            frames += 1
            _require(frames <= MAX_FRAMES, "too many GIF frames")
        else:
            raise InvalidMedia("unexpected GIF block")
    raise InvalidMedia("missing GIF trailer")


def _png(data):
    pos, width, height, declared, frames, sequence = 8, 0, 0, None, 0, 0
    idat = False
    frame_data = None
    while pos < len(data):
        _require(pos + 12 <= len(data), "truncated PNG chunk")
        length = int.from_bytes(data[pos:pos + 4], "big")
        kind = data[pos + 4:pos + 8]
        end = pos + 12 + length
        _require(end <= len(data), "PNG chunk outside file")
        body = data[pos + 8:pos + 8 + length]
        checksum = int.from_bytes(data[end - 4:end], "big")
        _require(zlib.crc32(kind + body) & 0xFFFFFFFF == checksum, "PNG CRC mismatch")
        if pos == 8:
            _require(kind == b"IHDR" and length == 13, "missing PNG IHDR")
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", body)
            _dimensions(width, height)
            valid_depths = {0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}
            _require(depth in valid_depths.get(color, set()) and compression == filtering == 0
                     and interlace in (0, 1), "invalid PNG header")
        elif kind == b"IHDR":
            raise InvalidMedia("duplicate PNG IHDR")
        elif kind == b"acTL":
            _require(length == 8 and declared is None and not idat, "invalid APNG animation control")
            declared = int.from_bytes(body[:4], "big")
            _require(0 < declared <= MAX_FRAMES, "invalid APNG frame count")
        elif kind == b"fcTL":
            _require(declared is not None and length == 26, "invalid APNG frame control")
            _require(frame_data is not False, "APNG frame has no image data")
            frame_data = False
            seq, fw, fh, left, top, _, _, dispose, blend = struct.unpack(">IIIIIHHBB", body)
            _require(seq == sequence, "APNG sequence mismatch")
            sequence += 1
            _dimensions(fw, fh)
            _require(left + fw <= width and top + fh <= height and dispose <= 2 and blend <= 1,
                     "invalid APNG frame bounds")
            frames += 1
        elif kind == b"fdAT":
            _require(declared is not None and frames > 0 and length > 4 and idat, "invalid APNG frame data")
            _require(int.from_bytes(body[:4], "big") == sequence, "APNG sequence mismatch")
            sequence += 1
            frame_data = True
        elif kind == b"IDAT":
            _require(length > 0, "empty PNG image data")
            idat = True
            if frames:
                frame_data = True
        elif kind == b"IEND":
            _require(length == 0 and idat and end == len(data), "invalid PNG end")
            _require(declared is None or (frames == declared and frame_data is True), "APNG frame count/data mismatch")
            return MediaInfo("apng" if declared is not None else "png", ".png", width, height,
                             declared is not None and declared > 1, declared or 1)
        pos = end
    raise InvalidMedia("missing PNG IEND")


def _riff_chunks(data, start=12):
    pos = start
    while pos < len(data):
        _require(pos + 8 <= len(data), "truncated WebP chunk")
        kind, length = data[pos:pos + 4], int.from_bytes(data[pos + 4:pos + 8], "little")
        end = pos + 8 + length
        _require(end + (length & 1) <= len(data), "WebP chunk outside file")
        yield kind, data[pos + 8:end]
        pos = end + (length & 1)
    _require(pos == len(data))


def _webp_size(kind, body):
    if kind == b"VP8 ":
        _require(len(body) >= 10 and body[3:6] == b"\x9d\x01\x2a", "invalid WebP VP8 header")
        return int.from_bytes(body[6:8], "little") & 0x3FFF, int.from_bytes(body[8:10], "little") & 0x3FFF
    _require(kind == b"VP8L" and len(body) >= 5 and body[0] == 0x2F, "invalid WebP VP8L header")
    bits = int.from_bytes(body[1:5], "little")
    return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1


def _webp(data):
    _require(int.from_bytes(data[4:8], "little") + 8 == len(data), "WebP RIFF length mismatch")
    width = height = frames = 0
    anim_flag = anim_header = extended = image = False
    for kind, body in _riff_chunks(data):
        if kind == b"VP8X":
            _require(not extended and not image and not frames and len(body) == 10, "invalid WebP VP8X")
            extended, anim_flag = True, bool(body[0] & 2)
            width = int.from_bytes(body[4:7], "little") + 1
            height = int.from_bytes(body[7:10], "little") + 1
            _dimensions(width, height)
        elif kind == b"ANIM":
            _require(anim_flag and not anim_header and not frames and len(body) == 6, "invalid WebP ANIM")
            anim_header = True
        elif kind == b"ANMF":
            _require(anim_flag and anim_header and len(body) >= 24, "invalid WebP animation frame")
            left = 2 * int.from_bytes(body[0:3], "little")
            top = 2 * int.from_bytes(body[3:6], "little")
            fw = int.from_bytes(body[6:9], "little") + 1
            fh = int.from_bytes(body[9:12], "little") + 1
            _dimensions(fw, fh)
            _require(left + fw <= width and top + fh <= height, "WebP frame outside canvas")
            payloads = [(k, v) for k, v in _riff_chunks(body, 16) if k in (b"VP8 ", b"VP8L")]
            _require(len(payloads) == 1, "missing WebP frame bitstream")
            _require(_webp_size(*payloads[0]) == (fw, fh), "WebP frame size mismatch")
            frames += 1
            _require(frames <= MAX_FRAMES, "too many WebP frames")
        elif kind in (b"VP8 ", b"VP8L"):
            _require(not anim_flag and not image, "invalid WebP image placement")
            iw, ih = _webp_size(kind, body)
            _dimensions(iw, ih)
            if not extended:
                width, height = iw, ih
            _require((iw, ih) == (width, height), "WebP canvas mismatch")
            image = True
    _require((anim_flag and anim_header and frames > 0) or (not anim_flag and image), "incomplete WebP")
    return MediaInfo("webp", ".webp", width, height, frames > 1, frames if anim_flag else 1)


def _jpeg(data):
    # A local inspection view only: MediaLibrary stores/hashes the untouched input.
    # Do not search arbitrary APP/EXIF/entropy bytes for an EOI. An accepted footer
    # must follow the terminal EOI immediately; truly absent EOI still fails.
    if _legacy_footer(data[-34:]):
        data = data[:-34]
    _require(data.endswith(b"\xff\xd9"), "missing terminal JPEG EOI or unsupported trailing data")
    pos, width, height = 2, 0, 0
    while pos < len(data) - 2:
        _require(data[pos] == 0xFF, "invalid JPEG marker")
        while pos < len(data) and data[pos] == 0xFF:
            pos += 1
        _require(pos < len(data))
        marker = data[pos]
        pos += 1
        if marker == 0xDA:
            _require(pos + 2 <= len(data), "truncated JPEG scan header")
            scan_length = int.from_bytes(data[pos:pos + 2], "big")
            _require(scan_length >= 6 and pos + scan_length < len(data) - 2, "invalid JPEG scan header")
            _require(width > 0, "JPEG has no frame header")
            return MediaInfo("jpeg", ".jpg", width, height, False, 1)
        _require(marker not in (0, 0xD8, 0xD9) and not 0xD0 <= marker <= 0xD7, "invalid JPEG marker placement")
        _require(pos + 2 <= len(data))
        length = int.from_bytes(data[pos:pos + 2], "big")
        _require(length >= 2 and pos + length <= len(data), "truncated JPEG segment")
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            _require(length >= 8, "invalid JPEG frame header")
            height, width = struct.unpack_from(">HH", data, pos + 3)
            _dimensions(width, height)
        pos += length
    raise InvalidMedia("JPEG has no scan")


def inspect_bytes(data: bytes, max_bytes: int = MAX_BYTES) -> MediaInfo:
    if not isinstance(data, bytes):
        raise InvalidMedia("media must be immutable bytes")
    _require(0 < len(data) <= max_bytes <= MAX_BYTES, "media exceeds byte limit or is empty")
    if data.startswith((b"GIF87a", b"GIF89a")):
        return _gif(data)
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return _png(data)
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return _webp(data)
    if data.startswith(b"\xff\xd8"):
        return _jpeg(data)
    raise InvalidMedia("unsupported image signature (GIF, PNG/APNG, WebP, JPEG only)")
