from __future__ import annotations

import time
import tkinter as tk
from typing import Optional

import customtkinter as ctk

from ..models import MatchMode, MatchResult, RunStatus


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
        if h.rule.operator and h.rule.threshold is not None:
            t = h.rule.threshold
            thr = f"{h.rule.operator}{int(t) if float(t).is_integer() else t}"
        parts.append(f"{m}{name}{thr}")
    if total > 6:
        parts.append("…")
    detail = " ".join(parts) if parts else "(无条件)"
    return f"{mark} #{attempt} 满足{ok_n}/{total} [{outer}] {detail}"


def _lerp_color(c1: str, c2: str, t: float) -> str:
    """#rrggbb 线性插值。"""
    t = max(0.0, min(1.0, t))

    def parse(c: str) -> tuple[int, int, int]:
        c = c.lstrip("#")
        return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)

    r1, g1, b1 = parse(c1)
    r2, g2, b2 = parse(c2)
    r = int(r1 + (r2 - r1) * t)
    g = int(g1 + (g2 - g1) * t)
    b = int(b1 + (b2 - b1) * t)
    return f"#{r:02x}{g:02x}{b:02x}"


class FloatingMatchOverlay:
    """屏幕右下角置顶浮动日志，每行淡入淡出。"""

    WIDTH = 420
    MAX_LINES = 8
    FADE_IN_MS = 220
    HOLD_MS = 2800
    FADE_OUT_MS = 450
    STEP_MS = 30
    PAD = 18
    BG = "#12141a"
    FG_OK = "#8fef9a"
    FG_FAIL = "#f0f0f0"
    FG_DIM = "#3a3f4b"
    BORDER = "#2a3140"

    def __init__(self, master: tk.Misc) -> None:
        self.master = master
        self._win: Optional[ctk.CTkToplevel] = None
        self._host: Optional[ctk.CTkFrame] = None
        self._lines: list[dict] = []
        self._last_attempt_shown = -1
        self._visible = False
        self._closing = False

    def show(self) -> None:
        if self._win is not None and self._win.winfo_exists():
            self._place()
            try:
                self._win.deiconify()
                self._win.attributes("-topmost", True)
            except Exception:
                pass
            self._visible = True
            return
        self._create()
        self._visible = True

    def hide(self) -> None:
        self._visible = False
        if self._win is not None and self._win.winfo_exists():
            try:
                self._win.withdraw()
            except Exception:
                pass

    def destroy(self) -> None:
        self._closing = True
        self._visible = False
        for item in list(self._lines):
            self._cancel_item(item)
        self._lines.clear()
        if self._win is not None:
            try:
                self._win.destroy()
            except Exception:
                pass
            self._win = None
            self._host = None

    def push_status(self, status: RunStatus) -> None:
        """根据运行状态推送一行（同 attempt 不重复）。"""
        if not status.running:
            # 结束时补最后一行（若有）
            if status.last_match is not None and status.attempt != self._last_attempt_shown:
                self._ensure_shown()
                line = format_match_overlay_line(status.attempt, status.last_match)
                if status.stop_reason and status.stop_reason.value == "success":
                    line = "★ 完成 " + line
                elif status.message:
                    line = f"■ {status.message} | " + line
                self.add_line(line, success=bool(status.last_match.success))
                self._last_attempt_shown = status.attempt
            return

        self._ensure_shown()
        if status.last_match is None:
            return
        if status.attempt == self._last_attempt_shown:
            return
        self._last_attempt_shown = status.attempt
        line = format_match_overlay_line(status.attempt, status.last_match)
        self.add_line(line, success=bool(status.last_match.success))

    def add_line(self, text: str, success: bool = False) -> None:
        self._ensure_shown()
        if self._host is None or self._win is None:
            return

        # 超限先移除最旧
        while len(self._lines) >= self.MAX_LINES:
            old = self._lines.pop(0)
            self._cancel_item(old)
            try:
                old["frame"].destroy()
            except Exception:
                pass

        fg_target = self.FG_OK if success else self.FG_FAIL
        frame = ctk.CTkFrame(self._host, fg_color="transparent")
        frame.pack(fill="x", pady=2, anchor="e")
        label = ctk.CTkLabel(
            frame,
            text=text,
            anchor="e",
            justify="right",
            font=ctk.CTkFont(family="Microsoft YaHei UI", size=13),
            text_color=self.FG_DIM,
            wraplength=self.WIDTH - 28,
        )
        label.pack(fill="x", padx=4)

        item = {
            "frame": frame,
            "label": label,
            "fg_target": fg_target,
            "born": time.monotonic(),
            "phase": "in",  # in | hold | out
            "after_ids": [],
            "alive": True,
        }
        self._lines.append(item)
        self._animate_fade_in(item)
        self._place()

    def _ensure_shown(self) -> None:
        if not self._visible or self._win is None or not self._win.winfo_exists():
            self.show()

    def _create(self) -> None:
        win = ctk.CTkToplevel(self.master)
        win.withdraw()
        win.title("匹配浮动日志")
        win.overrideredirect(True)
        win.attributes("-topmost", True)
        try:
            # Windows：轻微透明
            win.attributes("-alpha", 0.92)
        except Exception:
            pass
        # 不抢焦点
        try:
            win.transient(self.master)
        except Exception:
            pass

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
            font=ctk.CTkFont(size=11),
            text_color="#7a8494",
        )
        head.pack(fill="x", padx=10, pady=(6, 0))
        host = ctk.CTkFrame(outer, fg_color="transparent")
        host.pack(fill="both", expand=True, padx=8, pady=(2, 8))

        self._win = win
        self._host = host
        self._place()
        win.deiconify()
        # 避免启动时抢焦点
        try:
            win.after(10, lambda: win.attributes("-topmost", True))
            win.lower()  # 先不抢
            win.lift()
        except Exception:
            pass

        # 跟随主窗口关闭
        try:
            self.master.bind("<Destroy>", self._on_master_destroy, add="+")
        except Exception:
            pass

    def _on_master_destroy(self, event) -> None:
        if event.widget is self.master:
            self.destroy()

    def _place(self) -> None:
        if self._win is None:
            return
        try:
            sw = self._win.winfo_screenwidth()
            sh = self._win.winfo_screenheight()
        except Exception:
            sw, sh = 1920, 1080
        # 高度随行数略变
        h = 36 + max(1, len(self._lines)) * 28 + 16
        h = max(90, min(h, 320))
        x = sw - self.WIDTH - self.PAD
        y = sh - h - self.PAD - 48  # 预留任务栏
        try:
            self._win.geometry(f"{self.WIDTH}x{h}+{x}+{y}")
        except Exception:
            pass

    def _cancel_item(self, item: dict) -> None:
        item["alive"] = False
        for aid in item.get("after_ids") or []:
            try:
                if self._win is not None:
                    self._win.after_cancel(aid)
            except Exception:
                pass
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

    def _animate_fade_in(self, item: dict) -> None:
        steps = max(1, self.FADE_IN_MS // self.STEP_MS)
        state = {"i": 0}

        def tick() -> None:
            if not item.get("alive"):
                return
            state["i"] += 1
            t = state["i"] / steps
            color = _lerp_color(self.FG_DIM, item["fg_target"], t)
            try:
                item["label"].configure(text_color=color)
            except Exception:
                return
            if state["i"] < steps:
                self._schedule(item, self.STEP_MS, tick)
            else:
                item["phase"] = "hold"
                self._schedule(item, self.HOLD_MS, lambda: self._animate_fade_out(item))

        tick()

    def _animate_fade_out(self, item: dict) -> None:
        if not item.get("alive"):
            return
        item["phase"] = "out"
        steps = max(1, self.FADE_OUT_MS // self.STEP_MS)
        state = {"i": 0}
        start = item["fg_target"]

        def tick() -> None:
            if not item.get("alive"):
                return
            state["i"] += 1
            t = state["i"] / steps
            color = _lerp_color(start, self.FG_DIM, t)
            try:
                item["label"].configure(text_color=color)
            except Exception:
                self._remove_item(item)
                return
            if state["i"] < steps:
                self._schedule(item, self.STEP_MS, tick)
            else:
                self._remove_item(item)

        tick()

    def _remove_item(self, item: dict) -> None:
        self._cancel_item(item)
        try:
            if item in self._lines:
                self._lines.remove(item)
        except ValueError:
            pass
        try:
            item["frame"].destroy()
        except Exception:
            pass
        self._place()
