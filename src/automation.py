from __future__ import annotations

import gc
import threading
import time
import traceback
from contextlib import contextmanager
from dataclasses import dataclass
from statistics import median
from typing import Callable, Iterator, Optional

from .clipboard_util import (
    clear_clipboard,
    get_clipboard,
    normalize_clipboard_text,
    wait_clipboard_change,
)
from .currencies import currency_label, currency_stack_count
from .input_control import (
    click_screen,
    find_game_window,
    focus_game_window,
    focus_window,
    get_cursor_handle,
    get_cursor_pos,
    hotkey,
    move_screen,
    peek_window,
    sleep_ms,
)
from .item_parser import ItemParseError, is_equipment_clipboard_text, parse_item_text
from .matcher import match_ruleset
from .timing import wait_until
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
from .vision import MatchHit, VisionError, VisionService, patch_rmse
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
LOCATE_CURRENCY_TRIES = 4
# 超时只防死等；热路径节奏由成功条件决定，不按本机估 delay。
COPY_TIMEOUT_MS = 280
COPY_SLICE_MS = 40
COPY_POLL_MS = 2
CURSOR_MS = 4
APPLY_CONFIRM_TRIES = 3
PUT_BACK_TRIES = 3
HOLD_CHECK_MS = 80
WINDOW_MOVE_PX = 12
TOOLTIP_CLEAR_MS = 80
CURSOR_ON_CURRENCY_RMSE = 18.0
CURSOR_CONFIRM_TIMEOUT_MS = 280


@contextmanager
def _pause_gc() -> Iterator[None]:
    gc.collect()
    was_enabled = gc.isenabled()
    gc.disable()
    try:
        yield
    finally:
        if was_enabled:
            gc.enable()


class CurrencyUnavailableError(RuntimeError):
    """所需通货的名称或剩余数量无法在点击前安全确认。"""


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


def _point_in_hit(x: int, y: int, hit: MatchHit) -> bool:
    half_w = hit.width // 2
    half_h = hit.height // 2
    return (
        hit.screen_x - half_w <= x < hit.screen_x - half_w + max(1, hit.width)
        and hit.screen_y - half_h <= y < hit.screen_y - half_h + max(1, hit.height)
    )


def _cursor_in_hit(hit: MatchHit) -> bool:
    x, y = get_cursor_pos()
    return _point_in_hit(x, y, hit)


def _cursor_unlike(a, b, limit: float = CURSOR_ON_CURRENCY_RMSE) -> bool:
    return a is not None and b is not None and patch_rmse(a, b) >= limit


def _hits_close(
    a: Optional[MatchHit],
    b: Optional[MatchHit],
    px: int = 8,
) -> bool:
    if a is None or b is None:
        return False
    return abs(a.screen_x - b.screen_x) <= px and abs(a.screen_y - b.screen_y) <= px


def _hit_half_cell(hit: MatchHit) -> float:
    return max(1.0, max(hit.width, hit.height) / 2.0)


def _currency_hit_conflict(hit: MatchHit, other: MatchHit) -> bool:
    """点击中心落在对方矩形内，或两中心近于半格。"""
    if _point_in_hit(hit.screen_x, hit.screen_y, other):
        return True
    if _point_in_hit(other.screen_x, other.screen_y, hit):
        return True
    half = max(_hit_half_cell(hit), _hit_half_cell(other))
    dx = hit.screen_x - other.screen_x
    dy = hit.screen_y - other.screen_y
    return dx * dx + dy * dy < half * half


def _currency_center_band(win) -> Optional[tuple[int, int, int, int]]:
    """左右仓库/背包之间的游戏世界，通货命中不能落在这里。"""
    width = int(getattr(win, "width", 0) or 0)
    height = int(getattr(win, "height", 0) or 0)
    if width <= 0 or height <= 0:
        return None
    panel_width = min(width, int(round(float(height) * 0.68)))
    left = panel_width
    right = width - panel_width
    if right <= left:
        return None
    return (left, 0, right, height)


def _is_currency_clipboard_text(text: str) -> bool:
    """通货 tooltip；排除空文本、未找到物品、装备。"""
    raw = (text or "").strip()
    if not raw or "未找到物品" in raw or raw.startswith("http"):
        return False
    if currency_stack_count(raw) is not None:
        return True
    return "通货" in raw or "Currency" in raw


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

    面板宽度按窗口高度计算，适配分辨率/UI 缩放；两侧都有时
    不限制面板，但仍排除窗口中心带，不会回退到全屏游戏世界。
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
    """增幅石只对恰好一条显式词缀的魔法物品执行。固有不计入。"""

    return (
        step.currency_template == "currency_augmentation"
        and item.craft_affix_count != 1
    )


@dataclass
class AutomationConfig:
    settings: AppSettings
    ruleset: RuleSet
    craft_mode: str
    workflow: Optional[CraftWorkflow] = None


