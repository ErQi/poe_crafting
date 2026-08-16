from __future__ import annotations

import sys
import time
from typing import Optional

try:
    import pyperclip
except ImportError:
    pyperclip = None  # type: ignore[assignment]

_IS_WIN = sys.platform == "win32"

if _IS_WIN:
    import ctypes
    from ctypes import wintypes

    _user32 = ctypes.windll.user32
    _kernel32 = ctypes.windll.kernel32
    _CF_UNICODETEXT = 13
    _GMEM_MOVEABLE = 0x0002

    _user32.OpenClipboard.argtypes = [wintypes.HWND]
    _user32.OpenClipboard.restype = wintypes.BOOL
    _user32.CloseClipboard.argtypes = []
    _user32.CloseClipboard.restype = wintypes.BOOL
    _user32.EmptyClipboard.argtypes = []
    _user32.EmptyClipboard.restype = wintypes.BOOL
    _user32.GetClipboardData.argtypes = [wintypes.UINT]
    _user32.GetClipboardData.restype = wintypes.HANDLE
    _user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    _user32.SetClipboardData.restype = wintypes.HANDLE
    _kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    _kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    _kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    _kernel32.GlobalLock.restype = wintypes.LPVOID
    _kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    _kernel32.GlobalUnlock.restype = wintypes.BOOL
    _kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]
    _kernel32.GlobalFree.restype = wintypes.HGLOBAL


def get_clipboard() -> str:
    """读取剪贴板。占用中立刻返回空串，不在 OpenClipboard 上重试几百毫秒。"""
    if _IS_WIN:
        if not _user32.OpenClipboard(None):
            return ""
        try:
            handle = _user32.GetClipboardData(_CF_UNICODETEXT)
            if not handle:
                return ""
            ptr = _kernel32.GlobalLock(handle)
            if not ptr:
                return ""
            try:
                return ctypes.wstring_at(ptr)
            finally:
                _kernel32.GlobalUnlock(handle)
        except Exception:
            return ""
        finally:
            _user32.CloseClipboard()
    if pyperclip is None:
        return ""
    try:
        return pyperclip.paste() or ""
    except Exception:
        return ""


def set_clipboard(text: str) -> bool:
    """写入剪贴板。占用中立刻失败，由调用方短间隔重试。"""
    payload = text if text is not None else ""
    if _IS_WIN:
        encoded = payload.encode("utf-16-le") + b"\x00\x00"
        if not _user32.OpenClipboard(None):
            return False
        handle = None
        try:
            _user32.EmptyClipboard()
            handle = _kernel32.GlobalAlloc(_GMEM_MOVEABLE, len(encoded))
            if not handle:
                return False
            locked = _kernel32.GlobalLock(handle)
            if not locked:
                _kernel32.GlobalFree(handle)
                return False
            ctypes.memmove(locked, encoded, len(encoded))
            _kernel32.GlobalUnlock(handle)
            if not _user32.SetClipboardData(_CF_UNICODETEXT, handle):
                _kernel32.GlobalFree(handle)
                return False
            handle = None
            return True
        except Exception:
            if handle:
                _kernel32.GlobalFree(handle)
            return False
        finally:
            _user32.CloseClipboard()
    if pyperclip is None:
        return False
    try:
        pyperclip.copy(payload)
        return True
    except Exception:
        return False


def clear_clipboard() -> None:
    for _ in range(6):
        if set_clipboard(""):
            return
        time.sleep(0.002)


def normalize_clipboard_text(text: str) -> str:
    return (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()


def wait_clipboard_change(
    previous: str,
    timeout_ms: int = 1500,
    poll_ms: int = 2,
    reject_empty: bool = True,
    reject_texts: tuple[str, ...] = (),
) -> Optional[str]:
    """密轮询剪贴板，有有效文本立刻返回；占用中不当成超时。"""
    prev = normalize_clipboard_text(previous)
    rejected = {
        key for text in reject_texts if (key := normalize_clipboard_text(text))
    }
    deadline = time.monotonic() + timeout_ms / 1000.0
    interval = max(0.001, poll_ms / 1000.0)
    while time.monotonic() < deadline:
        current = get_clipboard()
        key = normalize_clipboard_text(current)
        if key != prev and key not in rejected and not (reject_empty and not key):
            return current
        remain = deadline - time.monotonic()
        if remain <= 0:
            break
        time.sleep(min(interval, remain))
    return None
