from __future__ import annotations

import threading
from typing import Callable, Optional

from pynput import keyboard


class HotkeyService:
    """全局热键监听，支持多键绑定（如 F7 开始、F8 停止）。"""

    def __init__(self) -> None:
        self._listener: Optional[keyboard.Listener] = None
        self._bindings: dict[object, Callable[[], None]] = {}
        self._lock = threading.Lock()

    def _resolve_key(self, key_name: str):
        name = (key_name or "").strip().lower()
        if not name:
            return None
        # f1-f12
        if name.startswith("f") and name[1:].isdigit():
            return getattr(keyboard.Key, name, None)
        special = {
            "esc": keyboard.Key.esc,
            "escape": keyboard.Key.esc,
            "pause": keyboard.Key.pause,
        }
        if name in special:
            return special[name]
        if len(name) == 1:
            return keyboard.KeyCode.from_char(name)
        return None

    def start(self, bindings: dict[str, Callable[[], None]]) -> None:
        self.stop()
        resolved: dict[object, Callable[[], None]] = {}
        for name, callback in bindings.items():
            key = self._resolve_key(name)
            if key is None or key in resolved:
                continue
            resolved[key] = callback
        self._bindings = resolved

        def on_press(key) -> None:
            cb = self._bindings.get(key)
            if cb is None:
                return
            try:
                cb()
            except Exception:
                pass

        self._listener = keyboard.Listener(on_press=on_press)
        self._listener.daemon = True
        self._listener.start()

    def stop(self) -> None:
        with self._lock:
            if self._listener is not None:
                try:
                    self._listener.stop()
                except Exception:
                    pass
                self._listener = None
            self._bindings = {}
