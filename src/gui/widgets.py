from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator, Optional

import customtkinter as ctk
import tkinter as tk
from PIL import Image
from tkinter import messagebox, simpledialog

from ..config_store import resolve_path
from ..matcher import format_threshold_text, normalize_operator, parse_threshold_text
from ..models import (
    MatchMode,
    MatchRule,
    RuleGroup,
    RuleSet,
)
from ..template_io import (
    ClipboardImageError,
    get_clipboard_image,
    load_template_image,
    save_template_image,
    thumbnail_fit,
)
from .fonts import tk_ui_font, ui_font
from . import theme

OPS = ["", ">=", ">", "<=", "<", "="]


@contextmanager
def hide_while_rebuild(widget) -> Iterator[None]:
    """重建列表时可暂藏子控件。绝不 grid_remove 主窗口或滚动框。"""
    try:
        toplevel = widget.winfo_toplevel()
        info = dict(widget.grid_info())
    except tk.TclError:
        yield
        return
    if (
        not info
        or widget is toplevel
        or widget.__class__.__name__ in {"CTkScrollableFrame", "VScroll"}
    ):
        yield
        return
    try:
        widget.grid_remove()
        yield
    finally:
        opts = {k: v for k, v in info.items() if k != "in"}
        try:
            widget.grid(**opts)
        except tk.TclError:
            try:
                widget.grid()
            except tk.TclError:
                pass


class CompactMenu(tk.Frame):
    """与 padded_entry 同高同边的紧凑下拉，替代窄条 CTkOptionMenu / ttk.Combobox。"""

    def __init__(self, master, values=(), command=None, **kwargs):
        super().__init__(
            master,
            bg=theme.INPUT,
            highlightbackground=theme.BORDER,
            highlightcolor=theme.BORDER_LIT,
            highlightthickness=1,
            height=theme.CONTROL_H,
        )
        self.pack_propagate(False)
        self._values = [str(v) for v in values]
        self._command = command
        self._value = self._values[0] if self._values else ""
        self._label = tk.Label(
            self,
            text=self._value,
            bg=theme.INPUT,
            fg=theme.TEXT,
            font=tk_ui_font(12),
            anchor="w",
        )
        self._arrow = tk.Label(
            self,
            text="▾",
            bg=theme.INPUT,
            fg=theme.MUTED,
            font=tk_ui_font(13),
            width=2,
        )
        self._arrow.pack(side="right", fill="y", padx=(2, 6))
        self._label.pack(side="left", fill="both", expand=True, padx=(8, 4))
        for widget in (self, self._label, self._arrow):
            widget.bind("<Button-1>", self._open)
            widget.bind("<Enter>", lambda _e: self._glow(True))
            widget.bind("<Leave>", lambda _e: self._glow(False))

    def _glow(self, on: bool) -> None:
        super().configure(highlightbackground=theme.BORDER_LIT if on else theme.BORDER)

    def _open(self, _event=None) -> str:
        menu = tk.Menu(
            self,
            tearoff=0,
            bg=theme.RAISED,
            fg=theme.TEXT,
            activebackground=theme.ACCENT,
            activeforeground="#ffffff",
            font=tk_ui_font(12),
            relief="flat",
            bd=1,
        )
        for value in self._values:
            menu.add_command(label=value or " ", command=lambda v=value: self._pick(v))
        try:
            menu.tk_popup(self.winfo_rootx(), self.winfo_rooty() + self.winfo_height())
        finally:
            menu.grab_release()
        return "break"

    def _pick(self, value: str) -> None:
        self.set(value)
        if self._command:
            self._command(value)

    def set(self, value: str) -> None:
        self._value = "" if value is None else str(value)
        self._label.configure(text=self._value)

    def get(self) -> str:
        return self._value

    def configure(self, cnf=None, **kwargs):
        if isinstance(cnf, dict):
            kwargs = {**cnf, **kwargs}
        elif cnf:
            return super().configure(cnf)
        values = kwargs.pop("values", None)
        command = kwargs.pop("command", None)
        if values is not None:
            self._values = [str(v) for v in values]
        if command is not None:
            self._command = command
        if kwargs:
            super().configure(**kwargs)

    config = configure


class WrapFlow(ctk.CTkFrame):
    """按容器宽度换行；子控件自带宽高，reflow 只改坐标。"""

    def __init__(self, master, gap: int = 6, **kwargs):
        kwargs.setdefault("fg_color", "transparent")
        super().__init__(master, **kwargs)
        self._gap = gap
        self._items: list[tuple] = []
        self._last_w = 0
        self._after = None
        self._busy = False
        self.configure(height=theme.CHIP_H)
        self.grid_propagate(False)
        self.bind("<Configure>", self._on_cfg)

    def add(self, widget, width: int, height: int | None = None) -> None:
        h = height or theme.CHIP_H
        widget.configure(width=width, height=h)
        self._items.append((widget, width, h))

    def reflow(self) -> None:
        self._last_w = 0
        self._reflow(self.winfo_width())

    def _on_cfg(self, _event=None) -> None:
        if self._busy:
            return
        if self._after is not None:
            self.after_cancel(self._after)
        self._after = self.after(40, self._reflow_now)

    def _reflow_now(self) -> None:
        self._after = None
        self._reflow(self.winfo_width())

    def _item_size(self, widget, req_w: int, req_h: int) -> tuple[int, int]:
        try:
            w, h = widget.cget("width"), widget.cget("height")
            return int(w or req_w), int(h or req_h)
        except (tk.TclError, TypeError, ValueError):
            return req_w, req_h

    def _reflow(self, width: int) -> None:
        if width < 8:
            return
        if self._last_w and abs(width - self._last_w) < 2:
            return
        self._last_w = width
        x = y = row_h = 0
        gap = self._gap
        for widget, req_w, req_h in self._items:
            req_w, req_h = self._item_size(widget, req_w, req_h)
            if x and x + req_w > width:
                x = 0
                y += row_h + gap
                row_h = 0
            widget.place(x=x, y=y)
            x += req_w + gap
            row_h = max(row_h, req_h)
        self._set_h(y + row_h if self._items else 1)

    def _set_h(self, height: int) -> None:
        self._busy = True
        try:
            self.configure(height=max(int(height), 1))
        finally:
            self._busy = False


