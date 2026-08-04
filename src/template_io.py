from __future__ import annotations

import io
from pathlib import Path
from typing import Optional, Union

from PIL import Image, ImageGrab

try:
    import win32clipboard
    import win32con
except ImportError:
    win32clipboard = None  # type: ignore
    win32con = None  # type: ignore


class ClipboardImageError(RuntimeError):
    pass


def _from_win32_dib() -> Optional[Image.Image]:
    if win32clipboard is None:
        return None
    try:
        win32clipboard.OpenClipboard()
        try:
            if win32clipboard.IsClipboardFormatAvailable(win32con.CF_DIB):
                data = win32clipboard.GetClipboardData(win32con.CF_DIB)
                if not data:
                    return None
                # CF_DIB = BITMAPINFOHEADER + pixels，补 BMP 文件头
                header = (
                    b"BM"
                    + (len(data) + 14).to_bytes(4, "little")
                    + b"\x00\x00\x00\x00"
                    + (14 + 40).to_bytes(4, "little")
                )
                return Image.open(io.BytesIO(header + data)).convert("RGBA")
            if win32clipboard.IsClipboardFormatAvailable(win32con.CF_HDROP):
                files = win32clipboard.GetClipboardData(win32con.CF_HDROP)
                if files:
                    path = Path(files[0])
                    if path.suffix.lower() in {
                        ".png",
                        ".jpg",
                        ".jpeg",
                        ".bmp",
                        ".webp",
                        ".gif",
                    }:
                        return Image.open(path).convert("RGBA")
        finally:
            win32clipboard.CloseClipboard()
    except Exception:
        try:
            win32clipboard.CloseClipboard()
        except Exception:
            pass
    return None


def get_clipboard_image() -> Image.Image:
    """
    从剪贴板读取图片。
    支持：截图工具复制的位图、资源管理器复制的图片文件路径。
    """
    grabbed: Union[Image.Image, list, str, None]
    try:
        grabbed = ImageGrab.grabclipboard()
    except Exception:
        grabbed = None

    img: Optional[Image.Image] = None
    if isinstance(grabbed, Image.Image):
        img = grabbed.convert("RGBA")
    elif isinstance(grabbed, list) and grabbed:
        # 文件路径列表
        path = Path(str(grabbed[0]))
        if path.exists() and path.suffix.lower() in {
            ".png",
            ".jpg",
            ".jpeg",
            ".bmp",
            ".webp",
            ".gif",
        }:
            img = Image.open(path).convert("RGBA")
    elif isinstance(grabbed, str) and grabbed:
        path = Path(grabbed)
        if path.exists():
            img = Image.open(path).convert("RGBA")

    if img is None:
        img = _from_win32_dib()

    if img is None:
        raise ClipboardImageError(
            "剪贴板中没有图片。请先用 Win+Shift+S / 截图工具截取并复制，或复制一张图片文件。"
        )
    return img


def save_template_image(image: Image.Image, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    # 统一存 PNG，模板匹配更稳
    out = image.convert("RGBA") if image.mode not in ("RGB", "RGBA") else image
    if out.mode == "RGBA":
        # 若几乎不透明可转 RGB 减小体积，否则保留
        alpha = out.getchannel("A")
        if alpha.getextrema() == (255, 255):
            out = out.convert("RGB")
    out.save(path, format="PNG")
    return path


def load_template_image(path: Path) -> Optional[Image.Image]:
    if not path.exists():
        return None
    try:
        return Image.open(path).convert("RGBA")
    except Exception:
        return None


def thumbnail_fit(image: Image.Image, max_w: int, max_h: int) -> Image.Image:
    img = image.copy()
    img.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
    return img
