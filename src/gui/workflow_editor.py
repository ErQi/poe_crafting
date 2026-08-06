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
from .widgets import RuleSetEditor

RARITY_LABEL_TO_VALUE = {
    "不校验": "",
    "普通": "普通",
    "魔法": "魔法",
    "稀有": "稀有",
}
RARITY_VALUE_TO_LABEL = {value: label for label, value in RARITY_LABEL_TO_VALUE.items()}

CURRENCY_LABELS = [currency.label for currency in CURRENCIES]


class WorkflowEditor(ctk.CTkFrame):
    """多步骤流程编辑器：动作、后置条件和两个分支去向。"""

    def __init__(
        self,
        master,
        on_change: Optional[Callable[[CraftWorkflow], None]] = None,
        **kwargs,
    ) -> None:
        super().__init__(master, **kwargs)
        self.on_change = on_change
        self._workflow = CraftWorkflow()
        self._selected_index = 0
        self._loading = False
        self._step_buttons: list[ctk.CTkButton] = []
        self._transition_label_to_value: dict[str, str] = {}
        self._transition_value_to_label: dict[str, str] = {}
        self._start_label_to_id: dict[str, str] = {}
        self._start_id_to_label: dict[str, str] = {}

        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(1, weight=1)
        self._build()

    def _build(self) -> None:
        top = ctk.CTkFrame(self)
        top.grid(row=0, column=0, sticky="ew", padx=8, pady=(8, 4))
        top.grid_columnconfigure(1, weight=1)
        top.grid_columnconfigure(3, weight=1)
        ctk.CTkLabel(
            top,
            text="流程名称",
            font=ctk.CTkFont(weight="bold"),
        ).grid(row=0, column=0, sticky="w", padx=(10, 6), pady=8)
        self.workflow_name_entry = ctk.CTkEntry(top)
        self.workflow_name_entry.grid(
            row=0, column=1, sticky="ew", padx=(0, 14), pady=8
        )
        self.workflow_name_entry.bind("<FocusOut>", self._on_header_changed)
        self.workflow_name_entry.bind("<Return>", self._on_header_changed)

        ctk.CTkLabel(top, text="起始步骤").grid(
            row=0, column=2, sticky="w", padx=(0, 6), pady=8
        )
        self.start_step_menu = ctk.CTkOptionMenu(
            top,
            values=["(无步骤)"],
            command=self._on_start_changed,
            dynamic_resizing=False,
        )
        self.start_step_menu.grid(row=0, column=3, sticky="ew", padx=(0, 10), pady=8)

        body = ctk.CTkFrame(self, fg_color="transparent")
        body.grid(row=1, column=0, sticky="nsew", padx=8, pady=(4, 8))
        body.grid_columnconfigure(0, weight=0, minsize=260)
        body.grid_columnconfigure(1, weight=1)
        body.grid_rowconfigure(0, weight=1)

        left = ctk.CTkFrame(body)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 5))
        left.grid_columnconfigure(0, weight=1)
        left.grid_rowconfigure(1, weight=1)
        ctk.CTkLabel(
            left,
            text="执行步骤",
            font=ctk.CTkFont(size=15, weight="bold"),
        ).grid(row=0, column=0, sticky="w", padx=10, pady=(10, 4))
        self.step_list = ctk.CTkScrollableFrame(left, width=236)
        self.step_list.grid(row=1, column=0, sticky="nsew", padx=8, pady=4)
        self.step_list.grid_columnconfigure(0, weight=1)

        step_ops = ctk.CTkFrame(left, fg_color="transparent")
        step_ops.grid(row=2, column=0, sticky="ew", padx=8, pady=(4, 8))
        for column in range(4):
            step_ops.grid_columnconfigure(column, weight=1)
        ctk.CTkButton(
            step_ops,
            text="+",
            width=48,
            command=self._add_step,
            fg_color="#2d6a4f",
        ).grid(row=0, column=0, sticky="ew", padx=2)
        ctk.CTkButton(
            step_ops,
            text="−",
            width=48,
            command=self._delete_step,
            fg_color="#8B3A3A",
        ).grid(row=0, column=1, sticky="ew", padx=2)
        ctk.CTkButton(step_ops, text="↑", width=48, command=self._move_up).grid(
            row=0, column=2, sticky="ew", padx=2
        )
        ctk.CTkButton(step_ops, text="↓", width=48, command=self._move_down).grid(
            row=0, column=3, sticky="ew", padx=2
        )

        self.detail = ctk.CTkFrame(body)
        self.detail.grid(row=0, column=1, sticky="nsew", padx=(5, 0))
        self.detail.grid_columnconfigure(1, weight=1)
        self.detail.grid_rowconfigure(5, weight=1)

        self.step_enabled = tk.BooleanVar(value=True)
        self.enabled_check = ctk.CTkCheckBox(
            self.detail,
            text="启用本步骤",
            variable=self.step_enabled,
            command=self._on_step_field_changed,
        )
        self.enabled_check.grid(
            row=0, column=0, columnspan=2, sticky="w", padx=12, pady=(12, 6)
        )

        ctk.CTkLabel(self.detail, text="步骤名称").grid(
            row=1, column=0, sticky="w", padx=12, pady=4
        )
        self.step_name_entry = ctk.CTkEntry(self.detail)
        self.step_name_entry.grid(row=1, column=1, sticky="ew", padx=12, pady=4)
        self.step_name_entry.bind("<FocusOut>", self._on_step_field_changed)
        self.step_name_entry.bind("<Return>", self._on_step_field_changed)

        ctk.CTkLabel(self.detail, text="使用通货").grid(
            row=2, column=0, sticky="w", padx=12, pady=4
        )
        self.currency_menu = ctk.CTkOptionMenu(
            self.detail,
            values=CURRENCY_LABELS,
            command=lambda _value: self._on_step_field_changed(),
            dynamic_resizing=False,
        )
        self.currency_menu.grid(row=2, column=1, sticky="ew", padx=12, pady=4)

        ctk.CTkLabel(self.detail, text="动作后稀有度").grid(
            row=3, column=0, sticky="w", padx=12, pady=4
        )
        self.rarity_menu = ctk.CTkOptionMenu(
            self.detail,
            values=list(RARITY_LABEL_TO_VALUE),
            command=lambda _value: self._on_step_field_changed(),
            dynamic_resizing=False,
        )
        self.rarity_menu.grid(row=3, column=1, sticky="ew", padx=12, pady=4)

        branch = ctk.CTkFrame(self.detail, fg_color="transparent")
        branch.grid(row=4, column=0, columnspan=2, sticky="ew", padx=12, pady=6)
        branch.grid_columnconfigure(1, weight=1)
        branch.grid_columnconfigure(3, weight=1)
        ctk.CTkLabel(branch, text="命中后").grid(
            row=0, column=0, sticky="w", padx=(0, 6)
        )
        self.success_menu = ctk.CTkOptionMenu(
            branch,
            values=["下一启用步骤"],
            command=lambda _value: self._on_step_field_changed(),
            dynamic_resizing=False,
        )
        self.success_menu.grid(row=0, column=1, sticky="ew", padx=(0, 14))
        ctk.CTkLabel(branch, text="未命中后").grid(
            row=0, column=2, sticky="w", padx=(0, 6)
        )
        self.failure_menu = ctk.CTkOptionMenu(
            branch,
            values=["重复本步骤"],
            command=lambda _value: self._on_step_field_changed(),
            dynamic_resizing=False,
        )
        self.failure_menu.grid(row=0, column=3, sticky="ew")

        rules_wrap = ctk.CTkFrame(self.detail)
        rules_wrap.grid(
            row=5,
            column=0,
            columnspan=2,
            sticky="nsew",
            padx=12,
            pady=(4, 8),
        )
        rules_wrap.grid_columnconfigure(0, weight=1)
        rules_wrap.grid_rowconfigure(1, weight=1)
        ctk.CTkLabel(
            rules_wrap,
            text="动作后的命中条件（留空表示只校验稀有度）",
            font=ctk.CTkFont(weight="bold"),
        ).grid(row=0, column=0, sticky="w", padx=8, pady=(8, 2))
        self.rules_editor = RuleSetEditor(
            rules_wrap,
            on_change=self._on_rules_changed,
        )
        self.rules_editor.grid(row=1, column=0, sticky="nsew", padx=4, pady=4)

        ctk.CTkLabel(
            self.detail,
            text=(
                "启动时先悬停装备并 Ctrl+C（不点击）。之后每步执行："
                "右键所选通货 → 左键目标装备 → Ctrl+C 读取装备 → "
                "按稀有度和词缀条件选择去向。通货图标已内置，"
                "右键前会 Ctrl+C 核对通货中文名称。"
            ),
            text_color="gray",
            font=ctk.CTkFont(size=11),
            anchor="w",
            justify="left",
        ).grid(row=6, column=0, columnspan=2, sticky="ew", padx=12, pady=(0, 10))

    # ---------- public ----------
    def set_workflow(self, workflow: CraftWorkflow) -> None:
        self._loading = True
        try:
            self._workflow = CraftWorkflow.from_dict(workflow.to_dict())
            self._selected_index = 0
            self.workflow_name_entry.delete(0, "end")
            self.workflow_name_entry.insert(0, self._workflow.name)
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
        for child in self.step_list.winfo_children():
            child.destroy()
        self._step_buttons.clear()
        if not self._workflow.steps:
            ctk.CTkLabel(
                self.step_list,
                text="还没有步骤\n点击下方 + 添加",
                text_color="gray",
                justify="center",
            ).grid(row=0, column=0, sticky="ew", pady=30)
            return
        for index, step in enumerate(self._workflow.steps):
            prefix = "" if step.enabled else "[停用] "
            button = ctk.CTkButton(
                self.step_list,
                text=f"{index + 1}. {prefix}{step.name}",
                anchor="w",
                fg_color="#1f6aa5" if index == self._selected_index else "#343638",
                hover_color="#285f85" if index == self._selected_index else "#4a4d50",
                command=lambda i=index: self._select_step(i),
            )
            button.grid(row=index, column=0, sticky="ew", pady=3)
            self._step_buttons.append(button)

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
        self._refresh_step_list()
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