class VScroll(ctk.CTkFrame):
    """内部垂直滚动。max_height 有值则高度随内容封顶，否则填满父级。"""

    def __init__(
        self,
        master,
        max_height: int | None = None,
        canvas_bg: str | None = None,
        **kwargs,
    ):
        kwargs.setdefault("fg_color", "transparent")
        super().__init__(master, **kwargs)
        self._max_h = max_height
        self._busy = False
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(0, weight=1)
        if max_height is None:
            self.grid_propagate(False)
        bg = canvas_bg or theme.PAGE
        self._canvas = tk.Canvas(self, highlightthickness=0, bd=0, bg=bg)
        if max_height is not None:
            self._canvas.configure(height=1)
        self._vsb = ctk.CTkScrollbar(
            self, orientation="vertical", command=self._canvas.yview, width=12
        )
        self._canvas.configure(yscrollcommand=self._vsb.set)
        self._canvas.grid(row=0, column=0, sticky="nsew")
        self.inner = ctk.CTkFrame(self._canvas, fg_color="transparent")
        self._win = self._canvas.create_window((0, 0), window=self.inner, anchor="nw")
        self.inner.bind("<Configure>", self._on_inner)
        self._canvas.bind("<Configure>", self._on_canvas)
        self.bind_wheel(self._canvas)
        self.bind_wheel(self.inner)

    def bind_wheel(self, widget) -> None:
        widget.bind("<MouseWheel>", self._on_wheel)

    def bind_wheel_tree(self, widget) -> None:
        self.bind_wheel(widget)
        for child in widget.winfo_children():
            self.bind_wheel_tree(child)

    def sync(self) -> None:
        self._sync()

    def _on_wheel(self, event) -> str:
        self._canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")
        return "break"

    def _on_inner(self, _event=None) -> None:
        if not self._busy:
            self._sync()

    def _on_canvas(self, event) -> None:
        if not self._busy and event.widget is self._canvas:
            self._sync()

    def _sync(self) -> None:
        if self._busy:
            return
        self._busy = True
        try:
            cw = max(self._canvas.winfo_width(), 1)
            ch = max(self._canvas.winfo_height(), 1)
            self.inner.update_idletasks()
            req_h = max(self.inner.winfo_reqheight(), 1)
            if self._max_h is not None:
                view_h = min(req_h, self._max_h)
                if int(self._canvas.cget("height") or 0) != view_h:
                    self._canvas.configure(height=view_h)
                self._canvas.itemconfigure(self._win, width=cw)
                self._canvas.configure(scrollregion=(0, 0, cw, req_h))
                self._toggle_bar(req_h > self._max_h + 1)
            else:
                h = max(ch, req_h)
                self._canvas.itemconfigure(self._win, width=cw, height=h)
                self._canvas.configure(scrollregion=(0, 0, cw, h))
                self._toggle_bar(req_h > ch + 1)
        finally:
            self._busy = False

    def _toggle_bar(self, need: bool) -> None:
        if need:
            self._vsb.grid(row=0, column=1, sticky="ns")
        else:
            self._vsb.grid_remove()


class HScroll(ctk.CTkFrame):
    """单行横向滚动。高度随芯片，超出用滚轮或右侧 ›。"""

    def __init__(self, master, canvas_bg: str | None = None, **kwargs):
        kwargs.setdefault("fg_color", "transparent")
        super().__init__(master, **kwargs)
        self._busy = False
        bg = canvas_bg or theme.CARD
        h = theme.CHIP_H + 4
        self.grid_columnconfigure(0, weight=1)
        self._canvas = tk.Canvas(self, highlightthickness=0, bd=0, bg=bg, height=h)
        self._canvas.grid(row=0, column=0, sticky="ew")
        self._more = tk.Label(
            self, text="›", bg=bg, fg=theme.MUTED, font=tk_ui_font(16), cursor="hand2"
        )
        self._more.bind("<Button-1>", lambda _e: self._canvas.xview_scroll(3, "units"))
        self.inner = ctk.CTkFrame(self._canvas, fg_color="transparent")
        self._win = self._canvas.create_window((0, 0), window=self.inner, anchor="nw")
        self.inner.bind("<Configure>", self._on_inner)
        self._canvas.bind("<Configure>", self._on_canvas)
        self.bind_wheel(self._canvas)
        self.bind_wheel(self.inner)

    def bind_wheel(self, widget) -> None:
        widget.bind("<MouseWheel>", self._on_wheel)

    def bind_wheel_tree(self, widget) -> None:
        self.bind_wheel(widget)
        for child in widget.winfo_children():
            self.bind_wheel_tree(child)

    def sync(self) -> None:
        self._sync()

    def _on_wheel(self, event) -> str:
        self._canvas.xview_scroll(int(-1 * (event.delta / 120)), "units")
        return "break"

    def _on_inner(self, _event=None) -> None:
        if not self._busy:
            self._sync()

    def _on_canvas(self, event) -> None:
        if not self._busy and event.widget is self._canvas:
            self._sync()

    def _sync(self) -> None:
        if self._busy:
            return
        self._busy = True
        try:
            self.inner.update_idletasks()
            req_w = max(self.inner.winfo_reqwidth(), 1)
            req_h = max(self.inner.winfo_reqheight(), theme.CHIP_H)
            cw = max(self._canvas.winfo_width(), 1)
            self._canvas.itemconfigure(self._win, height=req_h)
            self._canvas.configure(scrollregion=(0, 0, req_w, req_h))
            if req_w > cw + 2:
                self._more.grid(row=0, column=1, padx=(4, 0))
            else:
                self._more.grid_remove()
        finally:
            self._busy = False


