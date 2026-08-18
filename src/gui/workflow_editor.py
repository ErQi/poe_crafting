from __future__ import annotations

import tkinter as tk
from tkinter import messagebox
from typing import Callable, Optional

import customtkinter as ctk

from ..currencies import CURRENCIES, currency_label, currency_template
from ..models import CraftStep, CraftWorkflow, RuleGroup, RuleSet
from ..workflow import (
    TRANSITION_FINISH,
    TRANSITION_GOTO_PREFIX,
    TRANSITION_NEXT,
    TRANSITION_REPEAT,
    TRANSITION_STOP,
)
from . import theme
from .fonts import ui_font
from .widgets import CompactMenu, RuleSetEditor, VScroll, hide_while_rebuild

RARITY_LABEL_TO_VALUE = {
    "不校验": "",
    "普通": "普通",
    "魔法": "魔法",
    "稀有": "稀有",
}
RARITY_VALUE_TO_LABEL = {value: label for label, value in RARITY_LABEL_TO_VALUE.items()}

CURRENCY_LABELS = [currency.label for currency in CURRENCIES]


def _clip(text: str, limit: int = 18) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


class _StepCard(ctk.CTkFrame):
    def __init__(self, master, **kwargs):
        super().__init__(
            master,
            corner_radius=8,
            border_width=1,
            height=theme.STEP_CARD_H,
            **kwargs,
        )
        self.grid_propagate(False)
        self.grid_columnconfigure(2, weight=1)
        self._bar = ctk.CTkFrame(self, width=4, corner_radius=2, fg_color=theme.BORDER)
        self._bar.grid(row=0, column=0, sticky="ns", padx=(10, 8), pady=12)
        self._idx = ctk.CTkLabel(
            self, width=22, text_color=theme.MUTED, font=ui_font(12)
        )
        self._idx.grid(row=0, column=1, padx=(0, 8), pady=12)
        self._name = ctk.CTkLabel(self, anchor="w", font=ui_font(13), text_color=theme.TEXT)
        self._name.grid(row=0, column=2, sticky="ew", padx=(0, 12), pady=12)
        self._command = None
        for widget in (self, self._bar, self._idx, self._name):
            widget.bind("<Button-1>", self._click)

    def set(self, index: int, name: str, enabled: bool, selected: bool, command) -> None:
        self._command = command
        self._idx.configure(text=str(index + 1))
        label = _clip(name) + ("" if enabled else "  停用")
        self._name.configure(text=label, text_color=theme.TEXT if enabled else theme.MUTED)
        if selected:
            self.configure(fg_color=theme.ROW_SEL, border_color=theme.ACCENT_BORDER)
            self._bar.configure(fg_color=theme.ACCENT)
        else:
            self.configure(fg_color=theme.RAISED, border_color=theme.BORDER)
            self._bar.configure(fg_color=theme.BORDER)

    def _click(self, _event=None) -> None:
        if self._command:
            self._command()


