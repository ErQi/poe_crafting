"""界面色板与间距。深色工艺台：页底 / 卡片 / 输入 三档。"""

from __future__ import annotations

import tkinter as tk

import customtkinter as ctk

from .fonts import tk_ui_font, ui_font

# 表面
PAGE = "#14161b"
CARD = "#1c1f26"
RAISED = "#252a33"
INPUT = "#12141a"
ROW = "#222730"
ROW_SEL = "#2a3344"
HEADER = "#1a1d24"

# 边与字
BORDER = "#3a4150"
BORDER_LIT = "#5c6678"
TEXT = "#e6e8ed"
MUTED = "#8d95a3"
DIM = "#6b7380"

# 操作色（克制）
ACCENT = "#1f6aa5"
ACCENT_HOVER = "#2878b5"
ACCENT_BORDER = "#5eb0e0"
OK = "#2d6a4f"
OK_HOVER = "#1b4332"
DANGER = "#8B3A3A"
DANGER_HOVER = "#6a2828"

RADIUS = 8
PAD = 10
GAP = 6
NARROW = 820
DETAIL_NARROW = 720
HEAD_NARROW = 900
RULE_MIN_W = 540
STEP_CARD_H = 52
CONTROL_H = 32
CHIP_H = 30

# 启用 | 文本 | 算子 | 阈值 | 备注（表头与数据行共用）
RULE_COLS = (
    (36, 0),
    (120, 3),
    (88, 0),
    (90, 0),
    (80, 2),
)
RULE_PADS = ((6, 4), (4, 4), (4, 4), (4, 4), (4, 6))

BTN_OK = {"fg_color": OK, "hover_color": OK_HOVER}
BTN_DANGER = {"fg_color": DANGER, "hover_color": DANGER_HOVER}
BTN_MUTED = {"fg_color": "#3a3a3a", "hover_color": "#2f2f2f"}


def apply_rule_cols(frame) -> None:
    for i, (minsize, weight) in enumerate(RULE_COLS):
        frame.grid_columnconfigure(i, minsize=minsize, weight=weight)


def surface(master, level: str = "card", **kwargs) -> ctk.CTkFrame:
    colors = {"page": PAGE, "card": CARD, "raised": RAISED}
    kwargs.setdefault("fg_color", colors.get(level, CARD))
    kwargs.setdefault("corner_radius", RADIUS)
    kwargs.setdefault("border_width", 1)
    kwargs.setdefault("border_color", BORDER)
    return ctk.CTkFrame(master, **kwargs)


def heading(master, text: str, size: int = 15) -> ctk.CTkLabel:
    return ctk.CTkLabel(
        master, text=text, font=ui_font(size, "bold"), text_color=TEXT, anchor="w"
    )


def muted(master, text: str, size: int = 12, **kwargs) -> ctk.CTkLabel:
    kwargs.setdefault("text_color", MUTED)
    kwargs.setdefault("anchor", "w")
    kwargs.setdefault("justify", "left")
    return ctk.CTkLabel(master, text=text, font=ui_font(size), **kwargs)


def bind_wrap(label: ctk.CTkLabel, host=None, pad: int = 20) -> None:
    target = host or label.master

    def _sync(event=None) -> None:
        if event is not None and event.widget is not target:
            return
        width = target.winfo_width()
        if width > 24:
            label.configure(wraplength=max(80, width - pad))

    target.bind("<Configure>", _sync, add="+")


def chip_width(text: str) -> int:
    units = sum(2 if ord(ch) > 127 else 1 for ch in text)
    return max(80, units * 8 + 28)


def style_chip(button: ctk.CTkButton, selected: bool) -> None:
    if selected:
        button.configure(
            fg_color=ACCENT,
            hover_color=ACCENT_HOVER,
            text_color="#ffffff",
            border_width=1,
            border_color=ACCENT_BORDER,
        )
    else:
        button.configure(
            fg_color=RAISED,
            hover_color="#343b48",
            text_color=TEXT,
            border_width=1,
            border_color=BORDER_LIT,
        )


def make_chip(master, text: str, command, selected: bool = False) -> ctk.CTkButton:
    button = ctk.CTkButton(
        master,
        text=text,
        width=chip_width(text),
        height=CHIP_H,
        corner_radius=15,
        font=ui_font(12),
        command=command,
    )
    style_chip(button, selected)
    return button


def field_block(master, label: str) -> ctk.CTkFrame:
    box = ctk.CTkFrame(master, fg_color="transparent")
    muted(box, label, size=12).pack(anchor="w", pady=(0, 2))
    return box


def control_box(parent) -> tk.Frame:
    box = tk.Frame(
        parent,
        bg=INPUT,
        highlightbackground=BORDER,
        highlightcolor=BORDER_LIT,
        highlightthickness=1,
        height=CONTROL_H,
    )
    box.pack_propagate(False)
    return box


def padded_entry(parent, value: str = "", **kwargs) -> tuple[tk.Frame, tk.Entry]:
    box = control_box(parent)
    entry = tk.Entry(
        box,
        bg=INPUT,
        fg=TEXT,
        insertbackground=TEXT,
        relief="flat",
        bd=0,
        font=tk_ui_font(12),
        **kwargs,
    )
    entry.pack(fill="both", expand=True, padx=8, pady=0)
    if value:
        entry.insert(0, value)
    return box, entry
