"""Vue 宿主：配置、自动化、热键、Tk 浮窗。不包含编辑器 UI。"""

from __future__ import annotations

import base64
import io
import json
import queue
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from ..automation import AutomationConfig, CraftAutomation
from ..clipboard_util import get_clipboard
from ..config_store import (
    load_library,
    load_ruleset,
    load_settings,
    resolve_path,
    save_library,
    save_ruleset,
    save_settings,
)
from ..currencies import CURRENCIES, CURRENCY_BY_TEMPLATE, currency_label
from ..hotkeys import HotkeyService
from ..input_control import focus_game_window
from ..item_parser import ItemParseError, format_item_preview, parse_item_text
from ..matcher import match_ruleset, normalize_operator, parse_threshold_text
from ..models import (
    CRAFT_PRESET_LABELS,
    CRAFT_PRESETS,
    AppSettings,
    CraftMode,
    CraftStep,
    CraftWorkflow,
    Item,
    MatchMode,
    MatchResult,
    RuleGroup,
    RuleSet,
    RunStatus,
    StopReason,
)
from ..template_io import (
    ClipboardImageError,
    get_clipboard_image,
    load_template_image,
    save_template_image,
    thumbnail_fit,
)
from ..vision import VisionError, VisionService
from ..workflow import TRANSITION_GOTO_PREFIX, TRANSITION_STOP, validate_workflow
from .bridge import JsApi
from .overlay import FloatingMatchOverlay, format_completion_overlay_lines

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

TEMPLATE_SLOTS: list[tuple[str, str, bool]] = [
    ("craft_button", "执行工艺按钮", True),
    ("item_slot", "目标装备位置（工艺槽/背包）", True),
]

UI_HELP = "help"
UI_GARDEN = "garden"
UI_NORMAL = "normal"
UI_TEMPLATES = "templates"
UI_SETTINGS = "settings"
UI_PAGES = (UI_HELP, UI_GARDEN, UI_NORMAL, UI_TEMPLATES, UI_SETTINGS)
IDLE_START_PAGES = (UI_HELP, UI_SETTINGS)
GARDEN_MODE_LABELS = (
    (CraftMode.GENERIC.value, "点击已选工艺"),
    (CraftMode.PRESET.value, "自动选择工艺"),
)


def _ok(**extra: Any) -> dict:
    return {"ok": True, **extra}


def _err(message: str, **extra: Any) -> dict:
    return {"ok": False, "error": message, **extra}


def _image_url(image, size: tuple[int, int] | None = None) -> str:
    img = thumbnail_fit(image, *size) if size else image
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _format_item(item: Item, match: MatchResult | None = None) -> str:
    text = format_item_preview(item)
    if match is None:
        return text
    outer = "OR" if match.mode == MatchMode.ANY.value else "AND"
    text += f"\n\n匹配结果: {'成功' if match.success else '未达标'}（组间{outer}）\n"
    text += match.summary
    groups = match.group_results or []
    if groups:
        for gr in groups:
            text += f"\n{gr.summary}"
            for hit in gr.hits:
                mark = "✓" if hit.matched else "✗"
                extra = f" | {hit.matched_affix}" if hit.matched_affix else ""
                val = f" | 实际={hit.actual_value}" if hit.actual_value is not None else ""
                text += f"\n    {mark} {hit.rule.pattern} {hit.reason}{extra}{val}"
        return text
    for hit in match.hits:
        mark = "✓" if hit.matched else "✗"
        extra = f" | {hit.matched_affix}" if hit.matched_affix else ""
        val = f" | 实际={hit.actual_value}" if hit.actual_value is not None else ""
        text += f"\n  {mark} {hit.rule.pattern} {hit.reason}{extra}{val}"
    return text


def _normalize_ruleset(data: dict) -> RuleSet:
    raw = dict(data or {})
    for group in raw.get("groups") or []:
        if not isinstance(group, dict):
            continue
        for rule in group.get("rules") or []:
            if not isinstance(rule, dict):
                continue
            thr = rule.get("threshold")
            if isinstance(thr, str) and ("-" in thr or "到" in thr or "至" in thr):
                a, b = parse_threshold_text(thr)
                rule["threshold"], rule["threshold2"] = a, b
            elif isinstance(thr, str):
                a, b = parse_threshold_text(thr)
                rule["threshold"], rule["threshold2"] = a, b
            rule["operator"] = normalize_operator(str(rule.get("operator") or ""))
    return RuleSet.from_dict(raw)


