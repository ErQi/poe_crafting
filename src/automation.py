from __future__ import annotations

import threading
import time
import traceback
from dataclasses import dataclass
from typing import Callable, Optional

from .clipboard_util import clear_clipboard, get_clipboard, wait_clipboard_change
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
    Item,
    MatchResult,
    RuleSet,
    RunStatus,
    StopReason,
)
from .vision import MatchHit, VisionError, VisionService


LogFn = Callable[[str], None]
StatusFn = Callable[[RunStatus], None]


@dataclass
class AutomationConfig:
    settings: AppSettings
    ruleset: RuleSet
    craft_mode: str
    craft_preset: str


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
        vision = VisionService(
            s.templates_dir,
            threshold=s.template_threshold,
            search_scale=0.7,
            scales=(1.0,),
        )
        try:
            self._run_with_vision(config, vision)
        finally:
            vision.close()

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
        click_screen(hit.screen_x, hit.screen_y, settle_ms=15)
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
            hit = vision.find_in_window(win, "item_slot", threshold=s.template_threshold)
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
            hit = vision.find_in_window(win, "item_slot", threshold=settings.template_threshold)
            if hit is None:
                raise VisionError("未找到 item_slot.png")
            return self._read_item_fast(vision, win, settings)
        finally:
            vision.close()
