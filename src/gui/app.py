from __future__ import annotations

import subprocess
import sys
import threading
import tkinter as tk
from collections.abc import Callable
from pathlib import Path
from tkinter import messagebox

import customtkinter as ctk  # type: ignore[import-untyped]

from ..automation import AutomationConfig, CraftAutomation
from ..config_store import (
    load_ruleset,
    load_settings,
    load_workflow,
    resolve_path,
    save_ruleset,
    save_settings,
    save_workflow,
)
from ..currencies import CURRENCY_BY_TEMPLATE, currency_label
from ..hotkeys import HotkeyService
from ..input_control import focus_game_window
from ..item_parser import ItemParseError, format_item_preview, parse_item_text
from ..matcher import match_ruleset
from ..models import (
    CRAFT_PRESET_LABELS,
    CRAFT_PRESETS,
    AppSettings,
    CraftMode,
    CraftWorkflow,
    Item,
    MatchMode,
    RuleSet,
    RunStatus,
    StopReason,
)
from ..vision import VisionError, VisionService
from ..workflow import validate_workflow
from . import widgets
from .overlay import FloatingMatchOverlay, format_completion_overlay_lines
from .workflow_editor import WorkflowEditor

STOP_REASON_TEXT = {
    StopReason.SUCCESS: "成功：已命中目标",
    StopReason.USER_STOP: "已手动停止",
    StopReason.MAX_ATTEMPTS: "达到最大尝试次数",
    StopReason.PARSE_FAILURES: "连续解析失败",
    StopReason.TEMPLATE_NOT_FOUND: "匹配资源未找到",
    StopReason.CURRENCY_UNAVAILABLE: "通货已用完或不可用",
    StopReason.LIFEFORCE_INSUFFICIENT: "生命力/材料不足",
    StopReason.UNCHANGED: "词缀连续无变化",
    StopReason.WINDOW_NOT_FOUND: "未找到游戏窗口",
    StopReason.WORKFLOW_STOP: "流程按配置停止",
    StopReason.ERROR: "运行异常",
    StopReason.NOT_STARTED: "未开始",
}


