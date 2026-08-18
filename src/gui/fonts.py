"""界面默认字体。须在 set_default_color_theme 之后、建控件之前调用 apply_ui_fonts。"""

from __future__ import annotations

import tkinter as tk
import tkinter.font as tkfont

import customtkinter as ctk

UI_FAMILY = "Microsoft YaHei UI"
UI_SIZE = 13
TK_SIZE = 9


def apply_ui_fonts() -> None:
    theme = ctk.ThemeManager.theme.get("CTkFont")
    if isinstance(theme, dict):
        theme["family"] = UI_FAMILY
        theme["size"] = UI_SIZE
    for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont"):
        try:
            tkfont.nametofont(name).configure(family=UI_FAMILY)
        except tk.TclError:
            pass


def ui_font(size: int | None = None, weight: str = "normal") -> ctk.CTkFont:
    return ctk.CTkFont(
        family=UI_FAMILY, size=UI_SIZE if size is None else size, weight=weight
    )


def tk_ui_font(size: int = TK_SIZE) -> tuple[str, int]:
    return (UI_FAMILY, size)