class OverlayRuntime:
    """独立 Tk 线程驱动游戏置顶浮窗，不抢 webview 焦点。"""

    def __init__(self) -> None:
        self._q: queue.Queue[tuple] = queue.Queue()
        self._ready = threading.Event()
        self._root = None
        self.overlay: FloatingMatchOverlay | None = None

    def start(self) -> None:
        threading.Thread(target=self._loop, daemon=True, name="OverlayTk").start()
        self._ready.wait(timeout=8)

    def _loop(self) -> None:
        import tkinter as tk

        import customtkinter as ctk

        ctk.set_appearance_mode("dark")
        root = tk.Tk()
        root.withdraw()
        root.overrideredirect(True)
        root.geometry("1x1+-32000+-32000")
        self._root = root
        self.overlay = FloatingMatchOverlay(root)
        self._ready.set()

        def poll() -> None:
            self._drain()
            root.after(40, poll)

        root.after(40, poll)
        root.mainloop()

    def _drain(self) -> None:
        while True:
            try:
                fn, args, kwargs = self._q.get_nowait()
            except queue.Empty:
                return
            try:
                fn(*args, **kwargs)
            except Exception:
                pass

    def invoke(self, fn, *args, **kwargs) -> None:
        self._q.put((fn, args, kwargs))

    def shutdown(self) -> None:
        def stop() -> None:
            if self.overlay is not None:
                self.overlay.destroy()
            if self._root is not None:
                self._root.quit()

        self.invoke(stop)


