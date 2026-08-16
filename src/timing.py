from __future__ import annotations

import time
from typing import Callable, Optional


def wait_until(
    pred: Callable[[], bool],
    timeout_ms: int,
    poll_ms: int = 4,
    should_stop: Optional[Callable[[], bool]] = None,
) -> bool:
    """条件成立立刻返回 True；超时或停止返回 False。"""
    deadline = time.monotonic() + max(0, timeout_ms) / 1000.0
    interval = max(0.001, poll_ms / 1000.0)
    while True:
        if should_stop and should_stop():
            return False
        if pred():
            return True
        remain = deadline - time.monotonic()
        if remain <= 0:
            return False
        time.sleep(min(interval, remain))
