from __future__ import annotations

import threading
import time
import traceback
from dataclasses import dataclass
from statistics import median
from typing import Callable, Optional

from .clipboard_util import clear_clipboard, wait_clipboard_change
from .currencies import currency_label
from .input_control import (
    click_screen,
    find_game_window,
    focus_game_window,
    focus_window,
    hotkey,
    move_screen,
    sleep_ms,
)
from .item_parser import ItemParseError, parse_item_text
from .matcher import match_ruleset
from .models import (
    AppSettings,
    CraftMode,
    CraftStep,
    CraftWorkflow,
    Item,
    MatchResult,
    RuleSet,
    RunStatus,
    StopReason,
)
from .vision import MatchHit, VisionError, VisionService
from .workflow import (
    ROUTE_FINISH,
    ROUTE_STOP,
    evaluate_step,
    first_enabled_step,
    resolve_transition,
    validate_workflow,
)

LogFn = Callable[[str], None]
StatusFn = Callable[[RunStatus], None]

# 通货候选使用彩色 RMSE 搜索，但最终必须经 Ctrl+C 中文名称核对才能点击。
WORKFLOW_CURRENCY_MAX_RMSE = 80.0
WORKFLOW_CURRENCY_VERIFY_ATTEMPTS = 6
WORKFLOW_CURRENCY_SELECT_DELAY_MS = 120


def _workflow_asset_label(name: str) -> str:
    if name == "item_slot":
        return "目标装备"
    label = currency_label(name)
    return f"{label}图标" if label != name else name


def _hit_client_region(hit: MatchHit) -> tuple[int, int, int, int]:
    """返回匹配区域在游戏客户区内的 left/top/right/bottom。"""

    half_w = hit.width // 2
    half_h = hit.height // 2
    return (
        hit.client_x - half_w,
        hit.client_y - half_h,
        hit.client_x - half_w + hit.width,
        hit.client_y - half_h + hit.height,
    )


def _hit_center_in_region(
    hit: MatchHit,
    region: tuple[int, int, int, int],
) -> bool:
    left, top, right, bottom = region
    return left <= hit.client_x < right and top <= hit.client_y < bottom


def _workflow_currency_scales(
    win,
    verified_icon_size: Optional[float] = None,
    template_size: int = 48,
) -> tuple[float, ...]:
    """官方图标为 48px；PoE UI 会随游戏像素高度缩放。

    尚未核对通货时按窗口高度做宽尺度初搜；一旦已有通货通过
    Ctrl+C 核对，就改用本次画面实测尺寸做窄尺度搜索。该尺寸
    每次启动和窗口变化后都会重新计算，不绑定某个分辨率。
    """

    if verified_icon_size and template_size > 0:
        measured = max(0.25, float(verified_icon_size) / float(template_size))
        return tuple(
            round(measured * multiplier, 3)
            for multiplier in (0.96, 1.0, 1.04)
        )

    base = max(0.75, min(3.0, float(win.height) / 1080.0))
    return tuple(
        round(base * multiplier, 3)
        for multiplier in (0.75, 0.875, 1.0, 1.125)
    )


def _workflow_currency_panel_exclusions(
    win,
    verified_hits: list[MatchHit],
) -> tuple[list[tuple[int, int, int, int]], str]:
    """根据已验证通货所在侧推断 PoE UI 面板，返回面板外禁区。

    面板宽度按窗口高度计算，适配分辨率/UI 缩放；若已验证通货
    分布在两侧，则不限制面板并由后续全屏搜索处理。
    """

    if not verified_hits or not getattr(win, "width", 0):
        return [], "全屏"
    midpoint = float(win.width) / 2.0
    on_left = [hit.client_x < midpoint for hit in verified_hits]
    if not all(on_left) and any(on_left):
        return [], "全屏"

    panel_width = min(int(win.width), int(round(float(win.height) * 0.68)))
    if all(on_left):
        panel_right = max(
            panel_width,
            max(hit.client_x + hit.width for hit in verified_hits),
        )
        if panel_right >= win.width:
            return [], "全屏"
        return [(panel_right, 0, int(win.width), int(win.height))], "左侧面板"

    panel_left = min(
        int(win.width) - panel_width,
        min(hit.client_x - hit.width for hit in verified_hits),
    )
    if panel_left <= 0:
        return [], "全屏"
    return [(0, 0, panel_left, int(win.height))], "右侧面板"


def _should_skip_augmentation(step: CraftStep, item: Item) -> bool:
    """增幅石只对恰好一条显式词缀的魔法物品执行。"""

    return (
        step.currency_template == "currency_augmentation"
        and item.craft_affix_count != 1
    )


@dataclass
class AutomationConfig:
    settings: AppSettings
    ruleset: RuleSet
    craft_mode: str
    craft_preset: str
    workflow: Optional[CraftWorkflow] = None