class CraftApp(ctk.CTk):
    def __init__(self) -> None:
        super().__init__()
        ctk.set_appearance_mode("dark")
        ctk.set_default_color_theme("blue")

        self.title("PoE1 自动工艺")
        self.geometry("1180x780")
        self.minsize(1020, 680)

        self.settings: AppSettings = load_settings()
        self.ruleset: RuleSet = load_ruleset(resolve_path(self.settings.rules_file))
        self.workflow: CraftWorkflow = load_workflow(
            resolve_path(self.settings.workflow_file)
        )
        self.current_item: Item | None = None

        self.automation = CraftAutomation(
            on_log=self._queue_log,
            on_status=self._queue_status,
        )
        self.hotkeys = HotkeyService()
        self._ui_queue: list[tuple[str, object]] = []
        self._queue_lock = threading.Lock()
        self._was_running = False
        self._overlay = FloatingMatchOverlay(self)

        self._build_ui()
        self._load_settings_to_ui()
        self._refresh_rules_table()
        self._set_running_ui(False)

        self._restart_hotkeys()
        self.after(100, self._poll_queue)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        self._log("就绪。单工艺在「工艺」页配置；通货状态机在「多步骤」页配置。")
        self._log(f"模板目录: {resolve_path(self.settings.templates_dir)}")
        self._log(
            f"开始热键: {self.settings.hotkey_start.upper()}  停止热键: {self.settings.hotkey_stop.upper()}"
        )

    # ---------- UI 构建 ----------
    def _build_ui(self) -> None:
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(0, weight=1)

        self.tabs = ctk.CTkTabview(self)
        self.tabs.grid(row=0, column=0, sticky="nsew", padx=12, pady=12)
        tab_craft = self.tabs.add("工艺")
        tab_workflow = self.tabs.add("多步骤")
        tab_tpl = self.tabs.add("模板")
        tab_craft.grid_columnconfigure(0, weight=1)
        tab_craft.grid_columnconfigure(1, weight=1)
        tab_craft.grid_rowconfigure(0, weight=1)
        tab_tpl.grid_columnconfigure(0, weight=1)
        tab_tpl.grid_rowconfigure(0, weight=1)
        tab_workflow.grid_columnconfigure(0, weight=1)
        tab_workflow.grid_rowconfigure(0, weight=1)

        left = ctk.CTkFrame(tab_craft)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 6), pady=0)
        left.grid_rowconfigure(1, weight=1)
        left.grid_rowconfigure(5, weight=1)
        left.grid_columnconfigure(0, weight=1)

        right = ctk.CTkFrame(tab_craft)
        right.grid(row=0, column=1, sticky="nsew", padx=(6, 0), pady=0)
        right.grid_rowconfigure(2, weight=1)
        right.grid_columnconfigure(0, weight=1)

        # 当前装备
        ctk.CTkLabel(
            left, text="当前装备", font=ctk.CTkFont(size=16, weight="bold")
        ).grid(row=0, column=0, sticky="w", padx=12, pady=(12, 4))
        self.item_box = ctk.CTkTextbox(
            left, height=200, font=ctk.CTkFont(family="Consolas", size=13)
        )
        self.item_box.grid(row=1, column=0, sticky="nsew", padx=12, pady=4)
        self.item_box.insert("1.0", "（尚未读取）")
        self.item_box.configure(state="disabled")

        item_btns = ctk.CTkFrame(left, fg_color="transparent")
        item_btns.grid(row=2, column=0, sticky="ew", padx=12, pady=4)
        self.btn_refresh_item = ctk.CTkButton(
            item_btns, text="刷新装备 (悬停槽位)", command=self._on_refresh_item
        )
        self.btn_refresh_item.pack(side="left", padx=(0, 8))
        self.btn_parse_clipboard = ctk.CTkButton(
            item_btns,
            text="解析当前剪贴板",
            command=self._on_parse_clipboard,
            fg_color="#3a3a3a",
        )
        self.btn_parse_clipboard.pack(side="left")

        # 目标规则（多组 AND/OR）
        ctk.CTkLabel(
            left, text="目标规则（多组）", font=ctk.CTkFont(size=16, weight="bold")
        ).grid(row=3, column=0, sticky="w", padx=12, pady=(16, 4))

        self.rules_frame = widgets.RuleSetEditor(
            left, on_change=self._on_ruleset_changed
        )
        self.rules_frame.grid(row=4, column=0, sticky="nsew", padx=12, pady=4)
        left.grid_rowconfigure(4, weight=1)

        rule_btns = ctk.CTkFrame(left, fg_color="transparent")
        rule_btns.grid(row=5, column=0, sticky="ew", padx=12, pady=(4, 12))
        ctk.CTkButton(rule_btns, text="保存规则", command=self._on_save_rules).pack(
            side="left"
        )

        # 右侧：工艺设置
        ctk.CTkLabel(
            right, text="工艺设置", font=ctk.CTkFont(size=16, weight="bold")
        ).grid(row=0, column=0, sticky="w", padx=12, pady=(12, 4))

        form = ctk.CTkFrame(right, fg_color="transparent")
        form.grid(row=1, column=0, sticky="ew", padx=12, pady=4)
        form.grid_columnconfigure(1, weight=1)

        r = 0
        ctk.CTkLabel(form, text="工艺模式").grid(row=r, column=0, sticky="w", pady=4)
        self.craft_mode_var = tk.StringVar(value=CraftMode.GENERIC.value)
        self.craft_mode_menu = ctk.CTkOptionMenu(
            form,
            variable=self.craft_mode_var,
            values=[
                "通用：点击已选工艺",
                "预设：自动选择工艺",
                "多步骤：通货流程",
            ],
            command=self._on_craft_mode_change,
            dynamic_resizing=False,
        )
        self.craft_mode_menu.grid(row=r, column=1, sticky="ew", pady=4, padx=8)
        self.craft_mode_menu.set("通用：点击已选工艺")

        r = 1
        ctk.CTkLabel(form, text="预设工艺").grid(row=r, column=0, sticky="w", pady=4)
        preset_labels = [CRAFT_PRESET_LABELS[k] for k in CRAFT_PRESETS]
        self.preset_menu = ctk.CTkOptionMenu(
            form, values=preset_labels, dynamic_resizing=False
        )
        self.preset_menu.grid(row=r, column=1, sticky="ew", pady=4, padx=8)
        self.preset_menu.set(CRAFT_PRESET_LABELS.get("reforge", "重铸 (Reforge)"))

        r = 2
        ctk.CTkLabel(form, text="最大次数").grid(row=r, column=0, sticky="w", pady=4)
        self.max_attempts_entry = ctk.CTkEntry(form)
        self.max_attempts_entry.grid(row=r, column=1, sticky="ew", pady=4, padx=8)

        r = 3
        ctk.CTkLabel(form, text="动作延迟 ms").grid(row=r, column=0, sticky="w", pady=4)
        self.action_delay_entry = ctk.CTkEntry(form)
        self.action_delay_entry.grid(row=r, column=1, sticky="ew", pady=4, padx=8)

        r = 4
        ctk.CTkLabel(form, text="工艺等待 ms").grid(row=r, column=0, sticky="w", pady=4)
        self.craft_wait_entry = ctk.CTkEntry(form)
        self.craft_wait_entry.grid(row=r, column=1, sticky="ew", pady=4, padx=8)

        r = 5
        ctk.CTkLabel(form, text="模板阈值").grid(row=r, column=0, sticky="w", pady=4)
        thr_row = ctk.CTkFrame(form, fg_color="transparent")
        thr_row.grid(row=r, column=1, sticky="ew", pady=4, padx=8)
        self.threshold_var = tk.DoubleVar(value=0.82)
        self.threshold_label = ctk.CTkLabel(thr_row, text="0.82", width=40)
        self.threshold_slider = ctk.CTkSlider(
            thr_row,
            from_=0.5,  # type: ignore[arg-type]
            to=0.99,  # type: ignore[arg-type]
            number_of_steps=49,
            variable=self.threshold_var,
            command=self._on_threshold_slide,
        )
        self.threshold_slider.pack(side="left", fill="x", expand=True)
        self.threshold_label.pack(side="left", padx=6)

        r = 6
        ctk.CTkLabel(form, text="开始热键").grid(row=r, column=0, sticky="w", pady=4)
        self.hotkey_start_entry = ctk.CTkEntry(form)
        self.hotkey_start_entry.grid(row=r, column=1, sticky="ew", pady=4, padx=8)

        r = 7
        ctk.CTkLabel(form, text="停止热键").grid(row=r, column=0, sticky="w", pady=4)
        self.hotkey_entry = ctk.CTkEntry(form)
        self.hotkey_entry.grid(row=r, column=1, sticky="ew", pady=4, padx=8)

        # 运行区
        run_frame = ctk.CTkFrame(right)
        run_frame.grid(row=2, column=0, sticky="nsew", padx=12, pady=(8, 12))
        run_frame.grid_rowconfigure(2, weight=1)
        run_frame.grid_columnconfigure(0, weight=1)

        self.status_label = ctk.CTkLabel(
            run_frame, text="状态: 空闲", font=ctk.CTkFont(size=14, weight="bold")
        )
        self.status_label.grid(row=0, column=0, sticky="w", padx=10, pady=(10, 4))

        run_btns = ctk.CTkFrame(run_frame, fg_color="transparent")
        run_btns.grid(row=1, column=0, sticky="ew", padx=10, pady=4)
        self.btn_start = ctk.CTkButton(
            run_btns,
            text="确认并开始 (F7)",
            fg_color="#2d6a4f",
            hover_color="#1b4332",
            command=self._on_start,
            height=36,
        )
        self.btn_start.pack(side="left", padx=(0, 8))
        self.btn_stop = ctk.CTkButton(
            run_btns,
            text="停止 (F8)",
            fg_color="#9b2226",
            hover_color="#6a040f",
            command=self._on_stop,
            height=36,
        )
        self.btn_stop.pack(side="left", padx=(0, 8))
        ctk.CTkButton(run_btns, text="保存设置", command=self._on_save_settings).pack(
            side="left"
        )

        self.log_box = ctk.CTkTextbox(
            run_frame, font=ctk.CTkFont(family="Consolas", size=12)
        )
        self.log_box.grid(row=2, column=0, sticky="nsew", padx=10, pady=(4, 10))
        self.log_box.configure(state="disabled")

        # 多步骤通货流程页
        workflow_wrap = ctk.CTkFrame(tab_workflow, fg_color="transparent")
        workflow_wrap.grid(row=0, column=0, sticky="nsew")
        workflow_wrap.grid_columnconfigure(0, weight=1)
        workflow_wrap.grid_rowconfigure(1, weight=1)
        workflow_head = ctk.CTkFrame(workflow_wrap, fg_color="transparent")
        workflow_head.grid(row=0, column=0, sticky="ew", padx=4, pady=(0, 6))
        ctk.CTkLabel(
            workflow_head,
            text="多步骤通货流程",
            font=ctk.CTkFont(size=17, weight="bold"),
        ).pack(side="left")
        ctk.CTkLabel(
            workflow_head,
            text="每步独立配置通货、命中条件以及成功/失败去向",
            text_color="gray",
        ).pack(side="left", padx=12)

        workflow_actions = ctk.CTkFrame(workflow_head, fg_color="transparent")
        workflow_actions.pack(side="right")
        self.btn_start_workflow = ctk.CTkButton(
            workflow_actions,
            text="开始流程 (F7)",
            width=120,
            fg_color="#2d6a4f",
            hover_color="#1b4332",
            command=self._on_start_workflow,
        )
        self.btn_start_workflow.pack(side="left", padx=(0, 6))
        self.btn_stop_workflow = ctk.CTkButton(
            workflow_actions,
            text="停止",
            width=72,
            fg_color="#9b2226",
            hover_color="#6a040f",
            command=self._on_stop,
        )
        self.btn_stop_workflow.pack(side="left", padx=(0, 6))
        self.btn_save_workflow = ctk.CTkButton(
            workflow_actions,
            text="保存流程",
            width=90,
            command=self._on_save_workflow,
        )
        self.btn_save_workflow.pack(side="left")
        self.workflow_editor = WorkflowEditor(
            workflow_wrap,
            on_change=self._on_workflow_changed,
        )
        self.workflow_editor.grid(row=1, column=0, sticky="nsew")
        self.workflow_editor.set_workflow(self.workflow)

        # 模板页
        tpl_wrap = ctk.CTkFrame(tab_tpl, fg_color="transparent")
        tpl_wrap.grid(row=0, column=0, sticky="nsew")
        tpl_wrap.grid_columnconfigure(0, weight=1)
        tpl_wrap.grid_rowconfigure(0, weight=1)

        self.template_panel = widgets.TemplatePastePanel(
            tpl_wrap,
            templates_dir=self.settings.templates_dir,
            on_log=self._log,
            on_saved=self._on_template_saved,
        )
        self.template_panel.grid(row=0, column=0, sticky="nsew")
        self.template_panel.bind_paste_shortcuts(self)

        tpl_btns = ctk.CTkFrame(tpl_wrap, fg_color="transparent")
        tpl_btns.grid(row=1, column=0, sticky="ew", padx=4, pady=(8, 0))
        ctk.CTkButton(
            tpl_btns, text="打开模板目录", command=self._on_open_templates
        ).pack(side="left", padx=(0, 8))
        self.btn_test_templates = ctk.CTkButton(
            tpl_btns, text="测试模板匹配", command=self._on_test_templates
        )
        self.btn_test_templates.pack(side="left", padx=(0, 8))
        ctk.CTkButton(
            tpl_btns, text="刷新模板预览", command=self._on_refresh_template_preview
        ).pack(side="left")
        self.tpl_test_status = ctk.CTkLabel(
            tpl_btns, text="", text_color="gray", anchor="w"
        )
        self.tpl_test_status.pack(side="left", padx=12, fill="x", expand=True)

    # ---------- 设置同步 ----------
    def _load_settings_to_ui(self) -> None:
        s = self.settings
        self.max_attempts_entry.delete(0, "end")
        self.max_attempts_entry.insert(0, str(s.max_attempts))
        self.action_delay_entry.delete(0, "end")
        self.action_delay_entry.insert(0, str(s.action_delay_ms))
        self.craft_wait_entry.delete(0, "end")
        self.craft_wait_entry.insert(0, str(s.craft_wait_ms))
        self.threshold_var.set(s.template_threshold)
        self.threshold_label.configure(text=f"{s.template_threshold:.2f}")
        self.hotkey_start_entry.delete(0, "end")
        self.hotkey_start_entry.insert(0, s.hotkey_start)
        self.hotkey_entry.delete(0, "end")
        self.hotkey_entry.insert(0, s.hotkey_stop)

        if s.craft_mode == CraftMode.WORKFLOW.value:
            self.craft_mode_menu.set("多步骤：通货流程")
        elif s.craft_mode == CraftMode.PRESET.value:
            self.craft_mode_menu.set("预设：自动选择工艺")
        else:
            self.craft_mode_menu.set("通用：点击已选工艺")

        label = CRAFT_PRESET_LABELS.get(s.craft_preset)
        if label:
            self.preset_menu.set(label)
        self._on_craft_mode_change(self.craft_mode_menu.get())
        self._refresh_hotkey_labels()

    def _collect_settings_from_ui(self) -> AppSettings:
        s = self.settings
        try:
            s.max_attempts = max(1, int(self.max_attempts_entry.get().strip()))
        except ValueError:
            pass
        try:
            s.action_delay_ms = max(0, int(self.action_delay_entry.get().strip()))
        except ValueError:
            pass
        try:
            s.craft_wait_ms = max(0, int(self.craft_wait_entry.get().strip()))
        except ValueError:
            pass
        s.template_threshold = float(self.threshold_var.get())
        s.hotkey_start = (self.hotkey_start_entry.get() or "f7").strip().lower()
        s.hotkey_stop = (self.hotkey_entry.get() or "f8").strip().lower()
        mode_label = self.craft_mode_menu.get()
        if "多步骤" in mode_label:
            s.craft_mode = CraftMode.WORKFLOW.value
        elif "预设" in mode_label:
            s.craft_mode = CraftMode.PRESET.value
        else:
            s.craft_mode = CraftMode.GENERIC.value
        label = self.preset_menu.get()
        key = "reforge"
        for k, v in CRAFT_PRESET_LABELS.items():
            if v == label:
                key = k
                break
        s.craft_preset = key
        # 兼容字段：用组间逻辑回写
        s.match_mode = self.ruleset.group_combine
        return s

    def _refresh_rules_table(self) -> None:
        self.rules_frame.set_ruleset(self.ruleset)

    def _on_ruleset_changed(self, ruleset: RuleSet) -> None:
        self.ruleset = ruleset

    def _on_workflow_changed(self, workflow: CraftWorkflow) -> None:
        self.workflow = workflow

    def _on_craft_mode_change(self, value: str) -> None:
        if hasattr(self, "preset_menu"):
            self.preset_menu.configure(
                state="disabled" if "多步骤" in value else "normal"
            )

    def _on_threshold_slide(self, _value: float | str) -> None:
        self.threshold_label.configure(text=f"{float(self.threshold_var.get()):.2f}")

    # ---------- 队列（线程 -> UI） ----------
    def _queue_log(self, msg: str) -> None:
        with self._queue_lock:
            self._ui_queue.append(("log", msg))

    def _queue_status(self, status: RunStatus) -> None:
        with self._queue_lock:
            self._ui_queue.append(("status", status))

    def _poll_queue(self) -> None:
        with self._queue_lock:
            items = list(self._ui_queue)
            self._ui_queue.clear()
        for kind, payload in items:
            if kind == "log":
                self._log(str(payload), from_queue=True)
            elif kind == "status" and isinstance(payload, RunStatus):
                self._apply_status(payload)
            elif kind == "item":
                pair = payload
                if isinstance(pair, tuple) and len(pair) == 2:
                    self._show_item(pair[0], pair[1])
            elif (
                kind == "template_test"
                and isinstance(payload, tuple)
                and len(payload) == 3
            ):
                results, err, thr = payload
                self._on_template_test_done(results or [], err, float(thr))
        self.after(100, self._poll_queue)

    def _log(self, msg: str, from_queue: bool = False) -> None:
        self.log_box.configure(state="normal")
        self.log_box.insert("end", msg + "\n")
        self.log_box.see("end")
        self.log_box.configure(state="disabled")

    def _apply_status(self, status: RunStatus) -> None:
        reason = STOP_REASON_TEXT.get(status.stop_reason, status.stop_reason.value)
        if status.running:
            self._overlay.push_status(status)
            self._was_running = True
            self.status_label.configure(
                text=f"状态: 运行中 | 第 {status.attempt} 次 | {status.message}"
            )
            self._set_running_ui(True)
        else:
            just_finished = self._was_running
            self._was_running = False
            self.status_label.configure(
                text=f"状态: 已停止 | {reason} | {status.message}"
            )
            self._set_running_ui(False)
            if just_finished and status.stop_reason != StopReason.NOT_STARTED:
                self._show_completion_toast(status)
            else:
                self._overlay.push_status(status)
        if status.last_item is not None:
            self._show_item(status.last_item, status.last_match)

    def _show_completion_toast(self, status: RunStatus) -> None:
        reason = STOP_REASON_TEXT.get(status.stop_reason, status.stop_reason.value)
        lines = format_completion_overlay_lines(status, reason)
        self._overlay.show_completion(
            lines,
            success=status.stop_reason == StopReason.SUCCESS,
        )

    def _set_running_ui(self, running: bool) -> None:
        state = "disabled" if running else "normal"
        self.btn_start.configure(state=state)
        self.btn_start_workflow.configure(state=state)
        self.btn_refresh_item.configure(state=state)
        self.btn_parse_clipboard.configure(state=state)
        self.btn_save_workflow.configure(state=state)
        self.btn_stop.configure(state="normal" if running else "disabled")
        self.btn_stop_workflow.configure(state="normal" if running else "disabled")

    def _show_item(self, item: Item, match=None) -> None:
        self.current_item = item
        text = format_item_preview(item)
        if match is not None:
            outer = "OR" if getattr(match, "mode", "") == MatchMode.ANY.value else "AND"
            text += f"\n\n匹配结果: {'成功' if match.success else '未达标'}（组间{outer}）\n"
            text += match.summary
            if getattr(match, "group_results", None):
                for gr in match.group_results:
                    text += f"\n{gr.summary}"
                    for h in gr.hits:
                        mark = "✓" if h.matched else "✗"
                        extra = f" | {h.matched_affix}" if h.matched_affix else ""
                        val = (
                            f" | 实际={h.actual_value}"
                            if h.actual_value is not None
                            else ""
                        )
                        text += f"\n    {mark} {h.rule.pattern} {h.reason}{extra}{val}"
            else:
                for h in match.hits:
                    mark = "✓" if h.matched else "✗"
                    extra = f" | {h.matched_affix}" if h.matched_affix else ""
                    val = (
                        f" | 实际={h.actual_value}"
                        if h.actual_value is not None
                        else ""
                    )
                    text += f"\n  {mark} {h.rule.pattern} {h.reason}{extra}{val}"
        self.item_box.configure(state="normal")
        self.item_box.delete("1.0", "end")
        self.item_box.insert("1.0", text)
        self.item_box.configure(state="disabled")

    # ---------- 事件 ----------
    def _on_add_rule(self) -> None:
        self.rules_frame.add_rule()
        self.ruleset = self.rules_frame.get_ruleset()

    def _on_del_rule(self) -> None:
        self.rules_frame.delete_selected()
        self.ruleset = self.rules_frame.get_ruleset()

    def _on_save_rules(self) -> None:
        self.ruleset = self.rules_frame.get_ruleset()
        save_ruleset(self.ruleset, resolve_path(self.settings.rules_file))
        self._log("规则已保存（多组）")
        messagebox.showinfo("保存", "规则已写入 config/rules.json（支持多组 AND/OR）")

    def _on_save_workflow(self) -> None:
        self.workflow = self.workflow_editor.get_workflow()
        path = resolve_path(self.settings.workflow_file)
        save_workflow(self.workflow, path)
        errors = validate_workflow(self.workflow)
        self._log(f"多步骤流程已保存: {path}")
        if errors:
            messagebox.showwarning(
                "流程已保存（暂不可执行）",
                "配置已保存，但开始前还需修正：\n\n"
                + "\n".join(f"• {x}" for x in errors),
                parent=self,
            )
        else:
            messagebox.showinfo("保存", f"流程已写入\n{path}", parent=self)

    def _on_save_settings(self) -> None:
        self.settings = self._collect_settings_from_ui()
        save_settings(self.settings)
        self._restart_hotkeys()
        self._refresh_hotkey_labels()
        self._log("设置已保存")
        messagebox.showinfo("保存", "设置已写入 config/settings.json")

    def _restart_hotkeys(self) -> None:
        bindings: dict[str, Callable[[], None]] = {}
        start_key = (self.settings.hotkey_start or "f7").strip().lower()
        stop_key = (self.settings.hotkey_stop or "f8").strip().lower()
        if start_key:
            bindings[start_key] = self._on_hotkey_start
        if stop_key and stop_key != start_key:
            bindings[stop_key] = self._on_hotkey_stop
        self.hotkeys.start(bindings)

    def _refresh_hotkey_labels(self) -> None:
        start = (self.settings.hotkey_start or "f7").upper()
        stop = (self.settings.hotkey_stop or "f8").upper()
        self.btn_start.configure(text=f"确认并开始 ({start})")
        self.btn_stop.configure(text=f"停止 ({stop})")
        self.btn_start_workflow.configure(text=f"开始流程 ({start})")
        self.btn_stop_workflow.configure(text=f"停止 ({stop})")

    def _on_open_templates(self) -> None:
        path = resolve_path(self.settings.templates_dir)
        path.mkdir(parents=True, exist_ok=True)
        try:
            if sys.platform == "win32":
                subprocess.Popen(["explorer", str(path)])
            else:
                subprocess.Popen(["xdg-open", str(path)])
        except OSError as e:
            messagebox.showerror("错误", f"无法打开目录: {e}")

    def _on_template_saved(self, key: str, path) -> None:
        self._log(f"模板已更新: {key} -> {path}")
        self.template_panel.refresh_slots()

    def _on_refresh_template_preview(self) -> None:
        self.template_panel.set_templates_dir(self.settings.templates_dir)
        self._log("已刷新模板预览")

    def _on_test_templates(self) -> None:
        # 结果原先只写到「工艺」页日志，模板页看起来像没反应；改为弹窗 + 状态栏 + 后台执行
        try:
            self.settings = self._collect_settings_from_ui()
        except (AttributeError, ValueError, tk.TclError) as e:
            self._log(f"读取设置失败，使用当前缓存: {e}")

        vision = VisionService(
            self.settings.templates_dir, self.settings.template_threshold
        )
        names = [
            "craft_button",
            "item_slot",
            self.settings.craft_preset,
            "not_enough_lifeforce",
        ]
        try:
            self.workflow = self.workflow_editor.get_workflow()
            for step in self.workflow.enabled_steps():
                if step.currency_template and step.currency_template not in names:
                    names.append(step.currency_template)
        except (AttributeError, ValueError, KeyError, tk.TclError) as e:
            self._log(f"读取流程步骤失败，仅测试默认模板: {e}")
        # 附带目录里其它已有 png
        for fname in vision.list_templates():
            stem = Path(fname).stem
            if stem in CURRENCY_BY_TEMPLATE and stem not in names:
                continue
            if stem not in names:
                names.append(stem)
        seen: set[str] = set()
        uniq: list[str] = []
        for n in names:
            if n not in seen:
                seen.add(n)
                uniq.append(n)

        self.btn_test_templates.configure(state="disabled")
        self.tpl_test_status.configure(
            text="正在测试（请保持游戏窗口可见）…", text_color="#f4a261"
        )
        self._log("测试模板匹配…")

        settings_snap = self.settings
        thr = settings_snap.template_threshold
        keywords = list(settings_snap.window_title_keywords)

        def work() -> None:
            try:
                results = vision.test_match_report(keywords, uniq, thr)
                err = None
            except (VisionError, OSError, RuntimeError, ValueError) as e:
                results = []
                err = str(e)
            with self._queue_lock:
                self._ui_queue.append(("template_test", (results, err, thr)))

        threading.Thread(target=work, daemon=True, name="TemplateTest").start()

    def _on_template_test_done(
        self, results: list, err: str | None, thr: float
    ) -> None:
        self.btn_test_templates.configure(state="normal")
        if err:
            self.tpl_test_status.configure(
                text=f"测试失败: {err}", text_color="#e5383b"
            )
            self._log(f"测试模板匹配失败: {err}")
            messagebox.showerror("测试模板匹配", err)
            return

        lines: list[str] = [f"阈值: {thr:.2f}", ""]
        ok_n = 0
        for r in results:
            name = r.get("template", "?")
            label = currency_label(name)
            display_name = f"{label}（内置通货）" if label != name else name
            if r.get("ok"):
                ok_n += 1
                line = (
                    f"✓ {display_name}  score={r.get('score')}  "
                    f"屏幕坐标={r.get('screen_xy')}"
                )
                self._log(f"  {line}")
                lines.append(line)
            else:
                score = r.get("score")
                score_s = f"  score={score}" if score is not None else ""
                line = f"✗ {display_name}  {r.get('error')}{score_s}"
                self._log(f"  {line}")
                lines.append(line)

        summary = f"完成：{ok_n}/{len(results)} 命中"
        color = "#6a994e" if ok_n else "#e5383b"
        self.tpl_test_status.configure(text=summary, text_color=color)
        messagebox.showinfo("测试模板匹配", "\n".join(lines))

    def _on_refresh_item(self) -> None:
        self.settings = self._collect_settings_from_ui()
        self._log("正在读取工艺槽物品…")

        def work() -> None:
            try:
                item = self.automation.read_item_once(self.settings)
                result = match_ruleset(item, self.rules_frame.get_ruleset())
                with self._queue_lock:
                    self._ui_queue.append(("item", (item, result)))
                    self._ui_queue.append(("log", "读取成功"))
            except (VisionError, ItemParseError, OSError, RuntimeError) as e:
                with self._queue_lock:
                    self._ui_queue.append(("log", f"读取失败: {e}"))

        threading.Thread(target=work, daemon=True).start()

    def _on_parse_clipboard(self) -> None:
        from ..clipboard_util import get_clipboard

        try:
            text = get_clipboard()
            item = parse_item_text(text)
            result = match_ruleset(item, self.rules_frame.get_ruleset())
            self._show_item(item, result)
            self._log("已从剪贴板解析物品")
        except ItemParseError as e:
            messagebox.showerror("解析失败", str(e))
            self._log(f"解析失败: {e}")
        except (OSError, RuntimeError, tk.TclError) as e:
            messagebox.showerror("错误", str(e))
            self._log(f"错误: {e}")

    def _on_start_workflow(self, skip_confirm: bool = False) -> None:
        """从多步骤页直接启动，并自动切换到流程模式。"""
        if self.automation.is_running():
            return
        label = "多步骤：通货流程"
        self.craft_mode_menu.set(label)
        self._on_craft_mode_change(label)
        self._on_start(skip_confirm=skip_confirm)

    def _on_start(self, skip_confirm: bool = False) -> None:
        if self.automation.is_running():
            return
        self.settings = self._collect_settings_from_ui()
        self.ruleset = self.rules_frame.get_ruleset()
        craft_mode = self.settings.craft_mode
        workflow_snapshot: CraftWorkflow | None = None

        if craft_mode == CraftMode.WORKFLOW.value:
            workflow_snapshot = self.workflow_editor.get_workflow()
            self.workflow = workflow_snapshot
            errors = validate_workflow(workflow_snapshot)
            if errors:
                messagebox.showerror(
                    "流程配置无效",
                    "开始前请修正：\n\n" + "\n".join(f"• {x}" for x in errors),
                    parent=self,
                )
                return
            start = next(
                (
                    step
                    for step in workflow_snapshot.steps
                    if step.id == workflow_snapshot.start_step_id
                ),
                workflow_snapshot.enabled_steps()[0],
            )
            currencies = "、".join(
                currency_label(name)
                for name in dict.fromkeys(
                    step.currency_template for step in workflow_snapshot.enabled_steps()
                )
            )
            tips = [
                "请确认：",
                "1. 游戏为窗口/无边框模式，背包或通货仓库页保持打开",
                "2. 目标装备与流程会用到的通货都在当前画面可见",
                "3. item_slot.png 截取的是目标装备本身",
                f"4. 流程使用通货: {currencies}（图标已内置）",
                f"5. 起始步骤: {start.name}",
            ]
        else:
            enabled = [
                rule
                for group in self.ruleset.groups
                if group.enabled
                for rule in group.rules
                if rule.enabled and rule.pattern.strip()
            ]
            if not enabled:
                messagebox.showwarning("规则", "请至少添加并启用一条非空目标条件")
                return
            tips = [
                "请确认：",
                "1. 游戏为窗口/无边框模式，园艺台已打开",
                "2. 物品已放入工艺槽",
                "3. 已准备 craft_button.png 与 item_slot.png 模板",
            ]
            if craft_mode == CraftMode.GENERIC.value:
                tips.append("4. 【通用模式】已在游戏内选中要重复的工艺")
            else:
                tips.append("4. 【预设模式】对应工艺模板在可见区域内")

        tips.append(f"6. 紧急停止热键: {self.settings.hotkey_stop.upper()}")
        tips.append("\n第三方自动化可能违反游戏条款，风险自负。是否开始？")

        if not skip_confirm and not messagebox.askyesno("确认执行", "\n".join(tips)):
            return

        save_settings(self.settings)
        save_ruleset(self.ruleset, resolve_path(self.settings.rules_file))
        if workflow_snapshot is not None:
            save_workflow(
                workflow_snapshot,
                resolve_path(self.settings.workflow_file),
            )

        # 在 GUI 主线程抢前台（比后台线程成功率高）
        self._log("正在切换到游戏窗口…")
        self.update_idletasks()
        win, focused = focus_game_window(self.settings.window_title_keywords, retries=8)
        if win is None:
            messagebox.showerror(
                "未找到游戏",
                "未找到游戏窗口。\n请确认客户端已启动，标题含 Path of Exile / 流放之路，且为窗口或无边框。",
            )
            self._log("未找到游戏窗口，已取消启动")
            return
        if focused:
            self._log(f"已切换到游戏: {win.title}")
        else:
            self._log(f"已找到窗口但未能置前: {win.title}，将继续启动并重试")
            messagebox.showwarning(
                "未能自动置前",
                "系统限制导致无法自动把游戏拉到前台。\n"
                "请手动点一下游戏窗口，然后点确定继续。\n"
                "（以管理员运行本工具通常更容易自动切窗）",
            )
            # 用户点确定后再抢一次
            win2, focused2 = focus_game_window(
                self.settings.window_title_keywords, retries=6
            )
            if win2 is not None:
                win = win2
            if focused2:
                self._log("手动确认后已切换到游戏窗口")
            else:
                self._log("仍可能未置前，点击/复制可能失败")

        cfg = AutomationConfig(
            settings=self.settings,
            ruleset=self.ruleset,
            craft_mode=craft_mode,
            craft_preset=self.settings.craft_preset,
            workflow=workflow_snapshot,
        )
        try:
            self._was_running = True
            self._overlay.reset_run()
            self._overlay.show(win.center)
            self._overlay.add_line("▶ 开始匹配…", success=False)
            self.automation.start(cfg)
            self._set_running_ui(True)
            self.status_label.configure(text="状态: 运行中")
        except RuntimeError as e:
            self._was_running = False
            self._overlay.hide()
            messagebox.showerror("启动失败", str(e))

    def _on_stop(self) -> None:
        self.automation.request_stop(StopReason.USER_STOP)
        self._log("已请求停止…")

    def _on_hotkey_stop(self) -> None:
        if self.automation.is_running():
            self.automation.request_stop(StopReason.USER_STOP)
            self._queue_log(f"热键 {self.settings.hotkey_stop.upper()}：请求停止")

    def _on_hotkey_start(self) -> None:
        if self.automation.is_running():
            return
        self._queue_log(f"热键 {self.settings.hotkey_start.upper()}：开始")
        self.after(0, self._hotkey_start_on_ui)

    def _hotkey_start_on_ui(self) -> None:
        if self.automation.is_running():
            return
        if self.settings.craft_mode == CraftMode.WORKFLOW.value:
            self._on_start_workflow(skip_confirm=True)
        else:
            self._on_start(skip_confirm=True)

    def _on_close(self) -> None:
        try:
            self.automation.request_stop(StopReason.USER_STOP)
            self.hotkeys.stop()
            self._overlay.destroy()
        finally:
            self.destroy()


def run_app() -> None:
    app = CraftApp()
    app.mainloop()