class RuleTable(ctk.CTkFrame):
    """表头与行同一套 grid 列；窄窗可横向滚。"""

    def __init__(self, master, **kwargs):
        kwargs.setdefault("fg_color", theme.CARD)
        kwargs.setdefault("corner_radius", 6)
        super().__init__(master, **kwargs)
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(0, weight=1)

        self._canvas = tk.Canvas(self, highlightthickness=0, bd=0, bg=theme.CARD)
        self._vsb = ctk.CTkScrollbar(
            self, orientation="vertical", command=self._canvas.yview, width=12
        )
        self._hsb = ctk.CTkScrollbar(
            self, orientation="horizontal", command=self._canvas.xview, height=12
        )
        self._canvas.configure(
            yscrollcommand=self._vsb.set, xscrollcommand=self._hsb.set
        )
        self._canvas.grid(row=0, column=0, sticky="nsew")
        self._vsb.grid(row=0, column=1, sticky="ns")

        self.inner = tk.Frame(self._canvas, bg=theme.CARD)
        theme.apply_rule_cols(self.inner)
        self._win = self._canvas.create_window((0, 0), window=self.inner, anchor="nw")
        self._inner_w = 0
        self.inner.bind("<Configure>", self._on_inner)
        self._canvas.bind("<Configure>", self._on_canvas)
        self._bind_wheel(self._canvas)
        self._bind_wheel(self.inner)

    def reset(self) -> None:
        for child in self.inner.winfo_children():
            child.destroy()
        theme.apply_rule_cols(self.inner)
        for i, text in enumerate(("启用", "包含文本", "算子", "阈值", "备注")):
            cell = tk.Frame(self.inner, bg=theme.HEADER)
            cell.grid(
                row=0, column=i, sticky="nsew", padx=theme.RULE_PADS[i], pady=(4, 6)
            )
            tk.Label(
                cell,
                text=text,
                bg=theme.HEADER,
                fg=theme.MUTED,
                font=tk_ui_font(12),
                anchor="center" if i == 0 else "w",
            ).pack(fill="both", expand=True, padx=2, pady=7)
            self._bind_wheel(cell)

    def cell(self, row: int, col: int, bg: str) -> tk.Frame:
        box = tk.Frame(self.inner, bg=bg)
        box.grid(
            row=row, column=col, sticky="nsew", padx=theme.RULE_PADS[col], pady=(0, 5)
        )
        self._bind_wheel(box)
        return box

    def empty(self, text: str) -> None:
        tk.Label(
            self.inner,
            text=text,
            fg=theme.MUTED,
            bg=theme.CARD,
            justify="center",
            font=tk_ui_font(12),
        ).grid(row=1, column=0, columnspan=5, sticky="ew", pady=24)

    def _on_inner(self, _event=None) -> None:
        self._canvas.configure(scrollregion=self._canvas.bbox("all"))
        self._sync_hscroll()

    def _on_canvas(self, event) -> None:
        inner_w = max(event.width, theme.RULE_MIN_W)
        if inner_w != self._inner_w:
            self._inner_w = inner_w
            self._canvas.itemconfigure(self._win, width=inner_w)
        self._sync_hscroll()

    def _sync_hscroll(self) -> None:
        bbox = self._canvas.bbox("all")
        canvas_w = self._canvas.winfo_width()
        need_x = bool(bbox and bbox[2] > canvas_w + 2)
        if need_x:
            self._hsb.grid(row=1, column=0, sticky="ew")
        else:
            self._hsb.grid_remove()

    def _bind_wheel(self, widget) -> None:
        widget.bind("<MouseWheel>", self._on_wheel)

    def _on_wheel(self, event) -> str:
        steps = int(-1 * (event.delta / 120))
        if event.state & 0x1:
            self._canvas.xview_scroll(steps, "units")
        else:
            self._canvas.yview_scroll(steps, "units")
        return "break"

TEMPLATE_SLOT_DEFS: list[tuple[str, str, bool]] = [
    ("craft_button", "执行工艺按钮", True),
    ("item_slot", "目标装备位置（工艺槽/背包）", True),
]


def _mode_label(mode: str) -> str:
    return "OR (任一)" if mode == MatchMode.ANY.value else "AND (全部)"


def _mode_from_label(label: str) -> str:
    if "OR" in label or "任一" in label:
        return MatchMode.ANY.value
    return MatchMode.ALL.value