class CraftAutomation:
    REQUIRED_TEMPLATES = ("craft_button", "item_slot")
    OPTIONAL_STOP_TEMPLATES = ("not_enough_lifeforce",)

    def __init__(
        self,
        on_log: Optional[LogFn] = None,
        on_status: Optional[StatusFn] = None,
    ) -> None:
        self._on_log = on_log or (lambda _m: None)
        self._on_status = on_status or (lambda _s: None)
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._status = RunStatus()
        self._lock = threading.Lock()
        self._verified_currency_templates: set[str] = set()

    @property
    def status(self) -> RunStatus:
        with self._lock:
            return self._status

    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def request_stop(self, reason: StopReason = StopReason.USER_STOP) -> None:
        self._stop_event.set()
        self._update(stop_reason=reason, message="正在停止…")

    def _log(self, msg: str) -> None:
        ts = time.strftime("%H:%M:%S")
        self._on_log(f"[{ts}] {msg}")

    def _update(self, **kwargs) -> None:
        with self._lock:
            for k, v in kwargs.items():
                setattr(self._status, k, v)
            snap = RunStatus(
                running=self._status.running,
                attempt=self._status.attempt,
                parse_failures=self._status.parse_failures,
                unchanged_streak=self._status.unchanged_streak,
                last_item=self._status.last_item,
                last_match=self._status.last_match,
                stop_reason=self._status.stop_reason,
                message=self._status.message,
                workflow_step_name=self._status.workflow_step_name,
                workflow_step_index=self._status.workflow_step_index,
            )
        self._on_status(snap)

    def start(self, config: AutomationConfig) -> None:
        if self.is_running():
            raise RuntimeError("自动化已在运行")
        self._stop_event.clear()
        self._status = RunStatus(running=True, stop_reason=StopReason.NOT_STARTED)
        self._update(running=True, message="启动中")
        self._thread = threading.Thread(
            target=self._run_safe,
            args=(config,),
            name="CraftAutomation",
            daemon=True,
        )
        self._thread.start()

    def join(self, timeout: Optional[float] = None) -> None:
        if self._thread:
            self._thread.join(timeout=timeout)

    def _run_safe(self, config: AutomationConfig) -> None:
        try:
            self._run(config)
        except Exception as e:
            self._log(f"异常退出: {e}")
            self._log(traceback.format_exc())
            self._update(
                running=False,
                stop_reason=StopReason.ERROR,
                message=str(e),
            )

    def _should_stop(self) -> bool:
        return self._stop_event.is_set()

    def _run(self, config: AutomationConfig) -> None:
        s = config.settings
        scales = (
            (1.0, 0.9, 1.1, 0.8, 1.2)
            if config.craft_mode == CraftMode.WORKFLOW.value
            else (1.0,)
        )
        vision = VisionService(
            s.templates_dir,
            threshold=s.template_threshold,
            search_scale=0.7,
            scales=scales,
        )
        try:
            if config.craft_mode == CraftMode.WORKFLOW.value:
                self._run_workflow_with_vision(config, vision)
            else:
                self._run_with_vision(config, vision)
        finally:
            vision.close()

    def _run_workflow_with_vision(
        self,
        config: AutomationConfig,
        vision: VisionService,
    ) -> None:
        s = config.settings
        self._verified_currency_templates.clear()
        if config.workflow is None:
            self._finish(StopReason.ERROR, "未提供多步骤流程配置", 0, 0, 0)
            return

        # 使用启动时快照，避免运行中修改 GUI 影响当前状态机。
        workflow = CraftWorkflow.from_dict(config.workflow.to_dict())
        errors = validate_workflow(workflow)
        if errors:
            self._finish(
                StopReason.ERROR,
                "流程配置无效：" + "；".join(errors),
                0,
                0,
                0,
            )
            return

        required = ["item_slot"]
        for step in workflow.enabled_steps():
            if step.currency_template not in required:
                required.append(step.currency_template)
        missing = [
            _workflow_asset_label(name)
            for name in required
            if not vision.template_path(name).exists()
        ]
        if missing:
            msg = f"多步骤流程缺少内置资源: {', '.join(missing)}"
            self._log(msg)
            self._finish(StopReason.TEMPLATE_NOT_FOUND, msg, 0, 0, 0)
            return

        win, focused = focus_game_window(s.window_title_keywords, retries=4)
        if win is None:
            self._finish(
                StopReason.WINDOW_NOT_FOUND,
                "未找到游戏窗口，请确认已启动且为窗口/无边框模式",
                0,
                0,
                0,
            )
            return
        if focused:
            self._log(f"已切换到游戏: {win.title} ({win.width}x{win.height})")
        else:
            self._log(f"已定位窗口: {win.title}（未完全置前，继续运行）")

        self._log(
            f"开始多步骤流程「{workflow.name}」 | 启用步骤={len(workflow.enabled_steps())} | 最大动作数={s.max_attempts}"
        )
        self._log("首次定位目标装备…")
        if not self._locate_workflow_required(vision, win, s, ["item_slot"]):
            return

        current = first_enabled_step(workflow)
        if current is None:
            self._finish(StopReason.ERROR, "流程没有可执行步骤", 0, 0, 0)
            return

        parse_failures = 0
        # 启动时先只做无点击检查：移动到装备上并 Ctrl+C。
        # 在成功读到装备前绝不会点击通货或目标装备。
        self._log("启动检查：正在悬停目标装备并按 Ctrl+C（不点击）…")
        initial_item: Optional[Item] = None
        for read_try in range(1, s.max_parse_failures + 1):
            try:
                initial_item = self._read_item_fast(vision, win, s)
                parse_failures = 0
                break
            except (ItemParseError, VisionError) as e:
                parse_failures = read_try
                self._update(parse_failures=parse_failures)
                self._log(
                    f"启动读取失败 ({read_try}/{s.max_parse_failures})：{e}"
                )
                vision.clear_position_cache("item_slot")
                if self._should_stop():
                    break
                sleep_ms(max(40, s.action_delay_ms), self._should_stop)
            except Exception as e:
                parse_failures = read_try
                self._update(parse_failures=parse_failures)
                self._log(
                    f"启动读取异常 ({read_try}/{s.max_parse_failures})：{e}"
                )
                if self._should_stop():
                    break

        if initial_item is None:
            if self._should_stop():
                self._finish(
                    StopReason.USER_STOP,
                    "用户停止",
                    0,
                    parse_failures,
                    0,
                )
            else:
                self._finish(
                    StopReason.PARSE_FAILURES,
                    "启动时未能读取目标装备，未执行任何鼠标点击",
                    0,
                    parse_failures,
                    0,
                )
            return

        self._update(last_item=initial_item, parse_failures=0)
        self._log(
            f"启动读取成功：稀有度={initial_item.rarity or '-'} | "
            f"显式词缀={initial_item.craft_affix_count}"
        )

        # 如果装备已经是某一步的动作后稀有度，先用现有词缀计算
        # 分支，便于从中断状态继续；这个判定同样不发送鼠标点击。
        matching_state_steps = [
            step
            for step in workflow.enabled_steps()
            if step.expected_rarity
            and step.expected_rarity.strip() == initial_item.rarity.strip()
        ]
        if matching_state_steps:
            inspected_step = matching_state_steps[0]
            evaluation = evaluate_step(initial_item, inspected_step)
            self._update(last_match=evaluation.match)
            outcome = "命中" if evaluation.success else "未命中"
            self._log(
                f"已有装备状态按步骤「{inspected_step.name}」判定："
                f"{outcome} | {evaluation.summary}"
            )
            transition = (
                inspected_step.on_success
                if evaluation.success
                else inspected_step.on_failure
            )
            try:
                initial_route = resolve_transition(
                    workflow,
                    inspected_step.id,
                    transition,
                )
            except ValueError as e:
                self._finish(StopReason.ERROR, str(e), 0, 0, 0)
                return
            if initial_route.kind == ROUTE_FINISH:
                self._finish(
                    StopReason.SUCCESS,
                    "当前装备已满足流程目标",
                    0,
                    0,
                    0,
                )
                return
            if initial_route.kind == ROUTE_STOP:
                self._finish(
                    StopReason.WORKFLOW_STOP,
                    f"当前装备按步骤「{inspected_step.name}」的配置停止",
                    0,
                    0,
                    0,
                )
                return
            resumed_step = workflow.get_step(initial_route.next_step_id)
            if resumed_step is None:
                self._finish(
                    StopReason.ERROR,
                    f"找不到下一步骤: {initial_route.next_step_id}",
                    0,
                    0,
                    0,
                )
                return
            current = resumed_step
            self._log(f"启动后将从步骤「{current.name}」继续")

        self._log("正在定位通货，并逐个悬停 Ctrl+C 核对中文名称…")
        if not self._locate_and_verify_workflow_currencies(
            vision,
            win,
            s,
            required[1:],
        ):
            self._finish(
                StopReason.TEMPLATE_NOT_FOUND,
                "未能安全验证流程所需通货，未执行任何通货点击",
                0,
                0,
                0,
            )
            return

        unchanged = 0
        current_item = initial_item
        last_raw = f"{initial_item.rarity}|" + "|".join(initial_item.affix_texts())
        last_action_step_id = ""
        reason = StopReason.MAX_ATTEMPTS
        message = f"已达最大动作数 {s.max_attempts}"
        rematch_every = 25

        for attempt in range(1, s.max_attempts + 1):
            if self._should_stop():
                reason = StopReason.USER_STOP
                message = "用户停止"
                break

            step = workflow.get_step(current.id)
            if step is None or not step.enabled:
                reason = StopReason.ERROR
                message = f"当前步骤不存在或已禁用: {current.id}"
                break
            step_index = workflow.steps.index(step) + 1
            self._update(
                attempt=attempt,
                workflow_step_name=step.name,
                workflow_step_index=step_index,
                message=f"步骤 {step_index}: {step.name}",
            )

            if attempt == 1 or attempt % rematch_every == 0:
                win2 = find_game_window(s.window_title_keywords)
                if win2 is None:
                    reason = StopReason.WINDOW_NOT_FOUND
                    message = "游戏窗口丢失"
                    break
                moved = (
                    win2.left != win.left
                    or win2.top != win.top
                    or win2.width != win.width
                    or win2.height != win.height
                )
                win = win2
                if moved:
                    self._log("检测到窗口位置/尺寸变化，重新定位流程模板")
                    vision.clear_position_cache()
                    self._verified_currency_templates.clear()
                    item_ready = self._locate_workflow_required(
                        vision,
                        win,
                        s,
                        ["item_slot"],
                    )
                    currencies_ready = (
                        item_ready
                        and self._locate_and_verify_workflow_currencies(
                            vision,
                            win,
                            s,
                            required[1:],
                        )
                    )
                    if not currencies_ready:
                        reason = StopReason.TEMPLATE_NOT_FOUND
                        message = "窗口移动后流程模板重定位失败"
                        break
                focus_window(win.hwnd, retries=2, settle_ms=40)

            t0 = time.perf_counter()
            item: Optional[Item] = None
            action_performed = not _should_skip_augmentation(step, current_item)
            if not action_performed:
                item = current_item
                self._log(
                    f"#{attempt} 步骤 {step_index}/{len(workflow.steps)} "
                    f"{step.name}：当前有 {item.craft_affix_count} 条显式词缀，"
                    "跳过增幅石（仅恰好 1 条时使用）"
                )
            else:
                self._log(
                    f"#{attempt} 执行步骤 {step_index}/{len(workflow.steps)} "
                    f"{step.name} [使用{currency_label(step.currency_template)}]"
                )
                if not self._apply_currency_step(vision, win, step, s):
                    if self._should_stop():
                        reason = StopReason.USER_STOP
                        message = "用户停止"
                    else:
                        reason = StopReason.TEMPLATE_NOT_FOUND
                        message = (
                            f"无法定位或使用{currency_label(step.currency_template)}"
                        )
                    break

                if sleep_ms(s.craft_wait_ms, self._should_stop):
                    reason = StopReason.USER_STOP
                    message = "用户停止"
                    break

                # 动作已经发生，读取失败时只重读，绝不再次施放通货。
                for read_try in range(1, s.max_parse_failures + 1):
                    try:
                        item = self._read_item_fast(vision, win, s)
                        parse_failures = 0
                        break
                    except (ItemParseError, VisionError) as e:
                        parse_failures = read_try
                        self._update(parse_failures=parse_failures)
                        self._log(
                            f"动作后读取失败 ({read_try}/{s.max_parse_failures})，"
                            f"仅重读装备: {e}"
                        )
                        vision.clear_position_cache("item_slot")
                        if self._should_stop():
                            break
                        sleep_ms(max(40, s.action_delay_ms), self._should_stop)
                    except Exception as e:
                        parse_failures = read_try
                        self._update(parse_failures=parse_failures)
                        self._log(
                            f"动作后读取异常 ({read_try}/{s.max_parse_failures})，"
                            f"仅重读装备: {e}"
                        )
                        if self._should_stop():
                            break

            if item is None:
                if self._should_stop():
                    reason = StopReason.USER_STOP
                    message = "用户停止"
                else:
                    reason = StopReason.PARSE_FAILURES
                    message = "通货动作后连续读取装备失败；为避免重复施放已停止"
                break

            current_item = item
            evaluation = evaluate_step(item, step)
            self._update(
                last_item=item,
                last_match=evaluation.match,
                parse_failures=0,
            )
            elapsed_ms = int((time.perf_counter() - t0) * 1000)
            outcome = "命中" if evaluation.success else "未命中"
            self._log(f"#{attempt} {elapsed_ms}ms | {outcome} | {evaluation.summary}")

            if action_performed:
                raw_key = f"{item.rarity}|" + "|".join(item.affix_texts())
                if raw_key and raw_key == last_raw and step.id == last_action_step_id:
                    unchanged += 1
                    self._update(unchanged_streak=unchanged)
                    # 通货堆可能耗尽或位置变化；下一轮强制重新搜索该通货。
                    vision.clear_position_cache(step.currency_template)
                    self._verified_currency_templates.discard(step.currency_template)
                    if unchanged >= s.max_unchanged:
                        reason = StopReason.UNCHANGED
                        message = (
                            f"步骤「{step.name}」连续 {unchanged} 次未改变装备"
                            "（可能通货耗尽、位置失效或物品状态不允许）"
                        )
                        break
                else:
                    unchanged = 0
                    self._update(unchanged_streak=0)
                last_raw = raw_key
                last_action_step_id = step.id
            else:
                unchanged = 0
                self._update(unchanged_streak=0)

            transition = step.on_success if evaluation.success else step.on_failure
            try:
                route = resolve_transition(workflow, step.id, transition)
            except ValueError as e:
                reason = StopReason.ERROR
                message = str(e)
                break

            if route.kind == ROUTE_FINISH:
                reason = StopReason.SUCCESS
                message = f"流程完成：步骤「{step.name}」命中"
                for affix in item.affixes:
                    self._log(f"  • {affix.text}")
                break
            if route.kind == ROUTE_STOP:
                reason = StopReason.WORKFLOW_STOP
                message = f"步骤「{step.name}」按配置停止"
                break

            next_step = workflow.get_step(route.next_step_id)
            if next_step is None:
                reason = StopReason.ERROR
                message = f"找不到下一步骤: {route.next_step_id}"
                break
            if next_step.id != step.id:
                next_index = workflow.steps.index(next_step) + 1
                self._log(f"转到步骤 {next_index}: {next_step.name}")
            current = next_step

            if sleep_ms(s.action_delay_ms, self._should_stop):
                reason = StopReason.USER_STOP
                message = "用户停止"
                break
        else:
            reason = StopReason.MAX_ATTEMPTS
            message = f"已达最大动作数 {s.max_attempts}"

        self._finish(reason, message, self._status.attempt, parse_failures, unchanged)

    def _run_with_vision(self, config: AutomationConfig, vision: VisionService) -> None:
        s = config.settings
        gc = "OR" if config.ruleset.group_combine == "any" else "AND"
        self._log(
            f"开始自动化 | 模式={config.craft_mode} | 组间={gc} | 组数={len(config.ruleset.groups)} | 最大次数={s.max_attempts}"
        )
        self._log("视觉加速: 位置缓存 + 单尺度匹配 + 降采样搜索")

        missing = []
        for name in self.REQUIRED_TEMPLATES:
            if not vision.template_path(name).exists():
                missing.append(f"{name}.png")
        if config.craft_mode == CraftMode.PRESET.value:
            preset_tpl = config.craft_preset
            if not vision.template_path(preset_tpl).exists():
                missing.append(f"{preset_tpl}.png")
        if missing:
            msg = f"缺少模板文件: {', '.join(missing)}"
            self._log(msg)
            self._update(
                running=False, stop_reason=StopReason.TEMPLATE_NOT_FOUND, message=msg
            )
            return

        # 启动切窗（主线程通常已切过，这里轻量确认）
        win, focused = focus_game_window(s.window_title_keywords, retries=4)
        if win is None:
            msg = "未找到游戏窗口，请确认已启动且为窗口/无边框模式"
            self._log(msg)
            self._update(
                running=False, stop_reason=StopReason.WINDOW_NOT_FOUND, message=msg
            )
            return
        if focused:
            self._log(f"已切换到游戏: {win.title} ({win.width}x{win.height})")
        else:
            self._log(f"已定位窗口: {win.title}（未完全置前，继续运行）")

        # 首次定位模板，后续直接点缓存坐标
        self._log("首次定位模板坐标…")
        if not self._locate_required(vision, win, s, config):
            return

        parse_failures = 0
        unchanged = 0
        last_raw = ""
        reason = StopReason.MAX_ATTEMPTS
        message = "达到最大尝试次数"
        rematch_every = 25  # 定期重标定，防窗口拖动
        lifeforce_every = 10

        for attempt in range(1, s.max_attempts + 1):
            if self._should_stop():
                reason = StopReason.USER_STOP
                message = "用户停止"
                break

            self._update(attempt=attempt, message=f"第 {attempt} 次工艺")
            # 日志降频：每轮只打一行关键信息
            t0 = time.perf_counter()

            # 窗口位置：每 N 次或失败时刷新；避免每轮 EnumWindows + 抢焦点
            if attempt == 1 or attempt % rematch_every == 0:
                win2 = find_game_window(s.window_title_keywords)
                if win2 is None:
                    reason = StopReason.WINDOW_NOT_FOUND
                    message = "游戏窗口丢失"
                    self._log(message)
                    break
                # 窗口移动则清缓存
                if (
                    win2.left != win.left
                    or win2.top != win.top
                    or win2.width != win.width
                    or win2.height != win.height
                ):
                    self._log("检测到窗口位置/尺寸变化，重新匹配模板")
                    vision.clear_position_cache()
                    win = win2
                    if not self._locate_required(vision, win, s, config):
                        reason = StopReason.TEMPLATE_NOT_FOUND
                        message = "窗口移动后模板重定位失败"
                        break
                else:
                    win = win2
                focus_window(win.hwnd, retries=2, settle_ms=40)

            # 生命力不足：降频检测
            if attempt == 1 or attempt % lifeforce_every == 0:
                stop_hit = self._check_lifeforce(vision, win, s)
                if stop_hit is not None:
                    reason = StopReason.LIFEFORCE_INSUFFICIENT
                    message = f"检测到生命力不足 (score={stop_hit.score:.3f})"
                    self._log(message)
                    self._finish(reason, message, attempt, parse_failures, unchanged)
                    return

            # 预设：仅首次/重定位后点选；通用模式跳过
            if config.craft_mode == CraftMode.PRESET.value:
                # 每轮都要点一次工艺项（工艺列表可能取消选中）——优先缓存
                ok = self._click_cached_or_match(
                    vision, win, config.craft_preset, s, force_rematch=False
                )
                if not ok:
                    if self._should_stop():
                        reason = StopReason.USER_STOP
                        message = "用户停止"
                        break
                    reason = StopReason.TEMPLATE_NOT_FOUND
                    message = f"未找到预设工艺模板: {config.craft_preset}.png"
                    self._log(message)
                    break
                if sleep_ms(max(30, s.action_delay_ms // 2), self._should_stop):
                    reason = StopReason.USER_STOP
                    message = "用户停止"
                    break

            # 执行工艺按钮（缓存坐标，极快）
            ok = self._click_cached_or_match(
                vision, win, "craft_button", s, force_rematch=False
            )
            if not ok:
                # 缓存失效，全量重找一次
                self._log("craft_button 缓存失效，重新匹配…")
                vision.clear_position_cache("craft_button")
                ok = self._click_cached_or_match(
                    vision, win, "craft_button", s, force_rematch=True
                )
            if not ok:
                if self._should_stop():
                    reason = StopReason.USER_STOP
                    message = "用户停止"
                    break
                reason = StopReason.TEMPLATE_NOT_FOUND
                message = "未找到 craft_button.png（执行工艺按钮）"
                self._log(message)
                break

            if sleep_ms(s.craft_wait_ms, self._should_stop):
                reason = StopReason.USER_STOP
                message = "用户停止"
                break

            # 读取物品（缓存 item_slot）
            item: Optional[Item] = None
            try:
                item = self._read_item_fast(vision, win, s)
            except ItemParseError as e:
                parse_failures += 1
                self._log(f"解析失败 ({parse_failures}/{s.max_parse_failures}): {e}")
                # 失败时重定位 item_slot
                vision.clear_position_cache("item_slot")
                self._update(parse_failures=parse_failures)
                if parse_failures >= s.max_parse_failures:
                    reason = StopReason.PARSE_FAILURES
                    message = "连续解析失败次数过多"
                    break
                continue
            except VisionError as e:
                parse_failures += 1
                self._log(f"读取物品视觉失败: {e}")
                vision.clear_position_cache("item_slot")
                self._update(parse_failures=parse_failures)
                if parse_failures >= s.max_parse_failures:
                    reason = StopReason.PARSE_FAILURES
                    message = str(e)
                    break
                continue
            except Exception as e:
                parse_failures += 1
                self._log(f"读取物品异常: {e}")
                self._update(parse_failures=parse_failures)
                if parse_failures >= s.max_parse_failures:
                    reason = StopReason.PARSE_FAILURES
                    message = str(e)
                    break
                continue

            parse_failures = 0
            assert item is not None
            result: MatchResult = match_ruleset(item, config.ruleset)
            self._update(last_item=item, last_match=result, parse_failures=0)
            elapsed_ms = int((time.perf_counter() - t0) * 1000)
            self._log(
                f"#{attempt} {elapsed_ms}ms | 词缀={len(item.affixes)} | {result.summary}"
            )

            if result.success:
                reason = StopReason.SUCCESS
                message = "已命中目标词缀"
                self._log(message)
                for a in item.affixes:
                    self._log(f"  • {a.text}")
                break

            raw_key = "|".join(item.affix_texts())
            if raw_key and raw_key == last_raw:
                unchanged += 1
                self._update(unchanged_streak=unchanged)
                if unchanged >= s.max_unchanged:
                    reason = StopReason.UNCHANGED
                    message = "连续多次词缀未变化（可能点空/材料不足/未选中工艺）"
                    self._log(message)
                    break
            else:
                unchanged = 0
                last_raw = raw_key
                self._update(unchanged_streak=0)

            if sleep_ms(s.action_delay_ms, self._should_stop):
                reason = StopReason.USER_STOP
                message = "用户停止"
                break
        else:
            reason = StopReason.MAX_ATTEMPTS
            message = f"已达最大尝试次数 {s.max_attempts}"

        self._finish(reason, message, self._status.attempt, parse_failures, unchanged)

    def _locate_required(
        self,
        vision: VisionService,
        win,
        s: AppSettings,
        config: AutomationConfig,
    ) -> bool:
        names = ["craft_button", "item_slot"]
        if config.craft_mode == CraftMode.PRESET.value:
            names.append(config.craft_preset)
        frame = vision.grab_window(win)
        import cv2

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        for name in names:
            hit = vision.match_in_frame(
                win, frame, name, threshold=s.template_threshold, frame_gray=gray
            )
            if hit is None:
                self._log(f"首次定位失败: {name}.png")
                self._update(
                    running=False,
                    stop_reason=StopReason.TEMPLATE_NOT_FOUND,
                    message=f"未找到 {name}.png",
                )
                return False
            self._log(
                f"定位 {name} @({hit.screen_x},{hit.screen_y}) score={hit.score:.3f}"
            )
        return True

    def _locate_workflow_required(
        self,
        vision: VisionService,
        win,
        s: AppSettings,
        names: list[str],
    ) -> bool:
        frame = vision.grab_window(win)
        import cv2

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        for name in names:
            hit = vision.match_in_frame(
                win,
                frame,
                name,
                threshold=s.template_threshold,
                frame_gray=gray,
            )
            if hit is None:
                msg = f"无法定位{_workflow_asset_label(name)}"
                self._log(msg)
                self._update(
                    running=False,
                    stop_reason=StopReason.TEMPLATE_NOT_FOUND,
                    message=msg,
                )
                return False
            self._log(
                f"定位{_workflow_asset_label(name)} "
                f"@({hit.screen_x},{hit.screen_y}) score={hit.score:.3f}"
            )
        return True

    def _locate_and_verify_workflow_currencies(
        self,
        vision: VisionService,
        win,
        s: AppSettings,
        names: list[str],
    ) -> bool:
        item_hit = vision.get_cached_position("item_slot")
        if item_hit is None:
            self._log("核对通货前丢失了目标装备坐标")
            return False
        frame = self._grab_workflow_frame_without_tooltip(vision, win, s)
        if frame is None:
            return False
        excluded_regions = [_hit_client_region(item_hit)]
        for name in names:
            vision.clear_position_cache(name)
            self._verified_currency_templates.discard(name)
            hit = self._find_and_verify_currency_in_frame(
                vision,
                win,
                s,
                name,
                frame,
                excluded_regions,
            )
            if hit is None:
                self._log(
                    f"未能通过 Ctrl+C 核对{currency_label(name)}，"
                    "为避免误点已停止"
                )
                return False
            excluded_regions.append(_hit_client_region(hit))
        return True

    def _grab_workflow_frame_without_tooltip(
        self,
        vision: VisionService,
        win,
        s: AppSettings,
    ):
        """移开装备/通货悬浮窗后再截取通货搜索画面。"""

        neutral_x, neutral_y = win.center
        move_screen(neutral_x, neutral_y, settle_ms=20)
        if sleep_ms(max(250, s.action_delay_ms), self._should_stop):
            return None
        return vision.grab_window(win)

    def _find_and_verify_currency_in_frame(
        self,
        vision: VisionService,
        win,
        s: AppSettings,
        template_name: str,
        frame,
        base_excluded_regions: list[tuple[int, int, int, int]],
    ) -> Optional[MatchHit]:
        rejected_regions: list[tuple[int, int, int, int]] = []
        broad_scales = _workflow_currency_scales(win)
        expected_name = currency_label(template_name)
        verified_hits = [
            hit
            for name in self._verified_currency_templates
            if (hit := vision.get_cached_position(name)) is not None
        ]

        phases: list[
            tuple[
                str,
                tuple[float, ...],
                list[tuple[int, int, int, int]],
                int,
            ]
        ]
        if verified_hits:
            measured_size = float(median([hit.width for hit in verified_hits]))
            template_width = int(vision.get_template(template_name).shape[1])
            calibrated_scales = _workflow_currency_scales(
                win,
                verified_icon_size=measured_size,
                template_size=template_width,
            )
            panel_exclusions, panel_label = _workflow_currency_panel_exclusions(
                win,
                verified_hits,
            )
            self._log(
                f"{expected_name}按本次画面动态校准：图标约 {measured_size:g}px，"
                f"优先搜索{panel_label}（失败自动回退全屏/宽尺度）"
            )
            phases = [
                ("校准面板", calibrated_scales, panel_exclusions, 4),
                ("校准全屏", calibrated_scales, [], 1),
                ("宽尺度全屏", broad_scales, [], 1),
            ]
        else:
            phases = [("初始全屏", broad_scales, [], WORKFLOW_CURRENCY_VERIFY_ATTEMPTS)]

        verify_try = 0

        def verify_hit(hit: MatchHit, phase_name: str) -> bool:
            nonlocal verify_try
            verify_try += 1
            if hit.feature_matches is not None:
                metric_text = f"特征聚类={hit.feature_matches}"
            else:
                rmse_text = (
                    f"{hit.color_rmse:.1f}"
                    if hit.color_rmse is not None
                    else "-"
                )
                metric_text = f"色差={rmse_text}"
            self._log(
                f"{expected_name}候选 {verify_try}/"
                f"{WORKFLOW_CURRENCY_VERIFY_ATTEMPTS} [{phase_name}] "
                f"@({hit.screen_x},{hit.screen_y}) "
                f"尺寸={hit.width}x{hit.height} {metric_text}，"
                "正在 Ctrl+C 核对…"
            )
            copied_text = self._copy_hovered_text(hit, s)
            if copied_text is not None and expected_name in copied_text:
                vision.set_cached_position(template_name, hit)
                self._verified_currency_templates.add(template_name)
                self._log(
                    f"已验证{expected_name} @({hit.screen_x},{hit.screen_y})"
                )
                return True

            observed = "未复制到物品文本"
            if copied_text:
                observed = next(
                    (
                        line.strip()
                        for line in copied_text.splitlines()
                        if line.strip()
                    ),
                    observed,
                )
            self._log(f"候选不是{expected_name}：{observed}")
            return False

        # 已有经 Ctrl+C 验证的同画面图标时，优先用 SIFT 局部特征
        # 聚类。颜色相近的技能、装备或装饰不会形成一致的特征位移。
        feature_finder = getattr(vision, "feature_candidates_in_frame", None)
        if verified_hits and callable(feature_finder):
            try:
                feature_candidates = feature_finder(
                    win,
                    frame,
                    template_name,
                    target_width=int(round(measured_size)),
                    exclude_regions=(
                        list(base_excluded_regions) + panel_exclusions
                    ),
                    max_candidates=4,
                )
            except Exception as error:
                feature_candidates = []
                self._log(f"{expected_name}特征定位不可用，转入颜色回退：{error}")
            for hit in feature_candidates:
                if self._should_stop():
                    return None
                if verify_hit(hit, "SIFT特征"):
                    return hit
                rejected_regions.append(_hit_client_region(hit))
                if verify_try >= WORKFLOW_CURRENCY_VERIFY_ATTEMPTS:
                    return None

        for phase_name, scales, phase_exclusions, phase_budget in phases:
            for _ in range(phase_budget):
                if self._should_stop():
                    return None
                excluded_regions = (
                    list(base_excluded_regions)
                    + rejected_regions
                    + phase_exclusions
                )
                hit = vision.match_color_in_frame(
                    win,
                    frame,
                    template_name,
                    max_rmse=WORKFLOW_CURRENCY_MAX_RMSE,
                    scales=scales,
                    exclude_regions=excluded_regions,
                    cache_position=False,
                )
                if hit is None:
                    break
                if verify_hit(hit, phase_name):
                    return hit
                rejected_regions.append(_hit_client_region(hit))
                if verify_try >= WORKFLOW_CURRENCY_VERIFY_ATTEMPTS:
                    return None
        return None

    def _copy_hovered_text(
        self,
        hit: MatchHit,
        s: AppSettings,
    ) -> Optional[str]:
        """只悬停并 Ctrl+C，用于点击前核对通货名称。"""

        move_screen(hit.screen_x, hit.screen_y, settle_ms=20)
        if sleep_ms(max(120, s.action_delay_ms), self._should_stop):
            return None
        for copy_try in range(2):
            clear_clipboard()
            time.sleep(0.01)
            hotkey("ctrl", "c")
            copied = wait_clipboard_change(
                previous="",
                timeout_ms=max(300, min(s.clipboard_timeout_ms, 800)),
                poll_ms=max(10, min(30, s.clipboard_poll_ms)),
                reject_empty=True,
            )
            if copied is not None:
                return copied
            if copy_try == 0 and sleep_ms(100, self._should_stop):
                return None
        return None

    def _apply_currency_step(
        self,
        vision: VisionService,
        win,
        step: CraftStep,
        s: AppSettings,
    ) -> bool:
        # PoE 通货使用方式：右键所选通货，再左键目标装备。
        item_hit = vision.get_cached_position("item_slot")
        if item_hit is None:
            item_hit = vision.find_in_window(
                win,
                "item_slot",
                threshold=s.template_threshold,
            )
        if item_hit is None:
            return False
        item_region = _hit_client_region(item_hit)
        currency_hit = vision.get_cached_position(step.currency_template)
        if (
            currency_hit is None
            or step.currency_template not in self._verified_currency_templates
        ):
            vision.clear_position_cache(step.currency_template)
            self._verified_currency_templates.discard(step.currency_template)
            clean_frame = self._grab_workflow_frame_without_tooltip(
                vision,
                win,
                s,
            )
            if clean_frame is None:
                return False
            currency_hit = self._find_and_verify_currency_in_frame(
                vision,
                win,
                s,
                step.currency_template,
                clean_frame,
                [item_region],
            )
        if currency_hit is not None and _hit_center_in_region(
            currency_hit, item_region
        ):
            self._log(
                f"已拒绝{currency_label(step.currency_template)}匹配结果："
                "坐标落在目标装备区域内"
            )
            vision.clear_position_cache(step.currency_template)
            self._verified_currency_templates.discard(step.currency_template)
            currency_hit = None
        if currency_hit is None:
            return False

        # 只有确认通货与目标装备是两个不同区域后才会发送鼠标动作。
        click_screen(
            currency_hit.screen_x,
            currency_hit.screen_y,
            settle_ms=15,
            button="right",
        )

        if sleep_ms(
            max(WORKFLOW_CURRENCY_SELECT_DELAY_MS, s.action_delay_ms),
            self._should_stop,
        ):
            return False

        click_screen(
            item_hit.screen_x,
            item_hit.screen_y,
            settle_ms=15,
            button="left",
        )
        return True

    def _check_lifeforce(
        self, vision: VisionService, win, s: AppSettings
    ) -> Optional[MatchHit]:
        for stop_tpl in self.OPTIONAL_STOP_TEMPLATES:
            if not vision.template_path(stop_tpl).exists():
                continue
            hit = vision.find_in_window(win, stop_tpl, threshold=s.template_threshold)
            if hit is not None:
                return hit
        return None

    def _click_cached_or_match(
        self,
        vision: VisionService,
        win,
        template_name: str,
        s: AppSettings,
        force_rematch: bool = False,
        button: str = "left",
    ) -> bool:
        hit = None if force_rematch else vision.get_cached_position(template_name)
        if hit is None:
            try:
                hit = vision.find_in_window(
                    win, template_name, threshold=s.template_threshold
                )
            except VisionError as e:
                self._log(f"模板匹配错误 [{template_name}]: {e}")
                return False
        if hit is None:
            return False
        # 根据当前窗口原点修正缓存坐标（窗口未动时等价）
        # 缓存里已是绝对屏幕坐标；窗口移动时会清缓存，故直接点
        click_screen(hit.screen_x, hit.screen_y, settle_ms=15, button=button)
        return True

    def _finish(
        self,
        reason: StopReason,
        message: str,
        attempt: int,
        parse_failures: int,
        unchanged: int,
    ) -> None:
        self._log(f"结束: {reason.value} — {message}")
        self._update(
            running=False,
            stop_reason=reason,
            message=message,
            attempt=attempt,
            parse_failures=parse_failures,
            unchanged_streak=unchanged,
        )

    def _click_template(
        self,
        vision: VisionService,
        win,
        template_name: str,
        s: AppSettings,
    ) -> bool:
        return self._click_cached_or_match(
            vision, win, template_name, s, force_rematch=True
        )

    def _read_item_fast(self, vision: VisionService, win, s: AppSettings) -> Item:
        hit = vision.get_cached_position("item_slot")
        if hit is None:
            hit = vision.find_in_window(
                win, "item_slot", threshold=s.template_threshold
            )
        if hit is None:
            raise VisionError("未找到 item_slot.png（工艺槽物品区域）")

        move_screen(hit.screen_x, hit.screen_y, settle_ms=20)
        # 悬停稍等：过短游戏可能还没生成 tooltip
        hover_ms = max(40, min(120, s.action_delay_ms))
        if sleep_ms(hover_ms, self._should_stop):
            raise ItemParseError("读取被中止")

        clear_clipboard()
        time.sleep(0.01)
        hotkey("ctrl", "c")
        # 剪贴板超时默认偏长；快速模式用更短上限
        timeout = min(s.clipboard_timeout_ms, 800)
        text = wait_clipboard_change(
            previous="",
            timeout_ms=timeout,
            poll_ms=max(10, min(30, s.clipboard_poll_ms)),
            reject_empty=True,
        )
        if text is None:
            # 一次快速重试
            move_screen(hit.screen_x, hit.screen_y, settle_ms=20)
            time.sleep(0.05)
            clear_clipboard()
            hotkey("ctrl", "c")
            text = wait_clipboard_change(
                previous="",
                timeout_ms=timeout,
                poll_ms=max(10, min(30, s.clipboard_poll_ms)),
                reject_empty=True,
            )
        if text is None:
            raise ItemParseError(
                "等待剪贴板超时，请确认鼠标悬停在物品上且复制键为 Ctrl+C"
            )
        return parse_item_text(text)

    def _read_item(self, vision: VisionService, win, s: AppSettings) -> Item:
        return self._read_item_fast(vision, win, s)

    def read_item_once(self, settings: AppSettings) -> Item:
        vision = VisionService(
            settings.templates_dir,
            threshold=settings.template_threshold,
            search_scale=0.7,
            scales=(1.0,),
        )
        try:
            if not vision.template_path("item_slot").exists():
                raise VisionError("缺少模板 item_slot.png")
            win = find_game_window(settings.window_title_keywords)
            if win is None:
                raise VisionError("未找到游戏窗口")
            focus_window(win.hwnd, retries=3, settle_ms=50)
            # 单次读取仍匹配一次以填充缓存
            hit = vision.find_in_window(
                win, "item_slot", threshold=settings.template_threshold
            )
            if hit is None:
                raise VisionError("未找到 item_slot.png")
            return self._read_item_fast(vision, win, settings)
        finally:
            vision.close()
