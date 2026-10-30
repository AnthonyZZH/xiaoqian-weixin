# Pure image helpers extracted from existing stickers.py; no settings, data store or model imports.
from PIL import Image, ImageChops, ImageOps, ImageStat

def trim(image: Image.Image, tolerance=18) -> Image.Image:
    """Cut away the chat background around a sticker bubble."""
    rgb = image.convert("RGB")
    background = Image.new("RGB", rgb.size, rgb.getpixel((2, rgb.height // 2)))
    diff = ImageOps.grayscale(ImageChops.difference(rgb, background)).point(lambda v: 255 if v > tolerance else 0)
    box = diff.getbbox()
    return rgb.crop(box) if box else rgb

def looks_unloaded(image: Image.Image) -> bool:
    """WeChat's loading / failed placeholder: a small or nearly flat grey box."""
    if image.width < 24 or image.height < 24:
        return True
    gray = ImageOps.grayscale(image)
    return ImageStat.Stat(gray).stddev[0] < 18
