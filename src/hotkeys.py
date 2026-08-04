from __future__ import annotations

import threading
from typing import Callable, Optional

from pynput import keyboard


class HotkeyService:
    """全局热键监听，默认 F8 触发 stop_callback。"""

    def __init__(self, key_name: str = "f8") -> None:
        self.key_name = (key_name or "f8").lower()
        self._listener: Optional[keyboard.Listener] = None
        self._callback: Optional[Callable[[], None]] = None
        self._lock = threading.Lock()

    def _resolve_key(self):
        name = self.key_name.lower()
        # f1-f12
        if name.startswith("f") and name[1:].isdigit():
            return getattr(keyboard.Key, name, keyboard.Key.f8)
        special = {
            "esc": keyboard.Key.esc,
            "escape": keyboard.Key.esc,
            "pause": keyboard.Key.pause,
        }
        if name in special:
            return special[name]
        if len(name) == 1:
            return keyboard.KeyCode.from_char(name)
        return keyboard.Key.f8

    def start(self, callback: Callable[[], None]) -> None:
        self.stop()
        self._callback = callback
        target = self._resolve_key()

        def on_press(key) -> None:
            try:
                if key == target:
                    cb = self._callback
                    if cb:
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
            self._callback = None

    def set_key(self, key_name: str) -> None:
        self.key_name = (key_name or "f8").lower()
