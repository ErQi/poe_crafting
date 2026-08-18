from __future__ import annotations

import tkinter as tk
from collections.abc import Callable

import customtkinter as ctk  # type: ignore[import-untyped]

from ..matcher import format_threshold_text
from ..models import MatchMode, MatchResult, RunStatus, StopReason
from .fonts import ui_font


def _ignore_destroyed_widget(action: Callable[[], object]) -> None:
    try:
        action()
    except (tk.TclError, RuntimeError, OSError):
        return


def _monitor_work_area(anchor_point: tuple[int, int]) -> tuple[int, int, int, int]:
    """返回锚点所在显示器扣除任务栏后的工作区。"""
    import win32api  # type: ignore[import-untyped]
    import win32con  # type: ignore[import-untyped]

    monitor = win32api.MonitorFromPoint(
        anchor_point,
        win32con.MONITOR_DEFAULTTONEAREST,
    )
    left, top, right, bottom = win32api.GetMonitorInfo(monitor)["Work"]
    return int(left), int(top), int(right), int(bottom)


def format_match_overlay_line(attempt: int, match: MatchResult) -> str:
    """单行摘要：#次 满足x/y | 简短条件状态。"""
    hits = list(match.hits or [])
    # 忽略 disabled
    active = [h for h in hits if h.reason != "disabled"]
    total = len(active)
    ok_n = sum(1 for h in active if h.matched)
    outer = "OR" if match.mode == MatchMode.ANY.value else "AND"
    mark = "✓" if match.success else "·"
    # 条件短标签
    parts: list[str] = []
    for h in active[:6]:
        m = "✓" if h.matched else "✗"
        name = (h.rule.pattern or "?")[:10]
        thr = ""
        if h.rule.operator and (
            h.rule.threshold is not None or h.rule.threshold2 is not None
        ):
            t = format_threshold_text(h.rule.threshold, h.rule.threshold2)
            thr = f"{h.rule.operator}{t}"
        parts.append(f"{m}{name}{thr}")
    if total > 6:
        parts.append("…")
    detail = " ".join(parts) if parts else "(无条件)"
    return f"{mark} #{attempt} 满足{ok_n}/{total} [{outer}] {detail}"


def format_completion_overlay_lines(status: RunStatus, reason: str) -> list[str]:
    """结束后的短提示，避免抢焦点弹窗。"""
    mark = "✓" if status.stop_reason == StopReason.SUCCESS else "■"
    lines = [f"{mark} {reason}"]
    message = (status.message or "").strip()
    if message and message != reason:
        lines.append(message[:80])
    lines.append(f"尝试 {status.attempt} 次")
    if status.workflow_name:
        lines.append(status.workflow_name[:24])
    if status.workflow_step_name:
        name = status.workflow_step_name[:20]
        lines.append(f"步骤 {status.workflow_step_index}. {name}")
    return lines


