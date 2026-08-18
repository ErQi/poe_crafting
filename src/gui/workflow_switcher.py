from __future__ import annotations

from typing import Callable, Optional

import customtkinter as ctk

from ..models import WorkflowLibrary
from . import theme
from .fonts import ui_font
from .widgets import CompactMenu, HScroll


class WorkflowSwitcher(ctk.CTkFrame):
    """组下拉 + 当前组芯片单行，超出横向滚。"""

    def __init__(
        self,
        master,
        on_select: Optional[Callable[[str], None]] = None,
        on_new: Optional[Callable[[], None]] = None,
        on_duplicate: Optional[Callable[[], None]] = None,
        on_delete: Optional[Callable[[], None]] = None,
        **kwargs,
    ) -> None:
        kwargs.setdefault("fg_color", theme.CARD)
        kwargs.setdefault("corner_radius", theme.RADIUS)
        kwargs.setdefault("border_width", 1)
        kwargs.setdefault("border_color", theme.BORDER)
        super().__init__(master, **kwargs)
        self.on_select = on_select
        self.on_new = on_new
        self.on_duplicate = on_duplicate
        self.on_delete = on_delete
        self._library = WorkflowLibrary()
        self._chips: dict[str, ctk.CTkButton] = {}
        self._chip_ids: tuple = ()
        self._group_name = ""
        self._enabled = True

        self.grid_columnconfigure(2, weight=1)
        ctk.CTkLabel(
            self, text="快速切换", font=ui_font(14, "bold"), text_color=theme.TEXT
        ).grid(row=0, column=0, sticky="w", padx=(10, 8), pady=6)
        self.group_menu = CompactMenu(self, values=["自定义"], command=self._on_group)
        self.group_menu.configure(width=120)
        self.group_menu.grid(row=0, column=1, sticky="w", padx=(0, 8), pady=6)
        self.chip_scroll = HScroll(self, canvas_bg=theme.CARD)
        self.chip_scroll.grid(row=0, column=2, sticky="ew", padx=(0, 8), pady=6)
        self.chip_host = self.chip_scroll.inner

        btns = ctk.CTkFrame(self, fg_color="transparent")
        btns.grid(row=0, column=3, sticky="e", padx=(0, 10), pady=6)
        self.btn_new = ctk.CTkButton(
            btns, text="新建", width=52, height=28, command=self._emit_new
        )
        self.btn_new.pack(side="left", padx=(0, 4))
        self.btn_dup = ctk.CTkButton(
            btns, text="复制", width=52, height=28, command=self._emit_duplicate
        )
        self.btn_dup.pack(side="left", padx=4)
        self.btn_del = ctk.CTkButton(
            btns,
            text="删除",
            width=52,
            height=28,
            command=self._emit_delete,
            **theme.BTN_DANGER,
        )
        self.btn_del.pack(side="left", padx=(4, 0))

    def set_library(self, library: WorkflowLibrary) -> None:
        self._library = library
        ids = tuple((item.id, item.name, item.group) for item in library.workflows)
        want = self._active_group()
        if ids == self._chip_ids and self._chips and want == self._group_name:
            self._update_chips()
            return
        self._chip_ids = ids
        self._group_name = want
        self._rebuild()

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled
        self._apply_enabled()

    def _groups(self) -> list[str]:
        return [name for name, _items in self._library.grouped()] or ["自定义"]

    def _active_group(self) -> str:
        workflow = self._library.get(self._library.active_id)
        if workflow is not None:
            return workflow.group.strip() or "自定义"
        groups = self._groups()
        return groups[0]

    def _group_workflows(self):
        for name, items in self._library.grouped():
            if name == self._group_name:
                return items
        return []

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
            button.configure(text=workflow.name, width=theme.chip_width(workflow.name))
            theme.style_chip(button, workflow_id == active_id)
        self._apply_enabled()
        self.after_idle(self.chip_scroll.sync)

    def _rebuild(self) -> None:
        groups = self._groups()
        if self._group_name not in groups:
            self._group_name = groups[0]
        self.group_menu.configure(values=groups)
        self.group_menu.set(self._group_name)
        self._rebuild_chips()

    def _rebuild_chips(self) -> None:
        for child in self.chip_host.winfo_children():
            child.destroy()
        self._chips.clear()
        active_id = self._library.active_id
        for workflow in self._group_workflows():
            button = theme.make_chip(
                self.chip_host,
                workflow.name,
                command=lambda wid=workflow.id: self._emit_select(wid),
                selected=workflow.id == active_id,
            )
            button.pack(side="left", padx=(0, 6), pady=2)
            self._chips[workflow.id] = button
        self._apply_enabled()
        self.after_idle(self.chip_scroll.bind_wheel_tree, self.chip_host)
        self.after_idle(self.chip_scroll.sync)

    def _on_group(self, name: str) -> None:
        if name == self._group_name:
            return
        self._group_name = name
        self._rebuild_chips()

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
