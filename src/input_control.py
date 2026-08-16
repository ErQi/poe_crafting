from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, Optional

try:
    import ctypes
    from ctypes import wintypes
except ImportError:
    ctypes = None  # type: ignore
    wintypes = None  # type: ignore

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

_CURSORINFO = None
_ICONINFO = None
_user32 = None
_gdi32 = None
if ctypes is not None and wintypes is not None:
    try:

        class _CURSORINFO(ctypes.Structure):
            _fields_ = (
                ("cbSize", wintypes.DWORD),
                ("flags", wintypes.DWORD),
                ("hCursor", wintypes.HANDLE),
                ("ptScreenPos", wintypes.POINT),
            )

        class _ICONINFO(ctypes.Structure):
            _fields_ = (
                ("fIcon", wintypes.BOOL),
                ("xHotspot", wintypes.DWORD),
                ("yHotspot", wintypes.DWORD),
                ("hbmMask", wintypes.HBITMAP),
                ("hbmColor", wintypes.HBITMAP),
            )

        _user32 = ctypes.windll.user32
        _gdi32 = ctypes.windll.gdi32
        _user32.GetCursorInfo.argtypes = [ctypes.POINTER(_CURSORINFO)]
        _user32.GetCursorInfo.restype = wintypes.BOOL
        _user32.GetIconInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ICONINFO)]
        _user32.GetIconInfo.restype = wintypes.BOOL
        _user32.GetSystemMetrics.argtypes = [ctypes.c_int]
        _user32.GetSystemMetrics.restype = ctypes.c_int
        _gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
        _gdi32.DeleteObject.restype = wintypes.BOOL
    except Exception:
        _CURSORINFO = None
        _ICONINFO = None
        _user32 = None
        _gdi32 = None

_hotspot_cache: dict[int, tuple[int, int]] = {}

try:
    import pydirectinput

    pydirectinput.PAUSE = 0
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


def _window_from_hwnd(hwnd: int, title: str = "") -> Optional[WindowInfo]:
    """只读已有句柄：是否还在 + 客户区屏幕坐标。不枚举桌面。"""
    if win32gui is None or not hwnd:
        return None
    try:
        if not win32gui.IsWindow(hwnd):
            return None
        rect = win32gui.GetClientRect(hwnd)
        left_top = win32gui.ClientToScreen(hwnd, (rect[0], rect[1]))
        right_bottom = win32gui.ClientToScreen(hwnd, (rect[2], rect[3]))
        info = WindowInfo(
            hwnd=hwnd,
            title=title or (win32gui.GetWindowText(hwnd) or ""),
            left=left_top[0],
            top=left_top[1],
            right=right_bottom[0],
            bottom=right_bottom[1],
        )
        if info.width > 100 and info.height > 100:
            return info
    except Exception:
        return None
    return None


def peek_window(hwnd: int, title: str = "") -> Optional[WindowInfo]:
    """常规循环用的廉价窗口检查，不走 EnumWindows。"""
    return _window_from_hwnd(hwnd, title)


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
        info = _window_from_hwnd(hwnd, title)
        if info is not None:
            found.append(info)

    win32gui.EnumWindows(_enum, None)
    if not found:
        return None
    found.sort(key=lambda w: w.width * w.height, reverse=True)
    return found[0]


def is_foreground_window(hwnd: int) -> bool:
    return _is_foreground(hwnd)


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


def get_cursor_pos() -> tuple[int, int]:
    if win32api is not None:
        pos = win32api.GetCursorPos()
        return int(pos[0]), int(pos[1])
    if pydirectinput is not None:
        pos = pydirectinput.position()
        return int(pos[0]), int(pos[1])
    return 0, 0