class FloatingMatchOverlay:
    """屏幕右下角置顶浮动日志，每行淡入淡出。"""

    WIDTH = 420
    HEIGHT = 276
    MAX_LINES = 8
    HOLD_MS = 2800
    STEP_MS = 30
    PAD = 18
    COMPLETION_HOLD_MS = 5000
    BG = "#12141a"
    FG_OK = "#8fef9a"
    FG_FAIL = "#f0f0f0"
    FG_DIM = "#3a3f4b"
    BORDER = "#2a3140"

    def __init__(self, master: tk.Misc) -> None:
        self.master = master
        self._win: ctk.CTkToplevel | None = None
        self._host: ctk.CTkFrame | None = None
        self._lines: list[dict] = []
        self._pool: list[dict] = []
        self._last_attempt_shown = -1
        self._visible = False
        self._closing = False
        self._placed = False
        self._work_area: tuple[int, int, int, int] | None = None
        self._auto_hide_id: str | None = None
        self._line_font: ctk.CTkFont | None = None

    def reset_run(self) -> None:
        self._last_attempt_shown = -1

    def show(self, anchor_point: tuple[int, int]) -> None:
        try:
            self._cancel_auto_hide()
            self._work_area = _monitor_work_area(anchor_point)
            self._show_window()
        except (tk.TclError, RuntimeError, OSError):
            return

    def _show_window(self) -> None:
        if self._win is not None and self._win.winfo_exists():
            win = self._win
            if not self._placed:
                self._place()
            _ignore_destroyed_widget(win.deiconify)
            _ignore_destroyed_widget(lambda: win.attributes("-topmost", True))
            self._visible = True
            return
        self._create()
        self._visible = True

    def hide(self) -> None:
        self._cancel_auto_hide()
        self._visible = False
        self._clear_lines()
        self._placed = False
        if self._win is not None and self._win.winfo_exists():
            _ignore_destroyed_widget(self._win.withdraw)

    def destroy(self) -> None:
        self._closing = True
        self._visible = False
        self._cancel_auto_hide()
        self._clear_lines()
        for item in self._pool:
            _ignore_destroyed_widget(item["frame"].destroy)
        self._pool.clear()
        if self._win is not None:
            _ignore_destroyed_widget(self._win.destroy)
            self._win = None
            self._host = None
            self._placed = False
            self._line_font = None

    def push_status(self, status: RunStatus) -> None:
        """根据运行状态推送一行（同 attempt 不重复）。"""
        try:
            if not status.running:
                self.hide()
                return

            self._ensure_shown()
            # 读失败时 last_match 仍是上一次结果，不要当成这一次的 0 命中。
            if status.last_match is None or status.parse_failures:
                return
            if status.attempt == self._last_attempt_shown:
                return
            self._last_attempt_shown = status.attempt
            line = format_match_overlay_line(status.attempt, status.last_match)
            if status.workflow_step_name:
                name = status.workflow_step_name[:14]
                line = f"[{status.workflow_step_index}. {name}] {line}"
            self.add_line(line, success=bool(status.last_match.success), persist=True)
        except (tk.TclError, RuntimeError, OSError):
            return

    def show_completion(self, lines: list[str], success: bool = False) -> None:
        """结束提示：不抢焦点，5 秒后自动消失。"""
        try:
            self._cancel_auto_hide()
            self._ensure_work_area()
            self._show_window()
            self._clear_lines()
            for text in reversed(lines):
                self.add_line(text, success=success, persist=True)
            if self._win is not None and self._win.winfo_exists():
                self._auto_hide_id = self._win.after(self.COMPLETION_HOLD_MS, self.hide)
        except (tk.TclError, RuntimeError, OSError):
            return

    def add_line(self, text: str, success: bool = False, persist: bool = False) -> None:
        try:
            self._ensure_shown()
        except (tk.TclError, RuntimeError, OSError):
            return
        if self._host is None or self._win is None:
            return

        while len(self._lines) >= self.MAX_LINES:
            self._recycle_item(self._lines.pop())

        fg_target = self.FG_OK if success else self.FG_FAIL
        item = self._acquire_line(text, fg_target)
        if item is None:
            return
        self._lines.insert(0, item)
        if not persist:
            self._schedule(item, self.HOLD_MS, lambda: self._recycle_item(item))

    def _top_frame(self):
        if not self._lines:
            return None
        return self._lines[0].get("frame")

    def _pack_line_frame(self, frame) -> None:
        top = self._top_frame()
        if top is None:
            frame.pack(fill="x", pady=2, anchor="e")
        else:
            frame.pack(fill="x", pady=2, anchor="e", before=top)

    def _ensure_work_area(self) -> None:
        if self._work_area is not None:
            return
        try:
            anchor = (int(self.master.winfo_rootx()), int(self.master.winfo_rooty()))
        except (tk.TclError, AttributeError, ValueError, TypeError):
            anchor = (0, 0)
        self._work_area = _monitor_work_area(anchor)

    def _ensure_shown(self) -> None:
        if not self._visible or self._win is None or not self._win.winfo_exists():
            self._ensure_work_area()
            if self._work_area is None:
                raise RuntimeError("日志浮窗尚未设置目标显示器")
            self._show_window()

    def _clear_lines(self) -> None:
        for item in list(self._lines):
            self._recycle_item(item)
        self._lines.clear()

    def _line_font_cached(self) -> ctk.CTkFont:
        if self._line_font is None:
            self._line_font = ui_font()
        return self._line_font

    def _acquire_line(self, text: str, fg: str) -> dict | None:
        if self._host is None:
            return None
        if self._pool:
            item = self._pool.pop()
            try:
                item["label"].configure(text=text, text_color=fg)
                self._pack_line_frame(item["frame"])
            except (tk.TclError, RuntimeError, AttributeError):
                _ignore_destroyed_widget(item["frame"].destroy)
                item = None
            if item is not None:
                item["alive"] = True
                item["after_ids"] = []
                return item
        frame = ctk.CTkFrame(self._host, fg_color="transparent")
        self._pack_line_frame(frame)
        label = ctk.CTkLabel(
            frame,
            text=text,
            anchor="e",
            justify="right",
            font=self._line_font_cached(),
            text_color=fg,
            wraplength=self.WIDTH - 28,
        )
        label.pack(fill="x", padx=4)
        return {
            "frame": frame,
            "label": label,
            "after_ids": [],
            "alive": True,
        }

    def _recycle_item(self, item: dict) -> None:
        self._cancel_item(item)
        try:
            if item in self._lines:
                self._lines.remove(item)
        except ValueError:
            pass
        _ignore_destroyed_widget(item["frame"].pack_forget)
        if len(self._pool) < self.MAX_LINES:
            self._pool.append(item)
        else:
            _ignore_destroyed_widget(item["frame"].destroy)

    def _cancel_auto_hide(self) -> None:
        win = self._win
        hide_id = self._auto_hide_id
        if win is not None and hide_id is not None:
            _ignore_destroyed_widget(lambda: win.after_cancel(hide_id))
        self._auto_hide_id = None

    def _create(self) -> None:
        win = ctk.CTkToplevel(self.master)
        win.withdraw()
        win.title("匹配浮动日志")
        win.overrideredirect(True)
        win.attributes("-topmost", True)
        # 首帧先透明布局，避免按 Toplevel 初始尺寸定位后再次跳动。
        win.attributes("-alpha", 0.0)
        # 不抢焦点；Wm 才满足 transient 的类型重载
        owner = self.master
        if isinstance(owner, (tk.Wm, tk.Tk, tk.Toplevel)):
            _ignore_destroyed_widget(lambda: win.transient(owner))

        outer = ctk.CTkFrame(
            win,
            fg_color=self.BG,
            border_width=1,
            border_color=self.BORDER,
            corner_radius=10,
        )
        outer.pack(fill="both", expand=True)
        head = ctk.CTkLabel(
            outer,
            text="匹配进度",
            anchor="e",
            font=ui_font(11),
            text_color="#7a8494",
        )
        head.pack(fill="x", padx=10, pady=(6, 0))
        host = ctk.CTkFrame(outer, fg_color="transparent")
        host.pack(fill="both", expand=True, padx=8, pady=(2, 8))

        self._win = win
        self._host = host
        win.geometry(f"{self.WIDTH}x{self.HEIGHT}")
        win.deiconify()
        win.update_idletasks()
        self._place()
        win.attributes("-alpha", 0.92)
        # 避免启动时抢焦点
        _ignore_destroyed_widget(
            lambda: win.after(10, lambda: win.attributes("-topmost", True))
        )
        self._apply_no_activate(win)

        # 跟随主窗口关闭
        _ignore_destroyed_widget(
            lambda: self.master.bind("<Destroy>", self._on_master_destroy, add="+")
        )

    def _apply_no_activate(self, win) -> None:
        """Windows：尽量不抢键盘焦点。"""
        try:
            import ctypes

            hwnd = int(win.winfo_id())
            # CTk 可能套一层，尝试 GetParent
            user32 = ctypes.windll.user32
            GWL_EXSTYLE = -20
            WS_EX_NOACTIVATE = 0x08000000
            WS_EX_TOOLWINDOW = 0x00000080
            WS_EX_TOPMOST = 0x00000008
            # 找到顶级 hwnd
            root = hwnd
            while True:
                parent = user32.GetParent(root)
                if not parent:
                    break
                root = parent
            style = user32.GetWindowLongW(root, GWL_EXSTYLE)
            user32.SetWindowLongW(
                root,
                GWL_EXSTYLE,
                style | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
            )
        except (AttributeError, OSError, tk.TclError, ValueError, TypeError):
            return

    def _on_master_destroy(self, event) -> None:
        if event.widget is self.master:
            self.destroy()

    def _place(self) -> None:
        if self._win is None:
            return
        if self._work_area is None:
            raise RuntimeError("日志浮窗尚未设置目标显示器")
        # 固定视口高度，避免日志新增或淡出删除时窗口反复伸缩。
        self._win.geometry(f"{self.WIDTH}x{self.HEIGHT}")
        self._win.update_idletasks()

        _, _, right, bottom = self._work_area
        window_width = self._win.winfo_width()
        window_height = self._win.winfo_height()
        x = right - window_width - self.PAD
        y = bottom - window_height - self.PAD
        self._win.geometry(f"+{x}+{y}")
        self._placed = True

    def _cancel_item(self, item: dict) -> None:
        item["alive"] = False
        win = self._win
        if win is not None:
            for aid in item.get("after_ids") or []:

                def cancel_aid(current=aid, target=win) -> None:
                    target.after_cancel(current)

                _ignore_destroyed_widget(cancel_aid)
        item["after_ids"] = []

    def _schedule(self, item: dict, ms: int, fn) -> None:
        if self._win is None or not item.get("alive"):
            return

        def wrapper() -> None:
            if not item.get("alive") or self._closing:
                return
            fn()

        aid = self._win.after(ms, wrapper)
        item["after_ids"].append(aid)