class WorkflowEditor(ctk.CTkFrame):
    """多步骤流程编辑器：动作、后置条件和两个分支去向。"""

    def __init__(
        self,
        master,
        on_change: Optional[Callable[[CraftWorkflow], None]] = None,
        **kwargs,
    ) -> None:
        kwargs.setdefault("fg_color", "transparent")
        super().__init__(master, **kwargs)
        self.on_change = on_change
        self._workflow = CraftWorkflow()
        self._selected_index = 0
        self._loading = False
        self._step_cards: list[_StepCard] = []
        self._info_stack: bool | None = None
        self._fields_stack: bool | None = None
        self._info_after = None
        self._fields_after = None
        self._transition_label_to_value: dict[str, str] = {}
        self._transition_value_to_label: dict[str, str] = {}
        self._start_label_to_id: dict[str, str] = {}
        self._start_id_to_label: dict[str, str] = {}

        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(1, weight=1)
        self._build()

    def _build(self) -> None:
        self._info = theme.surface(self)
        self._info.grid(row=0, column=0, sticky="ew", padx=0, pady=(0, 6))
        self._info.grid_columnconfigure(0, weight=2, minsize=160)
        self._info.grid_columnconfigure(1, weight=2, minsize=200)
        self._info.grid_columnconfigure(2, weight=3, minsize=160)
        self._i_name = theme.field_block(self._info, "流程名")
        self.workflow_name_entry = ctk.CTkEntry(
            self._i_name, height=theme.CONTROL_H, fg_color=theme.INPUT
        )
        self.workflow_name_entry.pack(fill="x")
        self.workflow_name_entry.bind("<FocusOut>", self._on_header_changed)
        self.workflow_name_entry.bind("<Return>", self._on_header_changed)

        self._i_start = theme.field_block(self._info, "起始步骤")
        self.start_step_menu = CompactMenu(
            self._i_start, values=["(无步骤)"], command=self._on_start_changed
        )
        self.start_step_menu.pack(fill="x")

        self._i_desc = theme.field_block(self._info, "说明")
        self.workflow_desc_entry = ctk.CTkEntry(
            self._i_desc, height=theme.CONTROL_H, fg_color=theme.INPUT
        )
        self.workflow_desc_entry.pack(fill="x")
        self.workflow_desc_entry.bind("<FocusOut>", self._on_header_changed)
        self.workflow_desc_entry.bind("<Return>", self._on_header_changed)
        self._layout_info(False)
        self._info.bind("<Configure>", self._on_info_cfg)

        self._exec = ctk.CTkFrame(self, fg_color="transparent")
        self._exec.grid(row=1, column=0, sticky="nsew")
        self._exec.grid_columnconfigure(0, minsize=220, weight=0)
        self._exec.grid_columnconfigure(1, weight=1)
        self._exec.grid_rowconfigure(0, weight=1)

        self.left = theme.surface(self._exec)
        self.left.grid(row=0, column=0, sticky="nsew", padx=(0, 8))
        self.left.grid_columnconfigure(0, weight=1)
        self.left.grid_rowconfigure(1, weight=1, minsize=160)
        theme.heading(self.left, "执行步骤", 14).grid(
            row=0, column=0, sticky="w", padx=10, pady=(10, 4)
        )
        self.step_scroll = VScroll(self.left, canvas_bg=theme.PAGE)
        self.step_scroll.grid(row=1, column=0, sticky="nsew", padx=8, pady=4)
        self.step_list = self.step_scroll.inner
        self.step_list.grid_columnconfigure(0, weight=1)

        step_ops = ctk.CTkFrame(self.left, fg_color="transparent")
        step_ops.grid(row=2, column=0, sticky="ew", padx=8, pady=(4, 8))
        for column in range(4):
            step_ops.grid_columnconfigure(column, weight=1)
        ctk.CTkButton(step_ops, text="+", width=40, height=30, command=self._add_step, **theme.BTN_OK).grid(
            row=0, column=0, sticky="ew", padx=2
        )
        ctk.CTkButton(
            step_ops, text="−", width=40, height=30, command=self._delete_step, **theme.BTN_DANGER
        ).grid(row=0, column=1, sticky="ew", padx=2)
        ctk.CTkButton(step_ops, text="↑", width=40, height=30, command=self._move_up).grid(
            row=0, column=2, sticky="ew", padx=2
        )
        ctk.CTkButton(step_ops, text="↓", width=40, height=30, command=self._move_down).grid(
            row=0, column=3, sticky="ew", padx=2
        )

        self.detail = theme.surface(self._exec)
        self.detail.grid(row=0, column=1, sticky="nsew")
        self.detail.grid_columnconfigure(0, weight=1)
        self.detail.grid_rowconfigure(1, weight=1, minsize=200)

        self._fields = ctk.CTkFrame(self.detail, fg_color="transparent")
        self._fields.grid(row=0, column=0, sticky="ew", padx=12, pady=(10, 4))

        self._f_name = theme.field_block(self._fields, "步骤名称")
        self.step_name_entry = ctk.CTkEntry(
            self._f_name, height=theme.CONTROL_H, fg_color=theme.INPUT
        )
        self.step_name_entry.pack(fill="x")
        self.step_name_entry.bind("<FocusOut>", self._on_step_field_changed)
        self.step_name_entry.bind("<Return>", self._on_step_field_changed)

        self.step_enabled = tk.BooleanVar(value=True)
        self._f_en = ctk.CTkFrame(self._fields, fg_color="transparent")
        self.enabled_check = ctk.CTkCheckBox(
            self._f_en,
            text="启用本步骤",
            variable=self.step_enabled,
            command=self._on_step_field_changed,
            font=ui_font(12),
        )
        self.enabled_check.pack(anchor="w", pady=(18, 0))

        self._f_cur = theme.field_block(self._fields, "使用通货")
        self.currency_menu = CompactMenu(
            self._f_cur,
            values=CURRENCY_LABELS,
            command=lambda _value: self._on_step_field_changed(),
        )
        self.currency_menu.pack(fill="x")

        self._f_rar = theme.field_block(self._fields, "动作后稀有度")
        self.rarity_menu = CompactMenu(
            self._f_rar,
            values=list(RARITY_LABEL_TO_VALUE),
            command=lambda _value: self._on_step_field_changed(),
        )
        self.rarity_menu.pack(fill="x")

        self._f_ok = theme.field_block(self._fields, "命中后")
        self.success_menu = CompactMenu(
            self._f_ok,
            values=["下一启用步骤"],
            command=lambda _value: self._on_step_field_changed(),
        )
        self.success_menu.pack(fill="x")

        self._f_fail = theme.field_block(self._fields, "未命中后")
        self.failure_menu = CompactMenu(
            self._f_fail,
            values=["重复本步骤"],
            command=lambda _value: self._on_step_field_changed(),
        )
        self.failure_menu.pack(fill="x")
        self._layout_fields(False)
        self.detail.bind("<Configure>", self._on_detail_cfg)

        rules_wrap = theme.surface(self.detail, "raised")
        rules_wrap.grid(row=1, column=0, sticky="nsew", padx=12, pady=(4, 6))
        rules_wrap.grid_columnconfigure(0, weight=1)
        rules_wrap.grid_rowconfigure(1, weight=1)
        theme.heading(rules_wrap, "命中条件", 13).grid(
            row=0, column=0, sticky="w", padx=8, pady=(8, 2)
        )
        self.rules_editor = RuleSetEditor(rules_wrap, on_change=self._on_rules_changed)
        self.rules_editor.grid(row=1, column=0, sticky="nsew", padx=6, pady=(0, 6))

        tip = theme.muted(
            self.detail,
            "每步：右键通货 → 左键装备 → Ctrl+C。命中/未命中决定去向。",
            wraplength=360,
        )
        tip.grid(row=2, column=0, sticky="ew", padx=12, pady=(0, 10))
        theme.bind_wrap(tip, self.detail, pad=28)

    def _on_info_cfg(self, event) -> None:
        if event.widget is not self._info or event.width < 80:
            return
        if self._info_after is not None:
            self.after_cancel(self._info_after)
        self._info_after = self.after(
            40, lambda w=event.width: self._layout_info(w < theme.HEAD_NARROW)
        )

    def _layout_info(self, stack: bool) -> None:
        self._info_after = None
        if stack == self._info_stack:
            return
        self._info_stack = stack
        for widget in (self._i_name, self._i_start, self._i_desc):
            widget.grid_forget()
        if stack:
            self._info.grid_columnconfigure(2, weight=0, minsize=0)
            self._i_name.grid(row=0, column=0, sticky="ew", padx=(10, 6), pady=(6, 4))
            self._i_start.grid(row=0, column=1, sticky="ew", padx=(6, 10), pady=(6, 4))
            self._i_desc.grid(
                row=1, column=0, columnspan=2, sticky="ew", padx=10, pady=(0, 6)
            )
        else:
            self._info.grid_columnconfigure(2, weight=3, minsize=160)
            self._i_name.grid(row=0, column=0, sticky="ew", padx=(10, 6), pady=6)
            self._i_start.grid(row=0, column=1, sticky="ew", padx=6, pady=6)
            self._i_desc.grid(row=0, column=2, sticky="ew", padx=(6, 10), pady=6)

    def _on_detail_cfg(self, event) -> None:
        if event.widget is not self.detail or event.width < 80:
            return
        if self._fields_after is not None:
            self.after_cancel(self._fields_after)
        self._fields_after = self.after(
            40, lambda w=event.width: self._layout_fields(w < theme.DETAIL_NARROW)
        )

    def _layout_fields(self, stack: bool) -> None:
        self._fields_after = None
        if stack == self._fields_stack:
            return
        self._fields_stack = stack
        for widget in (
            self._f_name,
            self._f_en,
            self._f_cur,
            self._f_rar,
            self._f_ok,
            self._f_fail,
        ):
            widget.grid_forget()
        pairs = (
            (self._f_name, self._f_en),
            (self._f_cur, self._f_rar),
            (self._f_ok, self._f_fail),
        )
        if stack:
            self._fields.grid_columnconfigure(0, weight=1)
            self._fields.grid_columnconfigure(1, weight=0)
            for i, (left, right) in enumerate(pairs):
                left.grid(row=i * 2, column=0, sticky="ew", pady=(0, 6))
                right.grid(row=i * 2 + 1, column=0, sticky="ew", pady=(0, 6))
        else:
            self._fields.grid_columnconfigure(0, weight=3)
            self._fields.grid_columnconfigure(1, weight=2)
            for i, (left, right) in enumerate(pairs):
                left.grid(row=i, column=0, sticky="ew", padx=(0, 8), pady=(0, 6))
                right.grid(row=i, column=1, sticky="ew", pady=(0, 6))

    # ---------- public ----------
    def set_workflow(self, workflow: CraftWorkflow) -> None:
        self._loading = True
        try:
            self._workflow = CraftWorkflow.from_dict(workflow.to_dict())
            self._selected_index = 0
            self.workflow_name_entry.delete(0, "end")
            self.workflow_name_entry.insert(0, self._workflow.name)
            self.workflow_desc_entry.delete(0, "end")
            self.workflow_desc_entry.insert(0, self._workflow.description)
            self._refresh_all()
        finally:
            self._loading = False

    def get_workflow(self) -> CraftWorkflow:
        self._sync_current_from_ui()
        self._sync_header_from_ui()
        return CraftWorkflow.from_dict(self._workflow.to_dict())

    # ---------- sync ----------
    def _current_step(self) -> CraftStep | None:
        if not self._workflow.steps:
            return None
        self._selected_index = max(
            0,
            min(self._selected_index, len(self._workflow.steps) - 1),
        )
        return self._workflow.steps[self._selected_index]

    def _sync_header_from_ui(self) -> None:
        if self._loading:
            return
        self._workflow.name = self.workflow_name_entry.get().strip() or "多步骤通货流程"
        self._workflow.description = self.workflow_desc_entry.get().strip()
        selected = self._start_label_to_id.get(self.start_step_menu.get())
        if selected:
            self._workflow.start_step_id = selected

    def _sync_current_from_ui(self) -> None:
        if self._loading:
            return
        step = self._current_step()
        if step is None:
            return
        step.enabled = bool(self.step_enabled.get())
        step.name = self.step_name_entry.get().strip() or "未命名步骤"
        selected_template = currency_template(self.currency_menu.get())
        if selected_template:
            step.currency_template = selected_template
        step.expected_rarity = RARITY_LABEL_TO_VALUE.get(self.rarity_menu.get(), "")
        step.on_success = self._transition_label_to_value.get(
            self.success_menu.get(), step.on_success
        )
        step.on_failure = self._transition_label_to_value.get(
            self.failure_menu.get(), step.on_failure
        )
        step.ruleset = self.rules_editor.get_ruleset()

    def _load_current_to_ui(self) -> None:
        step = self._current_step()
        self._loading = True
        try:
            if step is None:
                self.detail.grid_remove()
                return
            self.detail.grid()
            self.step_enabled.set(step.enabled)
            self.step_name_entry.delete(0, "end")
            self.step_name_entry.insert(0, step.name)
            self.currency_menu.set(currency_label(step.currency_template))
            self.rarity_menu.set(
                RARITY_VALUE_TO_LABEL.get(step.expected_rarity, "不校验")
            )
            self._refresh_transition_menus(step)
            self.rules_editor.set_ruleset(step.ruleset)
        finally:
            self._loading = False

    def _refresh_all(self) -> None:
        self._refresh_step_list()
        self._refresh_start_menu()
        self._load_current_to_ui()

    def _refresh_step_list(self) -> None:
        steps = self._workflow.steps
        with hide_while_rebuild(self.step_list):
            if not steps:
                for card in self._step_cards:
                    card.destroy()
                self._step_cards.clear()
                for child in self.step_list.winfo_children():
                    child.destroy()
                theme.muted(self.step_list, "还没有步骤\n点击下方 + 添加", justify="center").grid(
                    row=0, column=0, sticky="ew", pady=28
                )
            elif not self._step_cards:
                for child in self.step_list.winfo_children():
                    child.destroy()
            while len(self._step_cards) > len(steps):
                self._step_cards.pop().destroy()
            for index, step in enumerate(steps):
                if index < len(self._step_cards):
                    card = self._step_cards[index]
                else:
                    card = _StepCard(self.step_list)
                    card.grid(row=index, column=0, sticky="ew", pady=4)
                    self._step_cards.append(card)
                card.set(
                    index,
                    step.name,
                    step.enabled,
                    index == self._selected_index,
                    lambda i=index: self._select_step(i),
                )
        self.after_idle(self.step_scroll.bind_wheel_tree, self.step_list)
        self.after_idle(self.step_scroll.sync)

    def _refresh_start_menu(self) -> None:
        self._start_label_to_id.clear()
        self._start_id_to_label.clear()
        for index, step in enumerate(self._workflow.steps):
            if not step.enabled:
                continue
            label = f"{index + 1}. {step.name}"
            self._start_label_to_id[label] = step.id
            self._start_id_to_label[step.id] = label
        values = list(self._start_label_to_id) or ["(无启用步骤)"]
        self.start_step_menu.configure(values=values)
        selected = self._start_id_to_label.get(self._workflow.start_step_id)
        if selected is None and self._start_label_to_id:
            selected = values[0]
            self._workflow.start_step_id = self._start_label_to_id[selected]
        self.start_step_menu.set(selected or values[0])

    def _refresh_transition_menus(self, step: CraftStep) -> None:
        pairs = [
            ("下一启用步骤", TRANSITION_NEXT),
            ("重复本步骤", TRANSITION_REPEAT),
            ("流程完成", TRANSITION_FINISH),
            ("停止流程", TRANSITION_STOP),
        ]
        for index, target in enumerate(self._workflow.steps):
            pairs.append(
                (
                    f"跳转到 {index + 1}. {target.name}",
                    f"{TRANSITION_GOTO_PREFIX}{target.id}",
                )
            )
        self._transition_label_to_value = dict(pairs)
        self._transition_value_to_label = {value: label for label, value in pairs}
        values = [label for label, _value in pairs]
        self.success_menu.configure(values=values)
        self.failure_menu.configure(values=values)
        self.success_menu.set(
            self._transition_value_to_label.get(step.on_success, "停止流程")
        )
        self.failure_menu.set(
            self._transition_value_to_label.get(step.on_failure, "停止流程")
        )

    def _emit(self) -> None:
        if self._loading or self.on_change is None:
            return
        self.on_change(CraftWorkflow.from_dict(self._workflow.to_dict()))

    # ---------- events ----------
    def _on_header_changed(self, _event=None) -> None:
        if self._loading:
            return
        self._sync_header_from_ui()
        self._emit()

    def _on_start_changed(self, value: str) -> None:
        if self._loading:
            return
        step_id = self._start_label_to_id.get(value)
        if step_id:
            self._workflow.start_step_id = step_id
            self._emit()

    def _on_step_field_changed(self, _event=None) -> None:
        if self._loading:
            return
        self._sync_current_from_ui()
        # FocusOut 可能来自用户正要点击左侧另一步；延迟重建列表，避免把
        # 尚未收到 command 事件的按钮提前销毁。
        self.after_idle(self._refresh_after_step_field_changed)
        self._emit()

    def _refresh_after_step_field_changed(self) -> None:
        if self._loading:
            return
        meta = tuple(
            (step.id, step.name, step.enabled) for step in self._workflow.steps
        )
        self._refresh_step_list()
        if meta == getattr(self, "_step_meta", None):
            return
        self._step_meta = meta
        self._refresh_start_menu()
        step = self._current_step()
        if step is not None:
            self._loading = True
            try:
                self._refresh_transition_menus(step)
            finally:
                self._loading = False

    def _on_rules_changed(self, ruleset: RuleSet) -> None:
        if self._loading:
            return
        step = self._current_step()
        if step is not None:
            step.ruleset = RuleSet.from_dict(ruleset.to_dict())
            self._emit()

    def _select_step(self, index: int) -> None:
        if index == self._selected_index:
            return
        self._sync_current_from_ui()
        self._selected_index = index
        self._refresh_all()

    def _add_step(self) -> None:
        self._sync_current_from_ui()
        step = CraftStep(
            name=f"新步骤 {len(self._workflow.steps) + 1}",
            currency_template="currency_alteration",
            ruleset=RuleSet(groups=[RuleGroup(name="本步条件")]),
        )
        self._workflow.steps.append(step)
        self._selected_index = len(self._workflow.steps) - 1
        if not self._workflow.start_step_id:
            self._workflow.start_step_id = step.id
        self._refresh_all()
        self._emit()

    def _delete_step(self) -> None:
        step = self._current_step()
        if step is None:
            return
        if not messagebox.askyesno(
            "删除步骤", f"确认删除「{step.name}」？", parent=self
        ):
            return
        removed_id = step.id
        self._workflow.steps.pop(self._selected_index)
        for other in self._workflow.steps:
            target = f"{TRANSITION_GOTO_PREFIX}{removed_id}"
            if other.on_success == target:
                other.on_success = TRANSITION_STOP
            if other.on_failure == target:
                other.on_failure = TRANSITION_STOP
        if self._workflow.start_step_id == removed_id:
            self._workflow.start_step_id = ""
        self._selected_index = max(0, self._selected_index - 1)
        self._refresh_all()
        self._emit()

    def _move_up(self) -> None:
        if self._selected_index <= 0:
            return
        self._sync_current_from_ui()
        index = self._selected_index
        self._workflow.steps[index - 1], self._workflow.steps[index] = (
            self._workflow.steps[index],
            self._workflow.steps[index - 1],
        )
        self._selected_index -= 1
        self._refresh_all()
        self._emit()

    def _move_down(self) -> None:
        if self._selected_index >= len(self._workflow.steps) - 1:
            return
        self._sync_current_from_ui()
        index = self._selected_index
        self._workflow.steps[index + 1], self._workflow.steps[index] = (
            self._workflow.steps[index],
            self._workflow.steps[index + 1],
        )
        self._selected_index += 1
        self._refresh_all()
        self._emit()