class AppHost:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.settings: AppSettings = load_settings()
        self.ruleset: RuleSet = load_ruleset(resolve_path(self.settings.rules_file))
        self.library = load_library(resolve_path(self.settings.workflow_file))
        self.workflow: CraftWorkflow = self.library.active()
        self._logs: list[str] = []
        self.item_preview = "（尚未读取）"
        self._window = None
        self._was_running = False
        self._last_item_ts = 0.0
        self._pending_image = None
        self.template_test: dict[str, Any] = {"status": "", "color": "", "testing": False}
        self.alert: dict[str, Any] | None = None
        self._alert_id = 0

        self._overlay = OverlayRuntime()
        self._overlay.start()
        self.automation = CraftAutomation(on_log=self._on_log, on_status=self._on_status)
        self.hotkeys = HotkeyService()
        if self.settings.craft_mode == CraftMode.WORKFLOW.value:
            self._last_craft_page = UI_NORMAL
            self._garden_mode = CraftMode.GENERIC.value
        else:
            self._last_craft_page = UI_GARDEN
            self._garden_mode = (
                self.settings.craft_mode
                if self.settings.craft_mode
                in (CraftMode.GENERIC.value, CraftMode.PRESET.value)
                else CraftMode.GENERIC.value
            )
        self._ui_page = UI_HELP
        self._restart_hotkeys()
        self._log("就绪。当前页决定启动哪套：花园工艺 / 普通工艺。")
        self._log(f"当前流程: {self.workflow.name}")
        self._log(f"模板目录: {resolve_path(self.settings.templates_dir)}")
        start, stop = self.settings.hotkey_start.upper(), self.settings.hotkey_stop.upper()
        self._log(f"开始热键: {start}  停止热键: {stop}")

    def attach_window(self, window) -> None:
        self._window = window

    def shutdown(self) -> None:
        self.automation.request_stop(StopReason.USER_STOP)
        self.hotkeys.stop()
        self._overlay.shutdown()

    # ---------- 快照 ----------
    def snapshot(self) -> dict:
        with self._lock:
            return {
                "library": self.library.to_dict(),
                "workflow": self.workflow.to_dict(),
                "settings": self.settings.to_dict(),
                "ruleset": self.ruleset.to_dict(),
                "item_preview": self.item_preview,
                "meta": self._meta(),
                "runtime": self.runtime(),
                "templates": self._template_rows(),
            }

    def runtime(self) -> dict:
        status = self.automation.status
        reason = STOP_REASON_TEXT.get(status.stop_reason, status.stop_reason.value)
        if status.running:
            text = f"状态: 运行中 | 第 {status.attempt} 次 | {status.message}"
        elif status.stop_reason != StopReason.NOT_STARTED:
            text = f"状态: 已停止 | {reason} | {status.message}"
        else:
            text = f"状态: 空闲 | {status.message}" if status.message else "状态: 空闲"
        return {
            "running": self.automation.is_running(),
            "attempt": status.attempt,
            "message": status.message,
            "stop_reason": status.stop_reason.value,
            "stop_reason_text": reason,
            "status_text": text,
            "workflow_step_name": status.workflow_step_name,
            "workflow_step_index": status.workflow_step_index,
            "workflow_name": status.workflow_name,
            "logs": list(self._logs[-120:]),
            "item_preview": self.item_preview,
            "alert": self.alert,
            "template_test": dict(self.template_test),
            "pending_preview": None
            if self._pending_image is None
            else _image_url(self._pending_image, (280, 150)),
            "pending_info": self._pending_info(),
        }

    def _meta(self) -> dict:
        return {
            "currencies": [
                {"label": c.label, "template": c.template_name} for c in CURRENCIES
            ],
            "presets": [
                {"key": k, "label": CRAFT_PRESET_LABELS[k]} for k in CRAFT_PRESETS
            ],
            "garden_modes": [{"value": v, "label": n} for v, n in GARDEN_MODE_LABELS],
            "rarities": [
                {"value": "", "label": "不校验"},
                {"value": "普通", "label": "普通"},
                {"value": "魔法", "label": "魔法"},
                {"value": "稀有", "label": "稀有"},
            ],
            "ops": ["", ">=", ">", "<=", "<", "="],
            "template_slots": [
                {"key": k, "title": t, "required": r} for k, t, r in TEMPLATE_SLOTS
            ],
            "hotkey_start": (self.settings.hotkey_start or "f7").upper(),
            "hotkey_stop": (self.settings.hotkey_stop or "f8").upper(),
        }

    def _pending_info(self) -> str:
        img = self._pending_image
        if img is None:
            return "未粘贴"
        return f"已粘贴 {img.size[0]}×{img.size[1]}，选择目标后点「保存到模板」"

    def _wf(self) -> dict:
        return {
            "ok": True,
            "workflow": self.workflow.to_dict(),
            "library": self.library.to_dict(),
        }

    # ---------- 日志 / 状态 ----------
    def _on_log(self, msg: str) -> None:
        self._log(msg)

    def _set_alert(self, title: str, message: str) -> None:
        self._alert_id += 1
        self.alert = {"id": self._alert_id, "title": title, "message": message}

    def _log(self, msg: str) -> None:
        with self._lock:
            self._logs.append(str(msg))
            if len(self._logs) > 240:
                self._logs = self._logs[-120:]
        self._push()

    def _on_status(self, status: RunStatus) -> None:
        if status.running:
            self._was_running = True
            ov = self._overlay.overlay
            if ov is not None:
                self._overlay.invoke(ov.push_status, status)
        else:
            just = self._was_running
            self._was_running = False
            if just and status.stop_reason != StopReason.NOT_STARTED:
                reason = STOP_REASON_TEXT.get(status.stop_reason, status.stop_reason.value)
                lines = format_completion_overlay_lines(status, reason)
                ov = self._overlay.overlay
                if ov is not None:
                    self._overlay.invoke(
                        ov.show_completion,
                        lines,
                        status.stop_reason == StopReason.SUCCESS,
                    )
            else:
                ov = self._overlay.overlay
                if ov is not None:
                    self._overlay.invoke(ov.push_status, status)
        if status.last_item is not None:
            now = time.monotonic()
            if (not status.running) or now - self._last_item_ts >= 1.5:
                self._last_item_ts = now
                self.item_preview = _format_item(status.last_item, status.last_match)
        self._push()

    def _push(self) -> None:
        window = self._window
        if window is None:
            return
        try:
            payload = json.dumps(self.runtime(), ensure_ascii=False)
            window.evaluate_js(f"window.__poePush&&window.__poePush({payload})")
        except Exception:
            pass

    def _busy(self) -> bool:
        return self.automation.is_running()

    def _restart_hotkeys(self) -> None:
        start = (self.settings.hotkey_start or "f7").strip().lower()
        stop = (self.settings.hotkey_stop or "f8").strip().lower()
        bindings = {}
        if start:
            bindings[start] = self._hotkey_start
        if stop and stop != start:
            bindings[stop] = self._hotkey_stop
        self.hotkeys.start(bindings)

    def _hotkey_stop(self) -> None:
        if self.automation.is_running():
            self.automation.request_stop(StopReason.USER_STOP)
            self._log(f"热键 {self.settings.hotkey_stop.upper()}：请求停止")

    def _hotkey_start(self) -> None:
        if self.automation.is_running():
            return
        if self._ui_page in IDLE_START_PAGES:
            label = "使用说明" if self._ui_page == UI_HELP else "设置"
            self._log(f"热键 {self.settings.hotkey_start.upper()}：{label}页不启动工艺")
            return
        kind = self._resolve_kind("")
        label = "花园工艺" if kind == UI_GARDEN else "普通工艺"
        self._log(f"热键 {self.settings.hotkey_start.upper()}：开始（{label}）")
        self.start(kind)

    # ---------- 流程库 ----------
    def select_workflow(self, workflow_id: str) -> dict:
        if self._busy():
            return _err("运行中不能切换流程")
        with self._lock:
            target = self.library.select(workflow_id)
            self.workflow = target
            self._log(f"已切换流程: {target.name}")
            return self._wf()

    def new_workflow(self, group: str = "自定义") -> dict:
        if self._busy():
            return _err("运行中不能新建流程")
        with self._lock:
            step = CraftStep(
                name="新步骤 1",
                currency_template="currency_alteration",
                ruleset=RuleSet(groups=[RuleGroup(name="本步条件")]),
            )
            workflow = CraftWorkflow(
                name=f"新流程 {len(self.library.workflows) + 1}",
                group=group.strip() or "自定义",
                steps=[step],
                start_step_id=step.id,
            )
            self.library.put(workflow)
            self.library.select(workflow.id)
            self.workflow = workflow
            self._log(f"已新建流程: {workflow.name}")
            return self._wf()

    def duplicate_workflow(self) -> dict:
        if self._busy():
            return _err("运行中不能复制流程")
        with self._lock:
            source = self.library.active()
            cloned = CraftWorkflow.from_dict(source.to_dict())
            cloned.id = str(uuid.uuid4())
            cloned.name = f"{source.name} 副本"
            cloned.group = source.group or "自定义"
            self.library.put(cloned)
            self.library.select(cloned.id)
            self.workflow = cloned
            self._log(f"已复制流程: {cloned.name}")
            return self._wf()

    def delete_workflow(self) -> dict:
        if self._busy():
            return _err("运行中不能删除流程")
        with self._lock:
            current = self.library.active()
            if len(self.library.workflows) <= 1:
                return _err("至少保留一套流程")
            name = current.name
            self.library.remove(current.id)
            self.workflow = self.library.active()
            self._log(f"已删除流程: {name}")
            return self._wf()

    def save_workflow(self) -> dict:
        if self._busy():
            return _err("运行中不能保存流程")
        with self._lock:
            self.settings.workflow_file = "config/workflows.json"
            path = resolve_path(self.settings.workflow_file)
            save_library(self.library, path)
            save_settings(self.settings)
            errors = validate_workflow(self.workflow)
            self._log(f"流程库已保存: {path}（当前 {self.workflow.name}）")
            if errors:
                return {
                    "ok": True,
                    "warning": "配置已保存，但开始前还需修正：\n" + "\n".join(f"• {x}" for x in errors),
                    "path": str(path),
                    **self._wf(),
                }
            return {
                **self._wf(),
                "message": f"已保存 {len(self.library.workflows)} 套流程\n{path}",
            }

    def update_workflow_fields(self, fields: dict) -> dict:
        if self._busy():
            return _err("运行中不能改流程")
        with self._lock:
            if "name" in fields:
                self.workflow.name = str(fields.get("name") or "").strip() or "多步骤通货流程"
            if "description" in fields:
                self.workflow.description = str(fields.get("description") or "").strip()
            if "group" in fields:
                self.workflow.group = str(fields.get("group") or "").strip()
            if "start_step_id" in fields:
                sid = str(fields.get("start_step_id") or "")
                if self.workflow.get_step(sid):
                    self.workflow.start_step_id = sid
            self.library.put(self.workflow)
            return self._wf()

    def update_step(self, step_id: str, fields: dict) -> dict:
        if self._busy():
            return _err("运行中不能改步骤")
        with self._lock:
            step = self.workflow.get_step(step_id)
            if step is None:
                return _err("步骤不存在")
            if "name" in fields:
                step.name = str(fields.get("name") or "").strip() or "未命名步骤"
            if "enabled" in fields:
                step.enabled = bool(fields.get("enabled"))
            if "currency_template" in fields:
                step.currency_template = str(fields.get("currency_template") or "").strip()
            if "expected_rarity" in fields:
                step.expected_rarity = str(fields.get("expected_rarity") or "").strip()
            if "on_success" in fields:
                step.on_success = str(fields.get("on_success") or TRANSITION_STOP)
            if "on_failure" in fields:
                step.on_failure = str(fields.get("on_failure") or TRANSITION_STOP)
            self.library.put(self.workflow)
            return self._wf()

    def add_step(self) -> dict:
        if self._busy():
            return _err("运行中不能加步骤")
        with self._lock:
            step = CraftStep(
                name=f"新步骤 {len(self.workflow.steps) + 1}",
                currency_template="currency_alteration",
                ruleset=RuleSet(groups=[RuleGroup(name="本步条件")]),
            )
            self.workflow.steps.append(step)
            if not self.workflow.start_step_id:
                self.workflow.start_step_id = step.id
            self.library.put(self.workflow)
            return {**self._wf(), "step_id": step.id}

    def remove_step(self, step_id: str) -> dict:
        if self._busy():
            return _err("运行中不能删步骤")
        with self._lock:
            step = self.workflow.get_step(step_id)
            if step is None:
                return _err("步骤不存在")
            self.workflow.steps = [s for s in self.workflow.steps if s.id != step_id]
            target = f"{TRANSITION_GOTO_PREFIX}{step_id}"
            for other in self.workflow.steps:
                if other.on_success == target:
                    other.on_success = TRANSITION_STOP
                if other.on_failure == target:
                    other.on_failure = TRANSITION_STOP
            if self.workflow.start_step_id == step_id:
                self.workflow.start_step_id = (
                    self.workflow.enabled_steps()[0].id if self.workflow.enabled_steps() else ""
                )
            self.library.put(self.workflow)
            return self._wf()

    def move_step(self, step_id: str, direction: int) -> dict:
        if self._busy():
            return _err("运行中不能调整步骤")
        with self._lock:
            ids = [s.id for s in self.workflow.steps]
            try:
                index = ids.index(step_id)
            except ValueError:
                return _err("步骤不存在")
            dest = index + (1 if direction > 0 else -1)
            if dest < 0 or dest >= len(self.workflow.steps):
                return self._wf()
            steps = self.workflow.steps
            steps[index], steps[dest] = steps[dest], steps[index]
            self.library.put(self.workflow)
            return self._wf()

    def update_rules(self, ruleset: dict, step_id: str | None = None) -> dict:
        if self._busy():
            return _err("运行中不能改规则")
        with self._lock:
            rs = _normalize_ruleset(ruleset)
            if step_id:
                step = self.workflow.get_step(str(step_id))
                if step is None:
                    return _err("步骤不存在")
                step.ruleset = rs
                self.library.put(self.workflow)
                return self._wf()
            self.ruleset = rs
            self.settings.match_mode = rs.group_combine
            return {"ok": True, "ruleset": self.ruleset.to_dict()}

    # ---------- 设置 / 规则文件 ----------
    def update_settings(self, patch: dict) -> dict:
        with self._lock:
            s = self.settings
            if "max_attempts" in patch:
                try:
                    s.max_attempts = max(1, int(patch["max_attempts"]))
                except (TypeError, ValueError):
                    pass
            if "action_delay_ms" in patch:
                try:
                    s.action_delay_ms = max(0, int(patch["action_delay_ms"]))
                except (TypeError, ValueError):
                    pass
            if "craft_wait_ms" in patch:
                try:
                    s.craft_wait_ms = max(0, int(patch["craft_wait_ms"]))
                except (TypeError, ValueError):
                    pass
            if "template_threshold" in patch:
                try:
                    s.template_threshold = float(patch["template_threshold"])
                except (TypeError, ValueError):
                    pass
            if "hotkey_start" in patch:
                s.hotkey_start = str(patch.get("hotkey_start") or "f7").strip().lower()
            if "hotkey_stop" in patch:
                s.hotkey_stop = str(patch.get("hotkey_stop") or "f8").strip().lower()
            if "craft_mode" in patch:
                mode = str(patch.get("craft_mode") or CraftMode.GENERIC.value)
                if mode in (CraftMode.GENERIC.value, CraftMode.PRESET.value):
                    s.craft_mode = mode
                    self._garden_mode = mode
                elif mode == CraftMode.WORKFLOW.value:
                    s.craft_mode = mode
            if "craft_preset" in patch:
                s.craft_preset = str(patch.get("craft_preset") or "reforge")
            s.match_mode = self.ruleset.group_combine
            return {"ok": True, "settings": s.to_dict(), "meta": self._meta()}

    def save_settings(self) -> dict:
        with self._lock:
            save_settings(self.settings)
            self._restart_hotkeys()
            self._log("设置已保存")
            return {"ok": True, "message": "设置已写入 config/settings.json", "settings": self.settings.to_dict(), "meta": self._meta()}

    def save_rules(self) -> dict:
        with self._lock:
            save_ruleset(self.ruleset, resolve_path(self.settings.rules_file))
            self._log("规则已保存（多组）")
            return {"ok": True, "message": "规则已写入 config/rules.json", "ruleset": self.ruleset.to_dict()}

    # ---------- 启动 / 停止 ----------
    def set_ui_page(self, page: str) -> dict:
        page = str(page or "").strip() or UI_HELP
        if page not in UI_PAGES:
            page = UI_HELP
        with self._lock:
            self._ui_page = page
            if page in (UI_GARDEN, UI_NORMAL):
                self._last_craft_page = page
                self._apply_kind(page)
            return {"ok": True, "page": page, "settings": self.settings.to_dict()}

    def _resolve_kind(self, kind: str = "") -> str:
        k = str(kind or "").strip()
        if k in (UI_GARDEN, UI_NORMAL):
            return k
        if self._ui_page in (UI_GARDEN, UI_NORMAL):
            return self._ui_page
        if self._last_craft_page in (UI_GARDEN, UI_NORMAL):
            return self._last_craft_page
        return UI_NORMAL if self.settings.craft_mode == CraftMode.WORKFLOW.value else UI_GARDEN

    def _apply_kind(self, kind: str) -> str:
        kind = self._resolve_kind(kind)
        if kind == UI_GARDEN:
            mode = self._garden_mode or CraftMode.GENERIC.value
            if mode not in (CraftMode.GENERIC.value, CraftMode.PRESET.value):
                mode = CraftMode.GENERIC.value
            self.settings.craft_mode = mode
            self._garden_mode = mode
        else:
            self.settings.craft_mode = CraftMode.WORKFLOW.value
        return kind

    def prepare_start(self, kind: str = "") -> dict:
        with self._lock:
            self._apply_kind(kind)
            errors, tips = self._start_check()
            if errors:
                return _err("\n".join(errors))
            return {"ok": True, "tips": tips}

    def start(self, kind: str = "") -> dict:
        if self._busy():
            return _err("已在运行")
        with self._lock:
            kind = self._apply_kind(kind)
            errors, _tips = self._start_check()
            if errors:
                return _err("\n".join(errors))
            label = "花园工艺" if kind == UI_GARDEN else "普通工艺"
            self._log(f"启动{label}")
            return self._launch()

    def stop(self) -> dict:
        self.automation.request_stop(StopReason.USER_STOP)
        self._log("已请求停止…")
        return _ok()

    def _start_check(self) -> tuple[list[str], str]:
        s = self.settings
        mode = s.craft_mode
        workflow = self.library.active()
        self.workflow = workflow
        if mode == CraftMode.WORKFLOW.value:
            errors = validate_workflow(workflow)
            if errors:
                return errors, ""
            start = next(
                (st for st in workflow.steps if st.id == workflow.start_step_id),
                workflow.enabled_steps()[0],
            )
            currencies = "、".join(
                currency_label(name)
                for name in dict.fromkeys(st.currency_template for st in workflow.enabled_steps())
            )
            tips = [
                "请确认：",
                "1. 游戏为窗口/无边框模式，背包或通货仓库页保持打开",
                "2. 目标装备与流程会用到的通货都在当前画面可见",
                "3. item_slot.png 截取的是目标装备本身",
                f"4. 流程使用通货: {currencies}（图标已内置）",
                f"5. 当前流程: {workflow.name}  起始步骤: {start.name}",
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
                return ["请至少添加并启用一条非空目标条件"], ""
            tips = [
                "请确认：",
                "1. 游戏为窗口/无边框模式，园艺台已打开",
                "2. 物品已放入工艺槽",
                "3. 已准备 craft_button.png 与 item_slot.png 模板",
            ]
            tips.append(
                "4. 【点击已选】请先在园艺台选中要重复的工艺"
                if mode == CraftMode.GENERIC.value
                else "4. 【自动选择】对应工艺模板在可见区域内"
            )
        tips.append(f"6. 紧急停止热键: {s.hotkey_stop.upper()}")
        tips.append("\n第三方自动化可能违反游戏条款，风险自负。是否开始？")
        return [], "\n".join(tips)

    def _launch(self) -> dict:
        s = self.settings
        mode = s.craft_mode
        workflow = self.library.active() if mode == CraftMode.WORKFLOW.value else None
        save_settings(s)
        save_ruleset(self.ruleset, resolve_path(s.rules_file))
        if workflow is not None:
            s.workflow_file = "config/workflows.json"
            save_library(self.library, resolve_path(s.workflow_file))

        self._log("正在切换到游戏窗口…")
        win, focused = focus_game_window(s.window_title_keywords, retries=8)
        if win is None:
            self._log("未找到游戏窗口，已取消启动")
            return _err("未找到游戏窗口。请确认客户端已启动，标题含 Path of Exile / 流放之路，且为窗口或无边框。")
        if focused:
            self._log(f"已切换到游戏: {win.title}")
            focus_note = ""
        else:
            self._log(f"已找到窗口但未能置前: {win.title}，将继续启动并重试")
            win2, focused2 = focus_game_window(s.window_title_keywords, retries=6)
            if win2 is not None:
                win = win2
            if focused2:
                self._log("重试后已切换到游戏窗口")
                focus_note = ""
            else:
                self._log("仍可能未置前，点击/复制可能失败")
                focus_note = "未能自动置前，请手动点一下游戏窗口。"

        cfg = AutomationConfig(
            settings=s,
            ruleset=self.ruleset,
            craft_mode=mode,
            craft_preset=s.craft_preset,
            workflow=workflow,
        )
        ov = self._overlay.overlay
        try:
            self._was_running = True
            if ov is not None:
                center = win.center

                def show() -> None:
                    ov.reset_run()
                    ov.show(center)
                    ov.add_line("▶ 开始匹配…", success=False)

                self._overlay.invoke(show)
            self.automation.start(cfg)
            return _ok(focus_warning=focus_note)
        except RuntimeError as e:
            self._was_running = False
            if ov is not None:
                self._overlay.invoke(ov.hide)
            return _err(str(e))

    # ---------- 装备 ----------
    def refresh_item(self) -> dict:
        try:
            item = self.automation.read_item_once(self.settings)
            result = match_ruleset(item, self.ruleset)
            self.item_preview = _format_item(item, result)
            self._log("读取成功")
            return {"ok": True, "item_preview": self.item_preview}
        except (VisionError, ItemParseError, OSError, RuntimeError) as e:
            self._log(f"读取失败: {e}")
            return _err(f"读取失败: {e}")

    def parse_clipboard(self) -> dict:
        try:
            item = parse_item_text(get_clipboard())
            result = match_ruleset(item, self.ruleset)
            self.item_preview = _format_item(item, result)
            self._log("已从剪贴板解析物品")
            return {"ok": True, "item_preview": self.item_preview}
        except ItemParseError as e:
            self._log(f"解析失败: {e}")
            return _err(str(e))
        except (OSError, RuntimeError) as e:
            self._log(f"错误: {e}")
            return _err(str(e))

    # ---------- 模板 ----------
    def _slot_path(self, key: str) -> Path:
        return resolve_path(self.settings.templates_dir) / f"{key}.png"

    def _template_rows(self) -> list[dict]:
        rows = []
        for key, title, required in TEMPLATE_SLOTS:
            path = self._slot_path(key)
            img = load_template_image(path)
            row = {
                "key": key,
                "title": title,
                "required": required,
                "exists": img is not None,
                "thumb": "",
                "info": f"{key}.png · 未配置 · {'必需' if required else '可选'}",
            }
            if img is not None:
                row["thumb"] = _image_url(img, (72, 48))
                row["info"] = f"{key}.png · {img.size[0]}×{img.size[1]} · {'必需' if required else '可选'}"
            rows.append(row)
        return rows

    def list_templates(self) -> dict:
        return {"ok": True, "templates": self._template_rows(), "runtime": self.runtime()}

    def paste_template(self) -> dict:
        try:
            img = get_clipboard_image()
        except ClipboardImageError as e:
            self._log(str(e))
            return _err(str(e))
        except Exception as e:
            self._log(f"粘贴失败: {e}")
            return _err(f"读取剪贴板失败: {e}")
        self._pending_image = img
        self._log(f"已从剪贴板粘贴图片 {img.size[0]}×{img.size[1]}")
        return {"ok": True, "runtime": self.runtime()}

    def save_template(self, key: str, overwrite: bool = False) -> dict:
        img = self._pending_image
        if img is None:
            try:
                img = get_clipboard_image()
                self._pending_image = img
            except Exception:
                return _err("请先 Ctrl+V 或点「从剪贴板粘贴」")
        path = self._slot_path(key)
        if path.exists() and not overwrite:
            return {"ok": False, "need_overwrite": True, "error": f"已存在 {path.name}，是否覆盖？"}
        try:
            save_template_image(img, path)
        except Exception as e:
            self._log(f"保存模板失败: {e}")
            return _err(str(e))
        self._log(f"已保存模板: {path}")
        return {
            "ok": True,
            "message": f"已写入\n{path}",
            "templates": self._template_rows(),
        }

    def open_templates_dir(self) -> dict:
        path = resolve_path(self.settings.templates_dir)
        path.mkdir(parents=True, exist_ok=True)
        try:
            if sys.platform == "win32":
                subprocess.Popen(["explorer", str(path)])
            else:
                subprocess.Popen(["xdg-open", str(path)])
            return _ok()
        except OSError as e:
            return _err(f"无法打开目录: {e}")

    def refresh_templates(self) -> dict:
        self._log("已刷新模板预览")
        return {"ok": True, "templates": self._template_rows()}

    def test_templates(self) -> dict:
        if self.template_test.get("testing"):
            return _ok(testing=True)
        names = [
            "craft_button",
            "item_slot",
        ]
        for step in self.workflow.enabled_steps():
            if step.currency_template and step.currency_template not in names:
                names.append(step.currency_template)
        vision = VisionService(self.settings.templates_dir, self.settings.template_threshold)
        for fname in vision.list_templates():
            stem = Path(fname).stem
            if stem in CURRENCY_BY_TEMPLATE and stem not in names:
                continue
            if stem not in names:
                names.append(stem)
        uniq, seen = [], set()
        for name in names:
            if name not in seen:
                seen.add(name)
                uniq.append(name)
        self.template_test = {
            "status": "正在测试（请保持游戏窗口可见）…",
            "color": "#f4a261",
            "testing": True,
        }
        self._log("测试模板匹配…")
        self._push()
        settings_snap = self.settings
        thr = settings_snap.template_threshold
        keywords = list(settings_snap.window_title_keywords)

        def work() -> None:
            try:
                results = vision.test_match_report(keywords, uniq, thr)
                err = None
            except (VisionError, OSError, RuntimeError, ValueError) as e:
                results, err = [], str(e)
            self._on_template_test(results or [], err, thr)

        threading.Thread(target=work, daemon=True, name="TemplateTest").start()
        return _ok(testing=True)

    def _on_template_test(self, results: list, err: Optional[str], thr: float) -> None:
        if err:
            self.template_test = {"status": f"测试失败: {err}", "color": "#e5383b", "testing": False}
            self._log(f"测试模板匹配失败: {err}")
            self._set_alert("测试模板匹配", err)
            self._push()
            return
        lines = [f"阈值: {thr:.2f}", ""]
        ok_n = 0
        for row in results:
            name = row.get("template", "?")
            label = currency_label(name)
            display = f"{label}（内置通货）" if label != name else name
            if row.get("ok"):
                ok_n += 1
                line = f"✓ {display}  score={row.get('score')}  屏幕坐标={row.get('screen_xy')}"
            else:
                score = row.get("score")
                extra = f"  score={score}" if score is not None else ""
                line = f"✗ {display}  {row.get('error')}{extra}"
            self._log(f"  {line}")
            lines.append(line)
        color = "#6a994e" if ok_n else "#e5383b"
        self.template_test = {
            "status": f"完成：{ok_n}/{len(results)} 命中",
            "color": color,
            "testing": False,
        }
        self._set_alert("测试模板匹配", "\n".join(lines))
        self._push()


def run_app(url: str, *, debug: bool = False, serve_local: bool = False) -> None:
    import webview

    host = AppHost()
    window = webview.create_window(
        "PoE1 自动工艺",
        url,
        js_api=JsApi(host),
        width=1180,
        height=800,
        min_size=(960, 620),
        background_color="#12141a",
        text_select=True,
    )
    host.attach_window(window)
    window.events.closing += host.shutdown
    webview.start(debug=debug, http_server=serve_local, private_mode=False)
