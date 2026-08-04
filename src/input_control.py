from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, Optional

try:
    import win32api
    import win32con
    import win32gui
    import win32process
except ImportError:  # 非 Windows 开发时降级
    win32api = None  # type: ignore
    win32con = None  # type: ignore
    win32gui = None  # type: ignore
    win32process = None  # type: ignore

try:
    import pydirectinput

    pydirectinput.PAUSE = 0.02
    pydirectinput.FAILSAFE = False
except ImportError:
    pydirectinput = None  # type: ignore


@dataclass
class WindowInfo:
    hwnd: int
    title: str
    left: int
    top: int
    right: int
    bottom: int

    @property
    def width(self) -> int:
        return max(0, self.right - self.left)

    @property
    def height(self) -> int:
        return max(0, self.bottom - self.top)

    @property
    def center(self) -> tuple[int, int]:
        return (self.left + self.width // 2, self.top + self.height // 2)


def find_game_window(keywords: list[str]) -> Optional[WindowInfo]:
    if win32gui is None:
        return None

    keywords_raw = [k for k in keywords if k]
    found: list[WindowInfo] = []

    def _enum(hwnd: int, _extra: object) -> None:
        if not win32gui.IsWindowVisible(hwnd):
            return
        title = win32gui.GetWindowText(hwnd) or ""
        if not title:
            return
        tl = title.lower()
        matched = False
        for k in keywords_raw:
            if k.lower() in tl or k in title:
                matched = True
                break
        if not matched:
            return
        try:
            rect = win32gui.GetClientRect(hwnd)
            left_top = win32gui.ClientToScreen(hwnd, (rect[0], rect[1]))
            right_bottom = win32gui.ClientToScreen(hwnd, (rect[2], rect[3]))
            info = WindowInfo(
                hwnd=hwnd,
                title=title,
                left=left_top[0],
                top=left_top[1],
                right=right_bottom[0],
                bottom=right_bottom[1],
            )
            if info.width > 100 and info.height > 100:
                found.append(info)
        except Exception:
            return

    win32gui.EnumWindows(_enum, None)
    if not found:
        return None
    # 优先面积最大
    found.sort(key=lambda w: w.width * w.height, reverse=True)
    return found[0]


def _is_foreground(hwnd: int) -> bool:
    if win32gui is None:
        return False
    try:
        fg = win32gui.GetForegroundWindow()
        if fg == hwnd:
            return True
        # 有时前台是子窗口
        return bool(fg and win32gui.GetAncestor(fg, win32con.GA_ROOT) == hwnd)
    except Exception:
        return False


def _alt_unlock_foreground() -> None:
    """模拟按一下 Alt，绕过 Windows SetForegroundWindow 限制。"""
    if win32api is None or win32con is None:
        return
    try:
        win32api.keybd_event(win32con.VK_MENU, 0, 0, 0)
        time.sleep(0.02)
        win32api.keybd_event(win32con.VK_MENU, 0, win32con.KEYEVENTF_KEYUP, 0)
    except Exception:
        pass


def focus_window(hwnd: int, retries: int = 5, settle_ms: int = 120) -> bool:
    """尽量把目标窗口带到前台。返回是否已是前台。"""
    if win32gui is None or win32con is None:
        return False
    if not hwnd:
        return False

    try:
        if not win32gui.IsWindow(hwnd):
            return False
    except Exception:
        return False

    for attempt in range(max(1, retries)):
        try:
            if win32gui.IsIconic(hwnd):
                win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                time.sleep(0.05)
            else:
                # SW_SHOW 不改变尺寸，只确保可见
                win32gui.ShowWindow(hwnd, win32con.SW_SHOW)

            # 方法 1：AttachThreadInput + SetForegroundWindow
            try:
                import ctypes

                user32 = ctypes.windll.user32
                foreground = win32gui.GetForegroundWindow() or 0
                cur_tid = 0
                if foreground:
                    cur_tid, _ = win32process.GetWindowThreadProcessId(foreground)
                tgt_tid, _ = win32process.GetWindowThreadProcessId(hwnd)
                my_tid = win32api.GetCurrentThreadId() if win32api else 0

                attached_fg = False
                attached_me = False
                try:
                    if cur_tid and cur_tid != tgt_tid:
                        attached_fg = bool(
                            win32process.AttachThreadInput(cur_tid, tgt_tid, True)
                        )
                    if my_tid and my_tid != tgt_tid:
                        attached_me = bool(
                            win32process.AttachThreadInput(my_tid, tgt_tid, True)
                        )

                    # 允许任意进程设前台（需当前进程具备前台权限时才有效）
                    try:
                        user32.AllowSetForegroundWindow(-1)  # ASFW_ANY
                    except Exception:
                        pass

                    if attempt > 0:
                        _alt_unlock_foreground()

                    try:
                        win32gui.BringWindowToTop(hwnd)
                    except Exception:
                        pass
                    try:
                        win32gui.SetActiveWindow(hwnd)
                    except Exception:
                        pass
                    try:
                        win32gui.SetForegroundWindow(hwnd)
                    except Exception:
                        # ctypes 再试一次
                        user32.SetForegroundWindow(hwnd)

                    # SwitchToThisWindow 在部分系统上更激进
                    try:
                        user32.SwitchToThisWindow(hwnd, True)
                    except Exception:
                        pass
                finally:
                    if attached_me and my_tid:
                        try:
                            win32process.AttachThreadInput(my_tid, tgt_tid, False)
                        except Exception:
                            pass
                    if attached_fg and cur_tid:
                        try:
                            win32process.AttachThreadInput(cur_tid, tgt_tid, False)
                        except Exception:
                            pass
            except Exception:
                try:
                    _alt_unlock_foreground()
                    win32gui.SetForegroundWindow(hwnd)
                except Exception:
                    pass

            time.sleep(settle_ms / 1000.0)
            if _is_foreground(hwnd):
                return True
        except Exception:
            time.sleep(0.05)
            continue

    return _is_foreground(hwnd)


def focus_game_window(
    keywords: list[str],
    retries: int = 6,
) -> tuple[Optional[WindowInfo], bool]:
    """查找并聚焦游戏窗口。返回 (window, focused)。"""
    win = find_game_window(keywords)
    if win is None:
        return None, False
    ok = focus_window(win.hwnd, retries=retries)
    return win, ok


def _move_to(x: int, y: int) -> None:
    if pydirectinput is not None:
        pydirectinput.moveTo(int(x), int(y))
        return
    if win32api is not None:
        win32api.SetCursorPos((int(x), int(y)))


def _click_left() -> None:
    if pydirectinput is not None:
        pydirectinput.click()
        return
    if win32api is not None:
        win32api.mouse_event(win32con.MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        time.sleep(0.02)
        win32api.mouse_event(win32con.MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)


def click_screen(x: int, y: int, settle_ms: int = 40) -> None:
    _move_to(x, y)
    time.sleep(settle_ms / 1000.0)
    _click_left()


def move_screen(x: int, y: int, settle_ms: int = 40) -> None:
    _move_to(x, y)
    time.sleep(settle_ms / 1000.0)


def hotkey(*keys: str) -> None:
    """按下组合键，如 hotkey('ctrl', 'c')。

    注意：当前 PyDirectInput 没有 hotkey()，需用 keyDown/keyUp 组合。
    """
    keys_l = [k.lower() for k in keys]
    if not keys_l:
        return

    # pydirectinput 路径
    if pydirectinput is not None:
        try:
            for k in keys_l:
                pydirectinput.keyDown(k)
            time.sleep(0.04)
            for k in reversed(keys_l):
                pydirectinput.keyUp(k)
            return
        except Exception:
            # 失败则尝试 Win32
            pass

    # Win32 回退
    if win32api is None or win32con is None:
        raise RuntimeError("无法发送组合键：pydirectinput 与 win32api 均不可用")

    vk_map = {
        "ctrl": win32con.VK_CONTROL,
        "control": win32con.VK_CONTROL,
        "alt": win32con.VK_MENU,
        "shift": win32con.VK_SHIFT,
        "c": ord("C"),
        "v": ord("V"),
        "a": ord("A"),
        "f8": win32con.VK_F8,
    }
    vks: list[int] = []
    for k in keys_l:
        if k in vk_map:
            vks.append(vk_map[k])
        elif len(k) == 1:
            vks.append(ord(k.upper()))
        else:
            raise RuntimeError(f"不支持的按键: {k}")

    for vk in vks:
        win32api.keybd_event(vk, 0, 0, 0)
    time.sleep(0.04)
    for vk in reversed(vks):
        win32api.keybd_event(vk, 0, win32con.KEYEVENTF_KEYUP, 0)


def press_key(key: str) -> None:
    key_l = key.lower()
    if pydirectinput is not None:
        try:
            pydirectinput.press(key_l)
            return
        except Exception:
            pass
    hotkey(key_l)


def sleep_ms(ms: int, should_stop: Optional[Callable[[], bool]] = None) -> bool:
    """可中断睡眠。若 should_stop 返回 True 则提前结束并返回 True。"""
    if ms <= 0:
        return bool(should_stop and should_stop())
    end = time.monotonic() + ms / 1000.0
    while time.monotonic() < end:
        if should_stop and should_stop():
            return True
        time.sleep(min(0.05, max(0.0, end - time.monotonic())))
    return bool(should_stop and should_stop())