class CraftAutomation:
    REQUIRED_TEMPLATES = ("craft_button", "item_slot")

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
        self._currency_stack_counts: dict[str, int] = {}
        self._last_hover_hit: Optional[MatchHit] = None
        self._currency_use_armed = False
        self._item_use_clicked = False
        self._item_pointer_patch = None
        self._item_pointer_handle: Optional[int] = None

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

    def _update(self, notify: bool = True, **kwargs) -> None:
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
                workflow_name=self._status.workflow_name,
            )
        if notify:
            self._on_status(snap)

    def _sync_game_window(self, win):
        """只查已有句柄是否还在、客户区是否移动。不枚举桌面、不抢焦点。"""
        win2 = peek_window(win.hwnd, getattr(win, "title", "") or "")
        if win2 is None:
            return None, False, "游戏窗口丢失"
        moved = (
            abs(win2.left - win.left) > WINDOW_MOVE_PX
            or abs(win2.top - win.top) > WINDOW_MOVE_PX
            or abs(win2.width - win.width) > WINDOW_MOVE_PX
            or abs(win2.height - win.height) > WINDOW_MOVE_PX
        )
        if moved:
            return win2, True, ""
        return win, False, ""

    def _relocate_workflow(
        self,
        vision,
        win,
        s: AppSettings,
        currency_names: list[str],
    ) -> str:
        """窗口移动后重定位装备与通货。成功返回空串。"""
        vision.clear_position_cache()
        self._verified_currency_templates.clear()
        self._currency_stack_counts.clear()
        self._last_hover_hit = None
        self._disarm_currency()
        self._reset_pointer_baselines()
        if not self._locate_workflow_required(vision, win, s, ["item_slot"]):
            return "窗口移动后目标装备重定位失败"
        item_hit = vision.get_cached_position("item_slot")
        if item_hit is not None:
            self._move_to_hit(item_hit)
            self._capture_item_pointer_baseline(vision)
        if currency_names and not self._locate_and_verify_workflow_currencies(
            vision, win, s, currency_names
        ):
            return "窗口移动后无法确认所需通货名称与数量"
        return ""

    def _relocate_required_if_moved(self, vision, win, s: AppSettings):
        """连续读失败时才查窗口；没移动立刻返回原窗口。"""
        win2, moved, lost = self._sync_game_window(win)
        if win2 is None:
            return None, lost or "游戏窗口丢失"
        if not moved:
            return win, ""
        self._log("连续读取失败且窗口已移动，重新匹配模板")
        vision.clear_position_cache()
        if not self._locate_required(vision, win2, s):
            return None, "窗口移动后模板重定位失败"
        focus_window(win2.hwnd, retries=1, settle_ms=20)
        return win2, ""

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
        self._currency_stack_counts.clear()
        self._last_hover_hit = None
        self._disarm_currency()
        self._reset_pointer_baselines()
        if config.workflow is None:
            self._finish(StopReason.ERROR, "未提供多步骤流程配置", 0, 0, 0)
            return

        # 使用启动时快照，避免运行中修改 GUI 影响当前状态机。
        workflow = CraftWorkflow.from_dict(config.workflow.to_dict())
        self._update(workflow_name=workflow.name)
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
                if isinstance(e, VisionError):
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
        if self._capture_item_pointer_baseline(vision):
            self._log("已采集装备格普通指针基线")
        else:
            self._log("未能采集装备格指针基线，未确认通货前不会左键")
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
                StopReason.CURRENCY_UNAVAILABLE,
                "未找到数量可确认的流程通货，未执行任何通货点击",
                0,
                0,
                0,
            )
            return

        item_hit = vision.get_cached_position("item_slot")
        if item_hit is not None:
            self._move_to_hit(item_hit)
            if self._capture_item_pointer_baseline(vision):
                self._log("已更新装备格普通指针基线")

        unchanged = 0
        current_item = initial_item
        last_raw = f"{initial_item.rarity}|" + "|".join(initial_item.affix_texts())
        last_action_step_id = ""
        currency_names = required[1:]

        with _pause_gc():
            self._run_workflow_loop(
                vision,
                win,
                s,
                workflow,
                current,
                current_item,
                last_raw,
                last_action_step_id,
                unchanged,
                parse_failures,
                currency_names,
            )

    def _run_workflow_loop(
        self,
        vision: VisionService,
        win,
        s: AppSettings,
        workflow: CraftWorkflow,
        current: CraftStep,
        current_item: Item,
        last_raw: str,
        last_action_step_id: str,
        unchanged: int,
        parse_failures: int,
        currency_names: list[str],
    ) -> None:
        reason = StopReason.MAX_ATTEMPTS
        message = f"已达最大动作数 {s.max_attempts}"
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
                notify=False,
                attempt=attempt,
                workflow_step_name=step.name,
                workflow_step_index=step_index,
                message=f"步骤 {step_index}: {step.name}",
            )

            t0 = time.perf_counter()
            item: Optional[Item] = None
            action_performed = not _should_skip_augmentation(step, current_item)
            if not action_performed:
                item = current_item
                self._log(
                    f"显式词缀={current_item.craft_affix_count}，跳过增幅"
                )
            else:
                item, win, stop_reason, stop_message = self._apply_until_new_item(
                    vision,
                    win,
                    step,
                    s,
                    current_item,
                    currency_names,
                )
                if stop_reason is not None:
                    reason = stop_reason
                    message = stop_message
                    if stop_message and stop_reason != StopReason.USER_STOP:
                        self._log(stop_message)
                    break
                if item is None:
                    if self._should_stop():
                        reason = StopReason.USER_STOP
                        message = "用户停止"
                        break
                    self._log("通货未确认，本轮不判定，继续")
                    self._wait_after_failed_use(vision)
                    continue
                parse_failures = 0

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
        logic = "OR" if config.ruleset.group_combine == "any" else "AND"
        self._log(
            f"开始自动化 | 模式={config.craft_mode} | 组间={logic} | 组数={len(config.ruleset.groups)} | 最大次数={s.max_attempts}"
        )
        self._log("视觉加速: 位置缓存 + 单尺度匹配 + 降采样搜索")

        missing = []
        for name in self.REQUIRED_TEMPLATES:
            if not vision.template_path(name).exists():
                missing.append(f"{name}.png")
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
        if not self._locate_required(vision, win, s):
            return

        parse_failures = 0
        unchanged = 0
        last_raw = ""
        with _pause_gc():
            reason, message, parse_failures, unchanged = self._run_generic_loop(
                config, vision, win, s, parse_failures, unchanged, last_raw
            )
        self._finish(reason, message, self._status.attempt, parse_failures, unchanged)

    def _run_generic_loop(
        self,
        config: AutomationConfig,
        vision: VisionService,
        win,
        s: AppSettings,
        parse_failures: int,
        unchanged: int,
        last_raw: str,
    ):
        reason = StopReason.MAX_ATTEMPTS
        message = "达到最大尝试次数"
        for attempt in range(1, s.max_attempts + 1):
            if self._should_stop():
                reason = StopReason.USER_STOP
                message = "用户停止"
                break

            self._update(notify=False, attempt=attempt, message=f"第 {attempt} 次工艺")
            t0 = time.perf_counter()

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
                self._update(parse_failures=parse_failures)
                if parse_failures >= 2:
                    win2, relocate_error = self._relocate_required_if_moved(
                        vision, win, s
                    )
                    if relocate_error:
                        reason = (
                            StopReason.WINDOW_NOT_FOUND
                            if win2 is None
                            else StopReason.TEMPLATE_NOT_FOUND
                        )
                        message = relocate_error
                        break
                    win = win2
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
                if parse_failures >= 2:
                    win2, relocate_error = self._relocate_required_if_moved(
                        vision, win, s
                    )
                    if relocate_error:
                        reason = (
                            StopReason.WINDOW_NOT_FOUND
                            if win2 is None
                            else StopReason.TEMPLATE_NOT_FOUND
                        )
                        message = relocate_error
                        break
                    win = win2
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

        return reason, message, parse_failures, unchanged

    def _locate_required(
        self,
        vision: VisionService,
        win,
        s: AppSettings,
    ) -> bool:
        names = ["craft_button", "item_slot"]
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
        excluded_regions = [_hit_client_region(item_hit)]
        for name in names:
            hit = self._find_verified_currency(
                vision, win, s, name, excluded_regions
            )
            if hit is None:
                self._log(
                    f"未能通过 Ctrl+C 核对{currency_label(name)}，"
                    "为避免误点已停止"
                )
                return False
            excluded_regions.append(_hit_client_region(hit))
        return True

    def _find_verified_currency(
        self,
        vision: VisionService,
        win,
        s: AppSettings,
        template_name: str,
        excluded_regions: list[tuple[int, int, int, int]],
        allow_item_slot: bool = False,
    ) -> Optional[MatchHit]:
        """悬停 + Ctrl+C 核对名称和数量。失败则清缓存、再截图重试。"""
        expected = currency_label(template_name)
        for attempt in range(1, LOCATE_CURRENCY_TRIES + 1):
            if self._should_stop():
                return None
            vision.clear_position_cache(template_name)
            self._verified_currency_templates.discard(template_name)
            self._currency_stack_counts.pop(template_name, None)
            # 选中前禁止去装备格；通货已挂上时禁止去其它堆叠。
            park = self._safe_park_hit(
                vision,
                allow_item_slot=allow_item_slot and not self._currency_use_armed,
                allow_other_currency=not self._currency_use_armed,
            )
            frame = self._grab_workflow_frame_without_tooltip(
                vision, win, s, park
            )
            if frame is None:
                return None
            hit = self._find_and_verify_currency_in_frame(
                vision,
                win,
                s,
                template_name,
                frame,
                excluded_regions,
            )
            if hit is not None:
                return hit
            if attempt < LOCATE_CURRENCY_TRIES:
                self._log(
                    f"未能核对{expected}（{attempt}/{LOCATE_CURRENCY_TRIES}），"
                    "清缓存并重新截图后再试"
                )
        return None

    def _safe_park_hit(
        self,
        vision: VisionService,
        *,
        avoid_hit: Optional[MatchHit] = None,
        allow_item_slot: bool = False,
        allow_other_currency: bool = True,
    ) -> Optional[MatchHit]:
        """另一个已确认安全点。通货挂在光标上时只能去装备格或原地。"""
        avoid = avoid_hit if avoid_hit is not None else self._last_hover_hit
        if self._currency_use_armed:
            allow_other_currency = False
        if allow_other_currency:
            for name in self._verified_currency_templates:
                hit = vision.get_cached_position(name)
                if hit is not None and not _hits_close(hit, avoid):
                    return hit
        if allow_item_slot:
            hit = vision.get_cached_position("item_slot")
            if hit is not None and not _hits_close(hit, avoid):
                return hit
        return None

    def _grab_workflow_frame_without_tooltip(
        self,
        vision: VisionService,
        win,
        s: AppSettings,
        park_hit: Optional[MatchHit] = None,
    ):
        """清 tooltip 后再截图。只移到另一个安全点，没有则原地截。"""
        if park_hit is not None and not _hits_close(park_hit, self._last_hover_hit):
            move_screen(park_hit.screen_x, park_hit.screen_y, settle_ms=20)
            self._last_hover_hit = park_hit
            if sleep_ms(TOOLTIP_CLEAR_MS, self._should_stop):
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
        item_hit = vision.get_cached_position("item_slot")
        item_region = _hit_client_region(item_hit) if item_hit else None
        center_band = _currency_center_band(win)
        ui_exclusions = [center_band] if center_band else []
        panel_exclusions: list[tuple[int, int, int, int]] = []
        measured_size = 0.0

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
                f"只搜{panel_label}侧栏"
            )
            phases = [
                ("校准侧栏", calibrated_scales, panel_exclusions + ui_exclusions, 4),
            ]
        else:
            phases = [
                ("侧栏", broad_scales, ui_exclusions, WORKFLOW_CURRENCY_VERIFY_ATTEMPTS),
            ]

        verify_try = 0

        def hit_in_ui(hit: MatchHit) -> bool:
            if item_region is not None and _hit_center_in_region(hit, item_region):
                self._log(f"{expected_name}候选落在装备格内，不悬停")
                return False
            if center_band is not None and _hit_center_in_region(hit, center_band):
                self._log(
                    f"{expected_name}候选 @({hit.screen_x},{hit.screen_y}) "
                    "在窗口中心带，不悬停"
                )
                return False
            other_name = self._conflicting_currency_name(vision, hit, template_name)
            if other_name is not None:
                self._log(
                    f"{expected_name}候选与已核实{currency_label(other_name)}"
                    "中心过近或重叠，排除"
                )
                return False
            return True

        def verify_hit(hit: MatchHit, phase_name: str) -> bool:
            nonlocal verify_try
            if not hit_in_ui(hit):
                return False
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
            copied_text = self._copy_hovered_text(vision, hit, s)
            if copied_text is None:
                self._log(
                    f"候选未能复制到{expected_name}文本，将尝试其他位置"
                )
                return False
            if expected_name in copied_text:
                remaining = currency_stack_count(copied_text)
                if remaining is None:
                    self._log(
                        f"候选是{expected_name}，但未识别到堆叠数量；"
                        "为避免误点已拒绝"
                    )
                    return False
                if remaining <= 0:
                    self._log(f"{expected_name}堆叠数量为 0，已拒绝")
                    return False
                vision.set_cached_position(template_name, hit)
                self._verified_currency_templates.add(template_name)
                self._currency_stack_counts[template_name] = remaining
                self._log(
                    f"已验证{expected_name} @({hit.screen_x},{hit.screen_y}) "
                    f"| 剩余={remaining}"
                )
                return True

            observed = next(
                (
                    line.strip()
                    for line in copied_text.splitlines()
                    if line.strip()
                ),
                "未复制到物品文本",
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
                        list(base_excluded_regions)
                        + panel_exclusions
                        + ui_exclusions
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

    def _conflicting_currency_name(
        self,
        vision: VisionService,
        hit: MatchHit,
        template_name: str,
    ) -> Optional[str]:
        for name in self._verified_currency_templates:
            if name == template_name:
                continue
            other = vision.get_cached_position(name)
            if other is not None and _currency_hit_conflict(hit, other):
                return name
        return None

    def _disarm_currency(self) -> None:
        self._currency_use_armed = False
        self._item_use_clicked = False

    def _reset_pointer_baselines(self) -> None:
        self._item_pointer_patch = None
        self._item_pointer_handle = None

    def _refund_currency(self, template_name: str) -> None:
        remaining = self._currency_stack_counts.get(template_name)
        if remaining is not None:
            self._currency_stack_counts[template_name] = remaining + 1

    def _confirm_currency_spent(self, vision: VisionService, template_name: str) -> None:
        if self._currency_stack_counts.get(template_name, 1) > 0:
            return
        vision.clear_position_cache(template_name)
        self._verified_currency_templates.discard(template_name)
        self._log(
            f"已使用当前堆叠最后 1 个{currency_label(template_name)}；"
            "后续再次需要时将自动检查并停止"
        )

    def _move_to_hit(self, hit: MatchHit) -> None:
        move_screen(hit.screen_x, hit.screen_y, settle_ms=CURSOR_MS)
        self._last_hover_hit = hit

    def _click_item_slot_left(self, hit: MatchHit) -> None:
        """仅「使用」或「确认拾取后的放回」可对装备格左键。"""
        click_screen(hit.screen_x, hit.screen_y, settle_ms=CURSOR_MS, button="left")
        self._last_hover_hit = hit

    def _put_item_back(
        self,
        vision: VisionService,
        item_hit: Optional[MatchHit] = None,
    ) -> None:
        hit = item_hit or vision.get_cached_position("item_slot")
        if hit is None:
            return
        self._disarm_currency()
        self._click_item_slot_left(hit)

    def _is_wrong_item(self, before: Item, after: Item) -> bool:
        return bool(
            before.base_type and after.base_type and before.base_type != after.base_type
        )

    def _same_item_text(self, before: Item, after: Item) -> bool:
        return normalize_clipboard_text(before.raw_text) == normalize_clipboard_text(
            after.raw_text
        )

    def _try_read_item(
        self,
        vision: VisionService,
        win,
        s: AppSettings,
        already_on_item: bool = False,
        timeout_ms: int = COPY_TIMEOUT_MS,
    ) -> Optional[Item]:
        """读当前格子装备，接受旧文本。超时/未刷新返回 None；真解析失败抛出。"""
        try:
            item = self._read_item_fast(
                vision,
                win,
                s,
                already_on_item=already_on_item,
                stale_text="",
                timeout_ms=timeout_ms,
            )
        except ItemParseError as error:
            message = str(error)
            if "等待剪贴板超时" in message or "未读到通货" in message:
                return None
            if "词缀尚未刷新" in message:
                return None
            raise
        if item.rarity in {"魔法", "稀有"} and not item.affixes:
            return None
        return item

    def _holding_item(
        self,
        vision: VisionService,
        item_hit: MatchHit,
        s: AppSettings,
    ) -> bool:
        """通货堆叠上重新 Ctrl+C 得到装备文本，才视为拿在手上。旧剪贴板不算。"""
        park = self._safe_park_hit(
            vision,
            avoid_hit=item_hit,
            allow_item_slot=False,
            allow_other_currency=True,
        )
        if park is None:
            for name in self._verified_currency_templates:
                hit = vision.get_cached_position(name)
                if hit is not None and not _hits_close(hit, item_hit):
                    park = hit
                    break
        if park is None:
            return False
        self._move_to_hit(park)
        clear_clipboard()
        leftover = normalize_clipboard_text(get_clipboard())
        if leftover and is_equipment_clipboard_text(leftover):
            return False
        text = self._copy_item_text(
            s,
            timeout_ms=max(HOLD_CHECK_MS, COPY_TIMEOUT_MS),
            require_item=True,
            stale_text=leftover,
        )
        return bool(text)

    def _item_in_slot(
        self,
        vision: VisionService,
        win,
        s: AppSettings,
        before: Item,
        already_on_item: bool,
    ) -> Optional[Item]:
        try:
            item = self._try_read_item(
                vision, win, s, already_on_item=already_on_item
            )
        except (ItemParseError, VisionError):
            return None
        if item is None or self._is_wrong_item(before, item):
            return None
        item_hit = vision.get_cached_position("item_slot")
        if item_hit is not None and self._holding_item(vision, item_hit, s):
            return None
        return item

    def _can_put_item_back(
        self,
        vision: VisionService,
        win,
        s: AppSettings,
        item_hit: Optional[MatchHit],
    ) -> bool:
        """通货上新复制到装备，或已离开格子后模板消失。旧剪贴板不算。"""
        if item_hit is not None and self._holding_item(vision, item_hit, s):
            return True
        if item_hit is not None and _cursor_in_hit(item_hit):
            return False
        try:
            live = vision.find_in_window(
                win, "item_slot", threshold=s.template_threshold
            )
        except VisionError:
            live = None
        return live is None

    def _recover_picked_item(
        self,
        vision: VisionService,
        win,
        s: AppSettings,
        before: Item,
    ) -> Optional[Item]:
        """确认拿在手上或格子已空后再左键放回。"""
        item_hit = vision.get_cached_position("item_slot")
        slotted = self._item_in_slot(
            vision, win, s, before, already_on_item=item_hit is not None
        )
        if slotted is not None:
            return slotted
        if item_hit is None or not self._can_put_item_back(vision, win, s, item_hit):
            return None
        for put_try in range(1, PUT_BACK_TRIES + 1):
            if self._should_stop():
                return None
            self._log(f"放回装备 ({put_try}/{PUT_BACK_TRIES})")
            self._put_item_back(vision, item_hit)
            slotted = self._item_in_slot(vision, win, s, before, already_on_item=True)
            if slotted is not None:
                return slotted
            slotted = self._item_in_slot(vision, win, s, before, already_on_item=False)
            if slotted is not None:
                return slotted
            if not self._can_put_item_back(vision, win, s, item_hit):
                return None
        return None

    def _read_after_currency(
        self,
        vision: VisionService,
        win,
        s: AppSettings,
        before: Item,
    ) -> tuple[str, Optional[Item]]:
        """左键后留在装备格 Ctrl+C。等到新文本，或确认旧文本/读不到。"""
        item_hit = vision.get_cached_position("item_slot")
        wait_ms = max(COPY_TIMEOUT_MS, int(s.craft_wait_ms))
        try:
            fresh = self._read_item_fast(
                vision,
                win,
                s,
                already_on_item=True,
                stale_text=before.raw_text,
                timeout_ms=wait_ms,
            )
            if not self._is_wrong_item(before, fresh):
                return "new", fresh
        except ItemParseError as error:
            message = str(error)
            if "等待剪贴板超时" not in message and "未读到通货" not in message:
                if "词缀尚未刷新" not in message:
                    return "parse", None
        except VisionError:
            pass

        try:
            item = self._try_read_item(vision, win, s, already_on_item=True)
        except ItemParseError:
            return "parse", None
        except VisionError:
            item = None

        if item is not None and not self._is_wrong_item(before, item):
            if not self._same_item_text(before, item):
                return "new", item
            if item_hit is not None and self._holding_item(vision, item_hit, s):
                return "pickup", self._recover_picked_item(vision, win, s, before)
            return "stale", item

        if self._can_put_item_back(vision, win, s, item_hit):
            return "pickup", self._recover_picked_item(vision, win, s, before)
        return "pickup", None

    def _apply_until_new_item(
        self,
        vision: VisionService,
        win,
        step: CraftStep,
        s: AppSettings,
        before: Item,
        currency_names: list[str],
    ) -> tuple[Optional[Item], object, Optional[StopReason], str]:
        """右键通货→装备格确认光标→左键，直到读到新装备。旧文本不判定。"""
        template_name = step.currency_template
        parse_failures = 0
        need_recover = False
        for apply_try in range(1, APPLY_CONFIRM_TRIES + 1):
            if self._should_stop():
                return None, win, StopReason.USER_STOP, "用户停止"
            if need_recover:
                recovered = self._recover_picked_item(vision, win, s, before)
                if recovered is None:
                    continue
                need_recover = False
                self._capture_item_pointer_baseline(vision)
            try:
                kind, read_item = self._use_currency_on_item(
                    vision, win, step, s, before
                )
            except CurrencyUnavailableError as error:
                self._disarm_currency()
                return None, win, StopReason.CURRENCY_UNAVAILABLE, str(error)
            if self._should_stop() or kind == "stop":
                return None, win, StopReason.USER_STOP, "用户停止"
            if kind == "no_select":
                self._disarm_currency()
                self._log("堆叠名称未核对，回到本步通货再右键")
                continue
            if kind == "like_pointer":
                self._disarm_currency()
                self._log("装备格光标仍像普通指针，不左键，回到堆叠再右键")
                continue
            if kind == "no_click":
                self._disarm_currency()
                self._log("未停在装备格内，不左键，回到堆叠再右键")
                continue
            if kind == "new" and read_item is not None:
                self._disarm_currency()
                self._capture_item_pointer_baseline(vision)
                self._confirm_currency_spent(vision, template_name)
                return read_item, win, None, ""
            if kind == "parse":
                parse_failures += 1
                self._update(parse_failures=parse_failures)
                self._log(
                    f"剪贴板无法解析为物品 ({parse_failures}/{s.max_parse_failures})"
                )
                if parse_failures >= s.max_parse_failures:
                    self._disarm_currency()
                    return (
                        None,
                        win,
                        StopReason.PARSE_FAILURES,
                        "连续解析失败次数过多",
                    )
                continue
            self._refund_currency(template_name)
            self._disarm_currency()
            if kind == "pickup":
                self._log(
                    "检测到拾取，已放回"
                    if read_item
                    else "检测到拾取，无铁证不左键放回"
                )
                if read_item is None:
                    need_recover = True
                    win2, moved, lost = self._sync_game_window(win)
                    if win2 is None:
                        return None, win, StopReason.WINDOW_NOT_FOUND, lost or "游戏窗口丢失"
                    if moved:
                        self._log("拾取恢复前发现窗口已移动，重新定位")
                        win = win2
                        relocate_error = self._relocate_workflow(
                            vision, win, s, currency_names
                        )
                        if relocate_error:
                            return None, win, StopReason.TEMPLATE_NOT_FOUND, relocate_error
            else:
                self._log("通货未生效，装备仍在格子，不左键，回到堆叠再右键")
        return None, win, None, ""

    def _copy_hovered_text(
        self,
        vision: VisionService,
        hit: MatchHit,
        s: AppSettings,
    ) -> Optional[str]:
        """移到堆叠中心再 Ctrl+C。不在堆叠上采指针基线。"""
        self._move_to_hit(hit)
        return self._copy_item_text(
            s, timeout_ms=COPY_TIMEOUT_MS, require_currency=True
        )

    def _clear_currency_hit(self, vision: VisionService, template_name: str) -> None:
        vision.clear_position_cache(template_name)
        self._verified_currency_templates.discard(template_name)
        self._currency_stack_counts.pop(template_name, None)

    def _resolve_item_hit(self, vision: VisionService, win, s: AppSettings):
        item_hit = vision.get_cached_position("item_slot")
        if item_hit is None:
            item_hit = vision.find_in_window(
                win,
                "item_slot",
                threshold=s.template_threshold,
            )
        return item_hit

    def _usable_step_currency_hit(
        self,
        vision: VisionService,
        template_name: str,
        item_region: tuple[int, int, int, int],
    ) -> Optional[MatchHit]:
        if template_name not in self._verified_currency_templates:
            return None
        hit = vision.get_cached_position(template_name)
        if hit is None:
            return None
        if _hit_center_in_region(hit, item_region):
            return None
        if self._conflicting_currency_name(vision, hit, template_name):
            return None
        return hit

    def _select_step_currency(
        self,
        vision: VisionService,
        win,
        step: CraftStep,
        s: AppSettings,
    ) -> bool:
        """只在本步通货上：Ctrl+C 核对名字 → 右键一次。不在堆叠上判定选中。"""
        item_hit = self._resolve_item_hit(vision, win, s)
        if item_hit is None:
            return False
        item_region = _hit_client_region(item_hit)
        template_name = step.currency_template
        expected_name = currency_label(template_name)
        excluded = [item_region]
        currency_hit = self._usable_step_currency_hit(
            vision, template_name, item_region
        )
        if currency_hit is None:
            currency_hit = self._find_verified_currency(
                vision,
                win,
                s,
                template_name,
                excluded,
                allow_item_slot=False,
            )
        if currency_hit is not None and (
            _hit_center_in_region(currency_hit, item_region)
            or self._conflicting_currency_name(vision, currency_hit, template_name)
        ):
            conflict = self._conflicting_currency_name(
                vision, currency_hit, template_name
            )
            reason = (
                f"与已核实{currency_label(conflict)}中心过近"
                if conflict
                else "坐标落在目标装备区域内"
            )
            self._log(f"已拒绝{expected_name}匹配结果：{reason}")
            self._clear_currency_hit(vision, template_name)
            excluded = [item_region]
            if conflict:
                other = vision.get_cached_position(conflict)
                if other is not None:
                    excluded.append(_hit_client_region(other))
            currency_hit = self._find_verified_currency(
                vision,
                win,
                s,
                template_name,
                excluded,
                allow_item_slot=False,
            )
        if currency_hit is None:
            if self._should_stop():
                return False
            raise CurrencyUnavailableError(
                f"没有找到可用的{expected_name}：可能已用完或已移出可见区域"
            )

        copied_text = self._copy_hovered_text(vision, currency_hit, s)
        if copied_text is None or expected_name not in copied_text:
            self._log(f"堆叠上不是{expected_name}，不右键，重新查找")
            excluded = [item_region, _hit_client_region(currency_hit)]
            self._clear_currency_hit(vision, template_name)
            currency_hit = self._find_verified_currency(
                vision,
                win,
                s,
                template_name,
                excluded,
                allow_item_slot=False,
            )
            if currency_hit is None:
                if self._should_stop():
                    return False
                raise CurrencyUnavailableError(
                    f"没有找到可用的{expected_name}：可能已用完或已移出可见区域"
                )
            copied_text = self._copy_hovered_text(vision, currency_hit, s)
            if copied_text is None or expected_name not in copied_text:
                self._log(f"再次核对仍不是{expected_name}，本轮不右键")
                return False

        remaining = currency_stack_count(copied_text)
        if remaining is None or remaining <= 0:
            if self._should_stop():
                return False
            self._log(
                f"{expected_name}原位置已空或数量无法确认，正在查找其他堆叠…"
            )
            excluded = [item_region, _hit_client_region(currency_hit)]
            currency_hit = self._find_verified_currency(
                vision,
                win,
                s,
                template_name,
                excluded,
                allow_item_slot=False,
            )
            remaining = self._currency_stack_counts.get(template_name)
            if currency_hit is None or remaining is None or remaining <= 0:
                if self._should_stop():
                    return False
                raise CurrencyUnavailableError(
                    f"{expected_name}已用完，或当前画面中没有数量可确认的堆叠"
                )
            copied_text = self._copy_hovered_text(vision, currency_hit, s)
            if copied_text is None or expected_name not in copied_text:
                self._log(f"新堆叠不是{expected_name}，本轮不右键")
                return False
            remaining = currency_stack_count(copied_text) or remaining
            if remaining <= 0:
                raise CurrencyUnavailableError(
                    f"{expected_name}已用完，或当前画面中没有数量可确认的堆叠"
                )

        self._currency_stack_counts[template_name] = remaining
        if remaining <= 5 or remaining % 100 == 0:
            self._log(f"{expected_name}使用前剩余={remaining}")

        if not self._right_click_currency_stack(currency_hit):
            self._disarm_currency()
            return False
        self._currency_use_armed = True
        self._item_use_clicked = False
        return True

    def _use_currency_on_item(
        self,
        vision: VisionService,
        win,
        step: CraftStep,
        s: AppSettings,
        before: Item,
    ) -> tuple[str, Optional[Item]]:
        """一次使用：堆叠右键 → 只 move 到装备格 → 不像指针才左键 → 读新文本。"""
        if not self._item_use_clicked:
            if not self._select_step_currency(vision, win, step, s):
                return "no_select", None
            item_hit = self._resolve_item_hit(vision, win, s)
            if item_hit is None:
                return "no_click", None
            click_kind = self._left_click_item_use(vision, item_hit)
            if click_kind != "ok":
                return click_kind, None
            self._item_use_clicked = True
            remaining = self._currency_stack_counts.get(step.currency_template)
            if remaining is not None:
                self._currency_stack_counts[step.currency_template] = remaining - 1
        return self._read_after_currency(vision, win, s, before)

    def _apply_currency_step(
        self,
        vision: VisionService,
        win,
        step: CraftStep,
        s: AppSettings,
    ) -> bool:
        """兼容入口：选中本步通货并左键装备。"""
        if not self._select_step_currency(vision, win, step, s):
            return False
        item_hit = self._resolve_item_hit(vision, win, s)
        if item_hit is None:
            self._disarm_currency()
            return False
        click_kind = self._left_click_item_use(vision, item_hit)
        if click_kind != "ok":
            self._disarm_currency()
            return False
        self._item_use_clicked = True
        remaining = self._currency_stack_counts.get(step.currency_template)
        if remaining is not None:
            self._currency_stack_counts[step.currency_template] = remaining - 1
        return True

    def _capture_item_pointer_baseline(self, vision: VisionService) -> bool:
        """装备格、未选通货时的普通指针。之后左键只和这张比。"""
        item_hit = vision.get_cached_position("item_slot")
        if item_hit is None or not _cursor_in_hit(item_hit):
            return False
        handle = get_cursor_handle()
        patch = vision.capture_cursor_patch()
        if handle is None and patch is None:
            return False
        self._item_pointer_handle = handle
        self._item_pointer_patch = patch
        return True

    def _item_cursor_holds_currency(self, vision: VisionService) -> bool:
        """装备格上相对启动指针基线：块明显不同或 hCursor 变了。"""
        handle = get_cursor_handle()
        patch = vision.capture_cursor_patch()
        handle_changed = (
            self._item_pointer_handle is not None
            and handle is not None
            and handle != self._item_pointer_handle
        )
        return handle_changed or _cursor_unlike(self._item_pointer_patch, patch)

    def _wait_after_failed_use(self, vision: VisionService) -> None:
        """失败后停一个确认窗口，避免紧接着空转下一轮。"""
        sleep_ms(CURSOR_CONFIRM_TIMEOUT_MS, self._should_stop)

    def _right_click_currency_stack(self, stack_hit: MatchHit) -> bool:
        """只在已核实堆叠上右键一次。不在这里判定是否挂上。"""
        self._move_to_hit(stack_hit)
        if not _cursor_in_hit(stack_hit):
            self._log("未能停在已核实通货堆叠上，本轮不右键")
            return False
        click_screen(
            stack_hit.screen_x,
            stack_hit.screen_y,
            settle_ms=CURSOR_MS,
            button="right",
        )
        self._last_hover_hit = stack_hit
        return True

    def _left_click_item_use(
        self,
        vision: VisionService,
        item_hit: MatchHit,
    ) -> str:
        """只 move 到装备格；和指针基线不像才左键一次。"""
        if not self._currency_use_armed:
            return "no_select"
        if self._item_pointer_patch is None and self._item_pointer_handle is None:
            self._log("没有装备格指针基线，不左键")
            return "like_pointer"
        if self._conflicting_currency_name(vision, item_hit, ""):
            self._log("装备格坐标落在通货区域，不左键")
            return "no_click"
        self._move_to_hit(item_hit)
        if not wait_until(
            lambda: _cursor_in_hit(item_hit),
            CURSOR_CONFIRM_TIMEOUT_MS,
            poll_ms=20,
            should_stop=self._should_stop,
        ):
            self._log("未能停在装备格内，本轮不左键")
            return "no_click"
        x, y = get_cursor_pos()
        for name in self._verified_currency_templates:
            other = vision.get_cached_position(name)
            if other is not None and _point_in_hit(x, y, other):
                self._log("光标仍在通货堆叠上，不左键")
                return "no_click"
        stable = [0]

        def holds_currency() -> bool:
            if not _cursor_in_hit(item_hit):
                stable[0] = 0
                return False
            if self._item_cursor_holds_currency(vision):
                stable[0] += 1
                return stable[0] >= 2
            stable[0] = 0
            return False

        if not wait_until(
            holds_currency,
            CURSOR_CONFIRM_TIMEOUT_MS,
            poll_ms=20,
            should_stop=self._should_stop,
        ):
            return "like_pointer"
        self._click_item_slot_left(item_hit)
        return "ok"

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
        if template_name == "item_slot":
            self._log("item_slot 只能在使用或确认放回时左键，已拒绝通用点击")
            return False
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

    def _copy_item_text(
        self,
        _s: AppSettings,
        timeout_ms: int,
        stale_text: str = "",
        require_item: bool = False,
        require_currency: bool = False,
    ) -> Optional[str]:
        """轮询直到剪贴板出现有效文本；传入 stale_text 时拒绝旧装备。"""
        stale = normalize_clipboard_text(stale_text)
        reject_texts = (stale,) if stale else ()
        clear_clipboard()
        previous = ""
        found: list[str] = []
        deadline = time.monotonic() + max(1, timeout_ms) / 1000.0

        def pred() -> bool:
            nonlocal previous
            remain_ms = int((deadline - time.monotonic()) * 1000)
            if remain_ms <= 0:
                return False
            hotkey("ctrl", "c")
            text = wait_clipboard_change(
                previous=previous,
                timeout_ms=min(COPY_SLICE_MS, remain_ms),
                poll_ms=COPY_POLL_MS,
                reject_empty=True,
                reject_texts=reject_texts,
            )
            if not text:
                return False
            if require_currency:
                if not _is_currency_clipboard_text(text):
                    previous = normalize_clipboard_text(text)
                    return False
            elif require_item:
                if not is_equipment_clipboard_text(text):
                    previous = normalize_clipboard_text(text)
                    return False
                try:
                    parsed = parse_item_text(text)
                except ItemParseError:
                    previous = normalize_clipboard_text(text)
                    return False
                if parsed.rarity in {"魔法", "稀有"} and not parsed.affixes:
                    previous = normalize_clipboard_text(text)
                    return False
            found.append(text)
            return True

        if wait_until(
            pred,
            timeout_ms,
            poll_ms=COPY_POLL_MS,
            should_stop=self._should_stop,
        ):
            return found[0] if found else None
        return None

    def _read_item_fast(
        self,
        vision: VisionService,
        win,
        s: AppSettings,
        already_on_item: bool = False,
        stale_text: str = "",
        timeout_ms: int = COPY_TIMEOUT_MS,
    ) -> Item:
        hit = vision.get_cached_position("item_slot")
        if hit is None:
            already_on_item = False
            hit = vision.find_in_window(
                win, "item_slot", threshold=s.template_threshold
            )
        if hit is None:
            raise VisionError("未找到 item_slot.png（工艺槽物品区域）")

        if not already_on_item:
            self._move_to_hit(hit)
        else:
            self._last_hover_hit = hit

        text = self._copy_item_text(
            s,
            timeout_ms=timeout_ms,
            stale_text=stale_text,
            require_item=True,
        )
        if text is None:
            raise ItemParseError(
                "未读到通货动作后的新物品文本"
                if stale_text
                else "等待剪贴板超时，请确认鼠标悬停在物品上且复制键为 Ctrl+C"
            )
        item = parse_item_text(text)
        if item.rarity in {"魔法", "稀有"} and not item.affixes:
            raise ItemParseError("物品词缀尚未刷新")
        return item

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