def get_cursor_handle() -> Optional[int]:
    """当前系统光标句柄。游戏把通货挂到光标上时通常会换 hCursor。"""
    if _user32 is not None and _CURSORINFO is not None:
        try:
            info = _CURSORINFO()
            info.cbSize = ctypes.sizeof(_CURSORINFO)
            if _user32.GetCursorInfo(ctypes.byref(info)) and info.hCursor:
                return int(info.hCursor)
        except Exception:
            pass
    if win32gui is not None:
        try:
            _flags, hcursor, _pos = win32gui.GetCursorInfo()
            return int(hcursor) if hcursor else None
        except Exception:
            return None
    return None


def get_cursor_hotspot() -> tuple[int, int]:
    """当前光标热点相对其位图左上角的偏移。失败则 (0, 0)。"""
    handle = get_cursor_handle()
    if handle is None:
        return (0, 0)
    cached = _hotspot_cache.get(handle)
    if cached is not None:
        return cached
    hotspot = (0, 0)
    if _user32 is not None and _gdi32 is not None and _ICONINFO is not None:
        try:
            info = _ICONINFO()
            if _user32.GetIconInfo(handle, ctypes.byref(info)):
                try:
                    hotspot = (int(info.xHotspot), int(info.yHotspot))
                finally:
                    if info.hbmMask:
                        _gdi32.DeleteObject(info.hbmMask)
                    if info.hbmColor:
                        _gdi32.DeleteObject(info.hbmColor)
        except Exception:
            hotspot = (0, 0)
    elif win32gui is not None:
        try:
            _icon, x_hot, y_hot, mask, color = win32gui.GetIconInfo(handle)
            try:
                hotspot = (int(x_hot), int(y_hot))
            finally:
                if mask:
                    win32gui.DeleteObject(mask)
                if color:
                    win32gui.DeleteObject(color)
        except Exception:
            hotspot = (0, 0)
    _hotspot_cache[handle] = hotspot
    return hotspot


def cursor_patch_size(window_height: int = 0, hwnd: int = 0) -> int:
    """按游戏窗口高度/DPI 放大光标截图块，4K 不会再死用 32px。"""
    height = max(0, int(window_height))
    dpi = 96
    if height <= 0 and win32api is not None:
        try:
            height = max(1, int(win32api.GetSystemMetrics(1)))
        except Exception:
            height = 0
    if height <= 0 and _user32 is not None:
        try:
            height = max(1, int(_user32.GetSystemMetrics(1)))
        except Exception:
            height = 0
    if height <= 0:
        height = 1080
    if _user32 is not None:
        try:
            if hwnd:
                raw = int(_user32.GetDpiForWindow(int(hwnd)))
            else:
                raw = int(_user32.GetDpiForSystem())
            if raw > 0:
                dpi = raw
        except Exception:
            pass
    scale = max(height / 1080.0, dpi / 96.0)
    return max(32, int(round(32 * scale)))


def _move_to(x: int, y: int) -> None:
    if win32api is not None:
        win32api.SetCursorPos((int(x), int(y)))
        return
    if pydirectinput is not None:
        pydirectinput.moveTo(int(x), int(y))


def _click(button: str = "left") -> None:
    button = button.lower()
    if button not in {"left", "right"}:
        raise ValueError(f"不支持的鼠标按钮: {button}")
    if pydirectinput is not None:
        pydirectinput.click(button=button)
        return
    if win32api is not None:
        if button == "right":
            down = win32con.MOUSEEVENTF_RIGHTDOWN
            up = win32con.MOUSEEVENTF_RIGHTUP
        else:
            down = win32con.MOUSEEVENTF_LEFTDOWN
            up = win32con.MOUSEEVENTF_LEFTUP
        win32api.mouse_event(down, 0, 0, 0, 0)
        time.sleep(0.02)
        win32api.mouse_event(up, 0, 0, 0, 0)


def click_screen(
    x: int,
    y: int,
    settle_ms: int = 40,
    *,
    button: str,
) -> None:
    """先移到坐标，等 settle 后再点一次。必须显式指定左右键。"""
    _move_to(x, y)
    time.sleep(settle_ms / 1000.0)
    _click(button)


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
            time.sleep(0.012)
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
    time.sleep(0.012)
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
