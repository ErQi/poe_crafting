from __future__ import annotations

import time
from typing import Optional

import pyperclip


def get_clipboard() -> str:
    try:
        return pyperclip.paste() or ""
    except Exception:
        return ""


def set_clipboard(text: str) -> None:
    try:
        pyperclip.copy(text if text is not None else "")
    except Exception:
        pass


def clear_clipboard() -> None:
    set_clipboard("")


def wait_clipboard_change(
    previous: str,
    timeout_ms: int = 1500,
    poll_ms: int = 50,
    reject_empty: bool = True,
) -> Optional[str]:
    """等待剪贴板内容相对 previous 发生变化，超时返回 None。"""
    deadline = time.monotonic() + timeout_ms / 1000.0
    while time.monotonic() < deadline:
        current = get_clipboard()
        if current != previous:
            if reject_empty and not current.strip():
                time.sleep(poll_ms / 1000.0)
                continue
            return current
        time.sleep(poll_ms / 1000.0)
    return None
