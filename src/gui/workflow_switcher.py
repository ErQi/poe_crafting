from __future__ import annotations

from typing import Callable, Optional

import customtkinter as ctk
import tkinter as tk

from ..models import WorkflowLibrary
from .widgets import hide_while_rebuild

BELT_RECIPE_HINT = (
    "86+ 腰带：① 生命+抗性蓝 与 攻击元素+抗性蓝，两边点布琳霍克神力后去王城永火重组，双抗必留。"
    "抗性不限火/冰/闪，T1 即可，之后再转换。"
    "② 缺的前缀再做蓝装补，约 1/3 出 2前2后。"
    "③ 督军底做 火伤%+已有前缀，约 1/2 出 3前2后。"
    "④ 工台补空后缀。不要用腐母。"
)

CHIP_ON = "#1f6aa5"
CHIP_OFF = "#2b2d30"
CHIP_HOVER_ON = "#285f85"
CHIP_HOVER_OFF = "#3d4043"


class WorkflowSwitcher(ctk.CTkFrame):
    """按分组展示流程芯片，点击即可切换。"""

    def __init__(
        self,
        master,
        on_select: Optional[Callable[[str], None]] = None,
        on_new: Optional[Callable[[], None]] = None,
        on_duplicate: Optional[Callable[[], None]] = None,
        on_delete: Optional[Callable[[], None]] = None,
        **kwargs,
    ) -> None:
        super().__init__(master, **kwargs)
        self.on_select = on_select
        self.on_new = on_new
        self.on_duplicate = on_duplicate
        self.on_delete = on_delete
        self._library = WorkflowLibrary()
        self._chips: dict[str, tk.Button] = {}
        self._chip_ids: tuple[str, ...] = ()
        self._enabled = True

        self.grid_columnconfigure(0, weight=1)
        head = ctk.CTkFrame(self, fg_color="transparent")
        head.grid(row=0, column=0, sticky="ew", padx=8, pady=(8, 2))
        ctk.CTkLabel(
            head,
            text="快速切换流程",
            font=ctk.CTkFont(size=14, weight="bold"),
        ).pack(side="left")
        ops = ctk.CTkFrame(head, fg_color="transparent")
        ops.pack(side="right")
        self.btn_new = ctk.CTkButton(
            ops, text="新建", width=56, command=self._emit_new
        )
        self.btn_new.pack(side="left", padx=2)
        self.btn_dup = ctk.CTkButton(
            ops, text="复制", width=56, command=self._emit_duplicate
        )
        self.btn_dup.pack(side="left", padx=2)
        self.btn_del = ctk.CTkButton(
            ops,
            text="删除",
            width=56,
            fg_color="#8B3A3A",
            command=self._emit_delete,
        )
        self.btn_del.pack(side="left", padx=2)

        self.chip_host = ctk.CTkFrame(self, fg_color="transparent")
        self.chip_host.grid(row=1, column=0, sticky="ew", padx=8, pady=2)
        self.chip_host.grid_columnconfigure(0, weight=1)

        self.desc_label = ctk.CTkLabel(
            self,
            text="",
            text_color="#c5cdd8",
            font=ctk.CTkFont(size=12),
            anchor="w",
            justify="left",
            wraplength=980,
        )
        self.desc_label.grid(row=2, column=0, sticky="ew", padx=10, pady=(2, 0))

        self.hint_label = ctk.CTkLabel(
            self,
            text=BELT_RECIPE_HINT,
            text_color="gray",
            font=ctk.CTkFont(size=11),
            anchor="w",
            justify="left",
            wraplength=980,
        )
        self.hint_label.grid(row=3, column=0, sticky="ew", padx=10, pady=(0, 8))

    def set_library(self, library: WorkflowLibrary) -> None:
        self._library = library
        ids = tuple(item.id for item in library.workflows)
        if ids == self._chip_ids and self._chips:
            self._update_chips()
            return
        self._chip_ids = ids
        self._rebuild()

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled
        self._apply_enabled()

    def _apply_enabled(self) -> None:
        state = "normal" if self._enabled else "disabled"
        for button in (self.btn_new, self.btn_dup, self.btn_del, *self._chips.values()):
            button.configure(state=state)

    def _update_chips(self) -> None:
        active_id = self._library.active_id
        for workflow_id, button in self._chips.items():
            workflow = self._library.get(workflow_id)
            if workflow is None:
                continue
            selected = workflow_id == active_id
            button.configure(
                text=workflow.name,
                bg=CHIP_ON if selected else CHIP_OFF,
                activebackground=CHIP_HOVER_ON if selected else CHIP_HOVER_OFF,
            )
        self._refresh_copy()
        self._apply_enabled()

    def _refresh_copy(self) -> None:
        current = self._library.active()
        self.desc_label.configure(text=current.description or current.name)
        if current.group == "腰带重组":
            self.hint_label.grid()
        else:
            self.hint_label.grid_remove()

    def _rebuild(self) -> None:
        with hide_while_rebuild(self.chip_host):
            for child in self.chip_host.winfo_children():
                child.destroy()
            self._chips.clear()
            active_id = self._library.active_id
            for row, (group, workflows) in enumerate(self._library.grouped()):
                line = tk.Frame(self.chip_host, bg="#212121")
                line.grid(row=row, column=0, sticky="ew", pady=2)
                tk.Label(
                    line,
                    text=group,
                    width=8,
                    anchor="w",
                    fg="#8a93a3",
                    bg="#212121",
                    font=("Microsoft YaHei UI", 9),
                ).pack(side="left", padx=(0, 6))
                for workflow in workflows:
                    selected = workflow.id == active_id
                    button = tk.Button(
                        line,
                        text=workflow.name,
                        bg=CHIP_ON if selected else CHIP_OFF,
                        fg="#f0f0f0",
                        activebackground=(
                            CHIP_HOVER_ON if selected else CHIP_HOVER_OFF
                        ),
                        activeforeground="#f0f0f0",
                        relief="flat",
                        bd=0,
                        padx=8,
                        pady=3,
                        cursor="hand2",
                        font=("Microsoft YaHei UI", 9),
                        command=lambda wid=workflow.id: self._emit_select(wid),
                    )
                    button.pack(side="left", padx=3, pady=1)
                    self._chips[workflow.id] = button
        self._refresh_copy()
        self._apply_enabled()

    def _emit_select(self, workflow_id: str) -> None:
        if not self._enabled or self.on_select is None:
            return
        if workflow_id == self._library.active_id:
            return
        self.on_select(workflow_id)

    def _emit_new(self) -> None:
        if self._enabled and self.on_new is not None:
            self.on_new()

    def _emit_duplicate(self) -> None:
        if self._enabled and self.on_duplicate is not None:
            self.on_duplicate()

    def _emit_delete(self) -> None:
        if self._enabled and self.on_delete is not None:
            self.on_delete()
