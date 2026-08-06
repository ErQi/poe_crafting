from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.gui.overlay import FloatingMatchOverlay  # noqa: E402
from src.models import RunStatus, StopReason  # noqa: E402


class _ScaledWindow:
    def __init__(self, scale: float = 1.0) -> None:
        self.scale = scale
        self.width = 1
        self.height = 1
        self.geometry_calls: list[str] = []

    def geometry(self, value: str) -> None:
        self.geometry_calls.append(value)
        size = value.split("+", maxsplit=1)[0]
        if "x" not in size:
            return
        width, height = size.split("x")
        self.width = round(int(width) * self.scale)
        self.height = round(int(height) * self.scale)

    def update_idletasks(self) -> None:
        return

    def winfo_width(self) -> int:
        return self.width

    def winfo_height(self) -> int:
        return self.height

    def winfo_screenwidth(self) -> int:
        return 1920

    def winfo_screenheight(self) -> int:
        return 1080


class TestFloatingMatchOverlay(unittest.TestCase):
    def test_stopped_status_hides_overlay(self) -> None:
        overlay = FloatingMatchOverlay(object())
        overlay.hide = Mock()  # type: ignore[method-assign]

        overlay.push_status(
            RunStatus(
                running=False,
                stop_reason=StopReason.USER_STOP,
                message="用户停止",
            )
        )

        overlay.hide.assert_called_once_with()

    def test_places_scaled_window_at_target_work_area_bottom_right(self) -> None:
        overlay = FloatingMatchOverlay(object())
        window = _ScaledWindow(scale=1.5)
        overlay._win = window  # type: ignore[assignment]
        overlay._work_area = (1920, 0, 3840, 1040)  # noqa: SLF001

        overlay._place()  # noqa: SLF001

        expected_x = 3840 - round(overlay.WIDTH * window.scale) - overlay.PAD
        expected_y = 1040 - round(overlay.HEIGHT * window.scale) - overlay.PAD
        self.assertEqual(window.geometry_calls[-1], f"+{expected_x}+{expected_y}")

    def test_height_stays_fixed_when_log_count_changes(self) -> None:
        overlay = FloatingMatchOverlay(object())
        window = _ScaledWindow()
        overlay._win = window  # type: ignore[assignment]
        overlay._work_area = (0, 0, 1920, 1040)  # noqa: SLF001

        overlay._lines = [{}]  # noqa: SLF001
        overlay._place()  # noqa: SLF001
        one_line_size = window.geometry_calls[-2]

        overlay._lines = [{}] * overlay.MAX_LINES  # noqa: SLF001
        overlay._place()  # noqa: SLF001
        full_size = window.geometry_calls[-2]

        self.assertEqual(one_line_size, full_size)


if __name__ == "__main__":
    unittest.main()