class RuleSetEditor(ctk.CTkFrame):
    """多组规则编辑：组间 AND/OR + 组内 AND/OR。"""

    def __init__(
        self,
        master,
        on_change: Optional[Callable[[RuleSet], None]] = None,
        **kwargs,
    ) -> None:
        kwargs.setdefault("fg_color", "transparent")
        super().__init__(master, **kwargs)
        self.on_change = on_change
        self._ruleset = RuleSet(groups=[RuleGroup(name="规则组 1")])
        self._selected_group = 0
        self._selected_rule: Optional[int] = None
        self._rule_rows: list[dict] = []
        self._group_chips: list[ctk.CTkButton] = []
        self._tools_wide: bool | None = None

        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(1, weight=1)

        top = ctk.CTkFrame(self, fg_color="transparent")
        top.grid(row=0, column=0, sticky="ew", padx=2, pady=(2, 4))
        ctk.CTkLabel(top, text="组间", font=ui_font(12), text_color=theme.MUTED).pack(
            side="left"
        )
        self.group_combine_menu = CompactMenu(
            top,
            values=["AND (全部)", "OR (任一)"],
            command=self._on_group_combine,
        )
        self.group_combine_menu.configure(width=118)
        self.group_combine_menu.pack(side="left", padx=8)
        self.group_combine_menu.set("AND (全部)")
        gbtns = ctk.CTkFrame(top, fg_color="transparent")
        gbtns.pack(side="right")
        ctk.CTkButton(gbtns, text="加组", width=52, height=28, command=self._add_group).pack(
            side="left", padx=(0, 4)
        )
        ctk.CTkButton(
            gbtns, text="删组", width=52, height=28, command=self._del_group, **theme.BTN_DANGER
        ).pack(side="left", padx=(0, 4))
        ctk.CTkButton(
            gbtns, text="改名", width=52, height=28, command=self._rename_group, **theme.BTN_MUTED
        ).pack(side="left")
        self.group_chip_scroll = HScroll(top)
        self.group_chip_scroll.pack(side="left", fill="x", expand=True, padx=8)
        self.chip_host = self.group_chip_scroll.inner

        body = theme.surface(self)
        body.grid(row=1, column=0, sticky="nsew", padx=2, pady=2)
        body.grid_columnconfigure(0, weight=1)
        body.grid_rowconfigure(1, weight=1)

        tools = ctk.CTkFrame(body, fg_color="transparent")
        tools.grid(row=0, column=0, sticky="ew", padx=8, pady=(8, 4))
        self._tools = tools
        self.group_enabled = tk.BooleanVar(value=True)
        self._en_box = ctk.CTkCheckBox(
            tools,
            text="启用本组",
            variable=self.group_enabled,
            command=self._on_group_enabled,
            font=ui_font(12),
        )
        self._inner_lbl = ctk.CTkLabel(
            tools, text="组内", font=ui_font(12), text_color=theme.MUTED
        )
        self.inner_combine_menu = CompactMenu(
            tools,
            values=["AND (全部)", "OR (任一)"],
            command=self._on_inner_combine,
        )
        self.inner_combine_menu.configure(width=118)
        self.inner_combine_menu.set("AND (全部)")
        self._min_lbl = ctk.CTkLabel(
            tools, text="至少匹配", font=ui_font(12), text_color=theme.MUTED
        )
        self.min_matches_entry = ctk.CTkEntry(tools, width=44, placeholder_text="空")
        self.min_matches_entry.bind(
            "<FocusOut>", lambda _e: self._on_min_matches_change()
        )
        self._min_unit = ctk.CTkLabel(
            tools, text="条", font=ui_font(12), text_color=theme.MUTED
        )
        self._layout_tools(wide=True)
        tools.bind("<Configure>", self._on_tools_cfg)

        self.table = RuleTable(body)
        self.table.grid(row=1, column=0, sticky="nsew", padx=8, pady=2)

        rule_ops = ctk.CTkFrame(body, fg_color="transparent")
        rule_ops.grid(row=2, column=0, sticky="ew", padx=8, pady=(6, 2))
        ctk.CTkButton(
            rule_ops,
            text="+ 添加条件",
            width=100,
            height=30,
            command=self.add_rule,
            **theme.BTN_OK,
        ).pack(side="left", padx=(0, 6))
        ctk.CTkButton(
            rule_ops,
            text="删除选中",
            width=88,
            height=30,
            command=self.delete_selected,
            **theme.BTN_DANGER,
        ).pack(side="left")

        tip = theme.muted(
            body,
            "数字=本组命中 N 条即可。文本可用空格/逗号写多关键字。",
            wraplength=400,
        )
        tip.grid(row=3, column=0, sticky="ew", padx=8, pady=(0, 8))
        theme.bind_wrap(tip, body, pad=24)
        self._refresh_group_tabs()

    # ---- public ----
    def set_ruleset(self, ruleset: RuleSet) -> None:
        self._ruleset = RuleSet.from_dict(ruleset.to_dict())
        if not self._ruleset.groups:
            self._ruleset.groups = [RuleGroup(name="规则组 1")]
        self._selected_group = 0
        self._selected_rule = None
        self._refresh_group_tabs()
        self._load_current_group_to_ui()

    def get_ruleset(self) -> RuleSet:
        self._sync_current_group_from_ui()
        return RuleSet.from_dict(self._ruleset.to_dict())

    # 兼容旧 RulesTable API
    def set_rules(self, rules: list[MatchRule]) -> None:
        self.set_ruleset(
            RuleSet(
                group_combine=MatchMode.ALL.value,
                groups=[
                    RuleGroup(
                        name="规则组 1", combine=MatchMode.ALL.value, rules=list(rules)
                    )
                ],
            )
        )

    def get_rules(self) -> list[MatchRule]:
        rs = self.get_ruleset()
        return rs.all_rules_flat()

    def add_rule(self) -> None:
        self._sync_current_group_from_ui()
        g = self._current_group()
        g.rules.append(MatchRule(pattern="", enabled=True))
        self._rebuild_rules()
        self._emit()

    def delete_selected(self) -> None:
        self._sync_current_group_from_ui()
        g = self._current_group()
        if not g.rules:
            return
        if self._selected_rule is not None and 0 <= self._selected_rule < len(g.rules):
            g.rules.pop(self._selected_rule)
        else:
            g.rules.pop()
        self._selected_rule = None
        self._rebuild_rules()
        self._emit()

    # ---- internal ----
    def _current_group(self) -> RuleGroup:
        if not self._ruleset.groups:
            self._ruleset.groups = [RuleGroup(name="规则组 1")]
        if self._selected_group >= len(self._ruleset.groups):
            self._selected_group = 0
        return self._ruleset.groups[self._selected_group]

    def _emit(self) -> None:
        if self.on_change:
            self.on_change(self.get_ruleset())

    def _refresh_group_tabs(self) -> None:
        labels = []
        for i, g in enumerate(self._ruleset.groups):
            mark = "" if g.enabled else "∅"
            if g.min_matches:
                logic = f"≥{g.min_matches}"
            else:
                logic = "∨" if g.combine == MatchMode.ANY.value else "∧"
            labels.append(f"{mark}{g.name}[{logic}]"[:18])
        if not labels:
            labels = ["规则组 1"]
        for child in self.chip_host.winfo_children():
            child.destroy()
        self._group_chips.clear()
        for i, label in enumerate(labels):
            button = theme.make_chip(
                self.chip_host,
                label,
                command=lambda idx=i: self._on_select_group_index(idx),
                selected=i == self._selected_group,
            )
            button.pack(side="left", padx=(0, 6), pady=2)
            self._group_chips.append(button)
        self.group_combine_menu.set(_mode_label(self._ruleset.group_combine))
        self.after_idle(self.group_chip_scroll.bind_wheel_tree, self.chip_host)
        self.after_idle(self.group_chip_scroll.sync)

    def _on_select_group_index(self, idx: int) -> None:
        if idx == self._selected_group:
            return
        self._sync_current_group_from_ui()
        self._selected_group = idx
        self._selected_rule = None
        self._load_current_group_to_ui()
        for i, button in enumerate(self._group_chips):
            theme.style_chip(button, i == idx)

    def _on_tools_cfg(self, event) -> None:
        if event.widget is not self._tools:
            return
        self._layout_tools(wide=event.width >= 560)

    def _layout_tools(self, wide: bool) -> None:
        if wide == self._tools_wide:
            return
        self._tools_wide = wide
        for widget in (
            self._en_box,
            self._inner_lbl,
            self.inner_combine_menu,
            self._min_lbl,
            self.min_matches_entry,
            self._min_unit,
        ):
            widget.grid_forget()
        tools = self._tools
        if wide:
            tools.grid_columnconfigure(2, weight=0)
            self._en_box.grid(row=0, column=0, sticky="w", padx=(0, 10))
            self._inner_lbl.grid(row=0, column=1, sticky="w", padx=(0, 6))
            self.inner_combine_menu.grid(row=0, column=2, sticky="w", padx=(0, 12))
            self._min_lbl.grid(row=0, column=3, sticky="w", padx=(0, 6))
            self.min_matches_entry.grid(row=0, column=4, sticky="w")
            self._min_unit.grid(row=0, column=5, sticky="w", padx=(4, 0))
        else:
            self._en_box.grid(row=0, column=0, sticky="w")
            self._inner_lbl.grid(row=0, column=1, sticky="w", padx=(8, 6))
            self.inner_combine_menu.grid(row=0, column=2, sticky="w")
            self._min_lbl.grid(row=1, column=0, sticky="w", pady=(6, 0))
            self.min_matches_entry.grid(row=1, column=1, sticky="w", pady=(6, 0))
            self._min_unit.grid(row=1, column=2, sticky="w", padx=(4, 0), pady=(6, 0))

    def _load_current_group_to_ui(self) -> None:
        g = self._current_group()
        self.group_enabled.set(g.enabled)
        self.inner_combine_menu.set(_mode_label(g.combine))
        self.min_matches_entry.delete(0, "end")
        if g.min_matches:
            self.min_matches_entry.insert(0, str(g.min_matches))
        self._rebuild_rules()

    def _sync_current_group_from_ui(self) -> None:
        if not self._ruleset.groups:
            return
        g = self._current_group()
        g.enabled = bool(self.group_enabled.get())
        g.combine = _mode_from_label(self.inner_combine_menu.get())
        raw_min = self.min_matches_entry.get().strip()
        if raw_min == "":
            g.min_matches = None
        else:
            try:
                n = int(raw_min)
                g.min_matches = n if n >= 1 else None
            except ValueError:
                g.min_matches = None
        # rules from widgets
        updated: list[MatchRule] = []
        for i, row in enumerate(self._rule_rows):
            if i >= len(g.rules):
                break
            rule = g.rules[i]
            rule.enabled = bool(row["enabled"].get())
            rule.pattern = row["pattern"].get().strip()
            op = row["op"].get()
            rule.operator = normalize_operator("" if op in ("(无)", "无", None) else op)
            rule.threshold, rule.threshold2 = parse_threshold_text(
                row["threshold"].get()
            )
            rule.note = row["note"].get().strip()
            updated.append(rule)
        if len(updated) == len(g.rules):
            g.rules = updated
        self._ruleset.group_combine = _mode_from_label(self.group_combine_menu.get())

    def _on_group_combine(self, value: str) -> None:
        self._ruleset.group_combine = _mode_from_label(value)
        self._emit()

    def _on_inner_combine(self, value: str) -> None:
        g = self._current_group()
        g.combine = _mode_from_label(value)
        self._refresh_group_tabs()
        self._emit()

    def _on_min_matches_change(self) -> None:
        self._sync_current_group_from_ui()
        self._refresh_group_tabs()
        self._emit()

    def _on_group_enabled(self) -> None:
        g = self._current_group()
        g.enabled = bool(self.group_enabled.get())
        self._refresh_group_tabs()
        self._emit()

    def _add_group(self) -> None:
        self._sync_current_group_from_ui()
        n = len(self._ruleset.groups) + 1
        self._ruleset.groups.append(
            RuleGroup(name=f"规则组 {n}", combine=MatchMode.ALL.value)
        )
        self._selected_group = len(self._ruleset.groups) - 1
        self._refresh_group_tabs()
        self._load_current_group_to_ui()
        self._emit()

    def _del_group(self) -> None:
        self._sync_current_group_from_ui()
        if len(self._ruleset.groups) <= 1:
            messagebox.showinfo("删组", "至少保留一个规则组")
            return
        self._ruleset.groups.pop(self._selected_group)
        self._selected_group = max(0, self._selected_group - 1)
        self._refresh_group_tabs()
        self._load_current_group_to_ui()
        self._emit()

    def _rename_group(self) -> None:
        g = self._current_group()
        name = simpledialog.askstring(
            "改名", "规则组名称:", initialvalue=g.name, parent=self
        )
        if name is None:
            return
        name = name.strip() or g.name
        g.name = name
        self._refresh_group_tabs()
        self._emit()

    def _paint_row(self, row: dict, selected: bool) -> None:
        bg = theme.ROW_SEL if selected else theme.ROW
        for widget in row.get("bg", []):
            try:
                widget.configure(bg=bg)
                if isinstance(widget, tk.Checkbutton):
                    widget.configure(activebackground=bg, selectcolor=theme.INPUT)
            except tk.TclError:
                pass

    def _select_rule(self, idx: int) -> None:
        self._selected_rule = idx
        for i, row in enumerate(self._rule_rows):
            self._paint_row(row, i == idx)

    def _rebuild_rules(self) -> None:
        with hide_while_rebuild(self.table):
            self.table.reset()
            self._rule_rows.clear()
            g = self._current_group()
            if not g.rules:
                self.table.empty("本组还没有词缀条件\n点击下方「+ 添加条件」")
            else:
                self._fill_rule_rows(g)

        self.after_idle(self.table._on_inner)

    def _fill_rule_rows(self, g: RuleGroup) -> None:
        op_values = ["(无)"] + [o for o in OPS if o]
        for idx, rule in enumerate(g.rules):
            r = idx + 1
            selected = idx == self._selected_rule
            bg = theme.ROW_SEL if selected else theme.ROW
            cells = [self.table.cell(r, col, bg) for col in range(5)]
            for cell in cells:
                cell.bind("<Button-1>", lambda _e, i=idx: self._select_rule(i))

            en_var = tk.BooleanVar(value=rule.enabled)
            check = tk.Checkbutton(
                cells[0],
                text="",
                variable=en_var,
                command=self._emit,
                bg=bg,
                activebackground=bg,
                selectcolor=theme.INPUT,
                fg=theme.TEXT,
                activeforeground=theme.TEXT,
                highlightthickness=0,
                bd=0,
                width=1,
            )
            check.pack(anchor="center", pady=8)
            self.table._bind_wheel(check)

            pat_box, pattern = theme.padded_entry(cells[1], rule.pattern)
            pat_box.pack(fill="x", expand=True, padx=0, pady=5)
            pattern.bind("<FocusOut>", lambda _e: self._emit())
            pattern.bind("<Button-1>", lambda _e, i=idx: self._select_rule(i))

            op_menu = CompactMenu(
                cells[2], values=op_values, command=lambda _v: self._emit()
            )
            cur_op = rule.operator if rule.operator in OPS and rule.operator else "(无)"
            op_menu.set(cur_op)
            op_menu.pack(fill="x", expand=True, pady=5)

            formatted = format_threshold_text(rule.threshold, rule.threshold2)
            thr_box, thr = theme.padded_entry(cells[3], formatted)
            thr_box.pack(fill="x", expand=True, pady=5)
            thr.bind("<FocusOut>", lambda _e: self._emit())

            note_box, note = theme.padded_entry(cells[4], rule.note)
            note_box.pack(fill="x", expand=True, pady=5)
            note.bind("<FocusOut>", lambda _e: self._emit())

            self._rule_rows.append(
                {
                    "enabled": en_var,
                    "pattern": pattern,
                    "op": op_menu,
                    "threshold": thr,
                    "note": note,
                    "bg": [*cells, check],
                }
            )


# 兼容旧名称
RulesTable = RuleSetEditor


class TemplatePastePanel(ctk.CTkFrame):
    """模板配置：Ctrl+V / 粘贴按钮把剪贴板图片存为模板。"""

    PREVIEW_MAX = (280, 150)
    SLOT_THUMB = (72, 48)

    def __init__(
        self,
        master,
        templates_dir: str | Path,
        on_log: Optional[Callable[[str], None]] = None,
        on_saved: Optional[Callable[[str, Path], None]] = None,
        autoload_slots: bool = True,
        **kwargs,
    ) -> None:
        super().__init__(master, **kwargs)
        self.templates_dir = resolve_path(templates_dir)
        self.on_log = on_log or (lambda _m: None)
        self.on_saved = on_saved
        self._pending: Optional[Image.Image] = None
        self._pending_ctk: Optional[ctk.CTkImage] = None
        self._slot_images: dict[str, ctk.CTkImage] = {}
        self._selected_key = "craft_button"
        self._slot_cards: dict[str, ctk.CTkFrame] = {}
        self._slots_ready = False

        self.grid_columnconfigure(0, weight=2)
        self.grid_columnconfigure(1, weight=3)
        self.grid_rowconfigure(1, weight=1)

        self._build()
        if autoload_slots:
            self.ensure_slots()

    def set_templates_dir(self, templates_dir: str | Path) -> None:
        self.templates_dir = resolve_path(templates_dir)
        self.refresh_slots()

    def ensure_slots(self) -> None:
        if self._slots_ready:
            return
        self.refresh_slots()

    def bind_paste_shortcuts(self, widget) -> None:
        widget.bind_all("<Control-v>", self._on_global_paste, add="+")
        widget.bind_all("<Control-V>", self._on_global_paste, add="+")

    def _build(self) -> None:
        head = ctk.CTkFrame(self, fg_color="transparent")
        head.grid(row=0, column=0, columnspan=2, sticky="ew", padx=12, pady=(12, 6))
        ctk.CTkLabel(
            head,
            text="模板配置",
            font=ui_font(16, "bold"),
        ).pack(side="left")
        ctk.CTkLabel(
            head,
            text="Win+Shift+S 截图 → Ctrl+V 粘贴 → 保存",
            text_color="gray",
        ).pack(side="left", padx=12)

        # 左：粘贴区
        left = ctk.CTkFrame(self)
        left.grid(row=1, column=0, sticky="nsew", padx=(12, 6), pady=(0, 12))
        left.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(
            left, text="剪贴板预览", anchor="w", font=ui_font(13, "bold")
        ).grid(row=0, column=0, sticky="ew", padx=12, pady=(12, 6))

        self.pending_label = ctk.CTkLabel(
            left,
            text="截图后按 Ctrl+V\n或点下方「从剪贴板粘贴」",
            width=self.PREVIEW_MAX[0],
            height=self.PREVIEW_MAX[1],
            fg_color=("gray85", "gray22"),
            corner_radius=8,
            justify="center",
        )
        self.pending_label.grid(row=1, column=0, sticky="ew", padx=12, pady=4)

        self.pending_info = ctk.CTkLabel(
            left, text="未粘贴", text_color="gray", anchor="w"
        )
        self.pending_info.grid(row=2, column=0, sticky="ew", padx=12, pady=(2, 8))

        ctk.CTkLabel(left, text="保存为", anchor="w").grid(
            row=3, column=0, sticky="ew", padx=12, pady=(4, 2)
        )
        labels = [f"{title}  ({k}.png)" for k, title, _req in TEMPLATE_SLOT_DEFS]
        self._label_to_key = {
            f"{title}  ({k}.png)": k for k, title, _req in TEMPLATE_SLOT_DEFS
        }
        self.target_menu = ctk.CTkOptionMenu(
            left, values=labels, command=self._on_target_change, dynamic_resizing=False
        )
        self.target_menu.grid(row=4, column=0, sticky="ew", padx=12, pady=2)
        self.target_menu.set(labels[0])

        btn_row = ctk.CTkFrame(left, fg_color="transparent")
        btn_row.grid(row=5, column=0, sticky="ew", padx=12, pady=12)
        btn_row.grid_columnconfigure(0, weight=1)
        btn_row.grid_columnconfigure(1, weight=1)
        ctk.CTkButton(
            btn_row, text="从剪贴板粘贴", command=self.paste_from_clipboard
        ).grid(row=0, column=0, sticky="ew", padx=(0, 6))
        ctk.CTkButton(
            btn_row,
            text="保存到模板",
            fg_color="#2d6a4f",
            hover_color="#1b4332",
            command=self.save_pending,
        ).grid(row=0, column=1, sticky="ew", padx=(6, 0))

        tip = ctk.CTkLabel(
            left,
            text="输入框内 Ctrl+V 仍粘贴文字。\n保存会覆盖同名 png。\n单击右侧卡片可选中保存目标。",
            text_color="gray",
            font=ui_font(12),
            anchor="w",
            justify="left",
        )
        tip.grid(row=6, column=0, sticky="ew", padx=12, pady=(0, 12))

        # 右：已保存列表
        right = ctk.CTkFrame(self)
        right.grid(row=1, column=1, sticky="nsew", padx=(6, 12), pady=(0, 12))
        right.grid_rowconfigure(1, weight=1)
        right.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(
            right, text="已保存模板", anchor="w", font=ui_font(13, "bold")
        ).grid(row=0, column=0, sticky="ew", padx=12, pady=(12, 6))
        self.slots_host = ctk.CTkScrollableFrame(right)
        self.slots_host.grid(row=1, column=0, sticky="nsew", padx=8, pady=(0, 12))
        self.slots_host.grid_columnconfigure(0, weight=1)

        for w in (self, left, right, self.pending_label, self.slots_host):
            w.bind("<Button-1>", lambda _e: self.focus_set())
            w.bind("<Control-v>", self._on_local_paste)
            w.bind("<Control-V>", self._on_local_paste)

    def _slot_path(self, key: str) -> Path:
        return self.templates_dir / f"{key}.png"

    def _on_target_change(self, value: str) -> None:
        self._selected_key = self._label_to_key.get(value, self._current_target_key())
        self._highlight_selected()

    def _current_target_key(self) -> str:
        value = self.target_menu.get()
        if value in self._label_to_key:
            return self._label_to_key[value]
        # 兼容
        if ".png)" in value:
            inner = value.rsplit("(", 1)[-1].rstrip(")")
            return inner.replace(".png", "").strip()
        return value.split("—")[0].split(" ")[0].strip() or "craft_button"

    def _menu_label_for_key(self, key: str) -> str:
        for k, title, _req in TEMPLATE_SLOT_DEFS:
            if k == key:
                return f"{title}  ({k}.png)"
        return key

    def _is_text_focus(self) -> bool:
        w = self.focus_get()
        if w is None:
            return False
        cur = w
        for _ in range(6):
            if cur is None:
                break
            cls = ""
            name = type(cur).__name__
            try:
                cls = cur.winfo_class()
            except Exception:
                pass
            if cls in {"Entry", "Text", "TEntry", "TCombobox"}:
                return True
            if name in {"Entry", "Text", "CTkEntry", "CTkTextbox", "CTkComboBox"}:
                return True
            if "Entry" in name or "Textbox" in name or name == "Text":
                return True
            try:
                cur = cur.master
            except Exception:
                break
        return False

    def _on_global_paste(self, event) -> Optional[str]:
        if self._is_text_focus():
            return None
        self.paste_from_clipboard()
        return "break"

    def _on_local_paste(self, _event=None) -> str:
        self.paste_from_clipboard()
        return "break"

    def paste_from_clipboard(self) -> None:
        try:
            img = get_clipboard_image()
        except ClipboardImageError as e:
            messagebox.showwarning("粘贴模板", str(e))
            self.on_log(str(e))
            return
        except Exception as e:
            messagebox.showerror("粘贴模板", f"读取剪贴板失败: {e}")
            self.on_log(f"粘贴失败: {e}")
            return

        self._pending = img
        thumb = thumbnail_fit(img, *self.PREVIEW_MAX)
        self._pending_ctk = ctk.CTkImage(
            light_image=thumb, dark_image=thumb, size=thumb.size
        )
        self.pending_label.configure(image=self._pending_ctk, text="")
        self.pending_info.configure(
            text=f"已粘贴 {img.size[0]}×{img.size[1]}，选择目标后点「保存到模板」"
        )
        self.on_log(f"已从剪贴板粘贴图片 {img.size[0]}×{img.size[1]}")

    def save_pending(self) -> None:
        if self._pending is None:
            try:
                self._pending = get_clipboard_image()
            except Exception:
                messagebox.showwarning("保存模板", "请先 Ctrl+V 或点「从剪贴板粘贴」")
                return

        key = self._current_target_key()
        path = self._slot_path(key)
        if path.exists():
            if not messagebox.askyesno("覆盖确认", f"已存在 {path.name}，是否覆盖？"):
                return
        try:
            save_template_image(self._pending, path)
        except Exception as e:
            messagebox.showerror("保存失败", str(e))
            self.on_log(f"保存模板失败: {e}")
            return

        self.on_log(f"已保存模板: {path}")
        self.refresh_slots()
        if self.on_saved:
            self.on_saved(key, path)
        messagebox.showinfo("保存成功", f"已写入\n{path}")

    def refresh_slots(self) -> None:
        self._slots_ready = True
        with hide_while_rebuild(self.slots_host):
            self._fill_slots()

    def _fill_slots(self) -> None:
        for child in self.slots_host.winfo_children():
            child.destroy()
        self._slot_images.clear()
        self._slot_cards.clear()

        for key, title, required in TEMPLATE_SLOT_DEFS:
            path = self._slot_path(key)
            img = load_template_image(path)
            req_tag = "必需" if required else "可选"
            exists = img is not None

            card = ctk.CTkFrame(self.slots_host, corner_radius=8)
            card.pack(fill="x", pady=4, padx=2)
            card.grid_columnconfigure(1, weight=1)
            self._slot_cards[key] = card

            if exists:
                thumb = thumbnail_fit(img, *self.SLOT_THUMB)
                cimg = ctk.CTkImage(
                    light_image=thumb, dark_image=thumb, size=thumb.size
                )
                self._slot_images[key] = cimg
                preview = ctk.CTkLabel(card, image=cimg, text="", width=80, height=52)
                status_text = f"{key}.png · {img.size[0]}×{img.size[1]} · {req_tag}"
                status_color = "#6a994e"
            else:
                preview = ctk.CTkLabel(
                    card,
                    text="缺失",
                    width=80,
                    height=52,
                    fg_color=("gray80", "gray28"),
                    corner_radius=6,
                    text_color=("#9b2226" if required else "gray"),
                )
                status_text = f"{key}.png · 未配置 · {req_tag}"
                status_color = "#e5383b" if required else "gray"

            preview.grid(row=0, column=0, rowspan=2, padx=10, pady=10, sticky="nw")

            title_lbl = ctk.CTkLabel(
                card,
                text=title,
                anchor="w",
                font=ui_font(13, "bold"),
            )
            title_lbl.grid(row=0, column=1, sticky="ew", padx=(0, 10), pady=(10, 0))

            st = ctk.CTkLabel(
                card,
                text=status_text,
                anchor="w",
                text_color=status_color,
                font=ui_font(12),
            )
            st.grid(row=1, column=1, sticky="ew", padx=(0, 10), pady=(2, 10))

            def _bind_select(widget, k=key, t=title):
                widget.bind(
                    "<Button-1>", lambda _e, kk=k, tt=t: self._select_target(kk, tt)
                )

            for w in (card, preview, title_lbl, st):
                _bind_select(w)

        self._highlight_selected()

    def _highlight_selected(self) -> None:
        for key, card in self._slot_cards.items():
            if key == self._selected_key:
                card.configure(border_width=2, border_color="#3a86ff")
            else:
                card.configure(border_width=0)

    def _select_target(self, key: str, title: str) -> None:
        self._selected_key = key
        self.target_menu.set(self._menu_label_for_key(key))
        self._highlight_selected()
        self.on_log(f"保存目标已设为 {key}.png")
