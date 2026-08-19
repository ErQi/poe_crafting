import koffi from "koffi";
import { sleepMs, waitUntil } from "./timing";

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");
const gdi32 = koffi.load("gdi32.dll");

const POINT = koffi.struct("POINT", { x: "int32", y: "int32" });
koffi.struct("RECT", {
  left: "int32",
  top: "int32",
  right: "int32",
  bottom: "int32",
});
const CURSORINFO = koffi.struct("CURSORINFO", {
  cbSize: "uint32",
  flags: "uint32",
  hCursor: "void *",
  ptScreenPos: POINT,
});
const ICONINFO = koffi.struct("ICONINFO", {
  fIcon: "int32",
  xHotspot: "uint32",
  yHotspot: "uint32",
  hbmMask: "void *",
  hbmColor: "void *",
});
const BITMAPINFOHEADER = koffi.struct("BITMAPINFOHEADER", {
  biSize: "uint32",
  biWidth: "int32",
  biHeight: "int32",
  biPlanes: "uint16",
  biBitCount: "uint16",
  biCompression: "uint32",
  biSizeImage: "uint32",
  biXPelsPerMeter: "int32",
  biYPelsPerMeter: "int32",
  biClrUsed: "uint32",
  biClrImportant: "uint32",
});

const HWND = koffi.alias("HWND", "uintptr");
const EnumWindowsProc = koffi.proto("int __stdcall EnumWindowsProc(HWND hwnd, intptr lParam)");
const IsWindow = user32.func("int __stdcall IsWindow(HWND hWnd)");
const IsWindowVisible = user32.func("int __stdcall IsWindowVisible(HWND hWnd)");
const GetWindowTextLengthW = user32.func("int __stdcall GetWindowTextLengthW(HWND hWnd)");
const GetWindowTextW = user32.func("int __stdcall GetWindowTextW(HWND hWnd, uint16 *lpString, int nMaxCount)");
const GetForegroundWindow = user32.func("HWND __stdcall GetForegroundWindow()");
const GetAncestor = user32.func("HWND __stdcall GetAncestor(HWND hWnd, uint32 gaFlags)");
const IsIconic = user32.func("int __stdcall IsIconic(HWND hWnd)");
const ShowWindow = user32.func("int __stdcall ShowWindow(HWND hWnd, int nCmdShow)");
const SetForegroundWindow = user32.func("int __stdcall SetForegroundWindow(HWND hWnd)");
const BringWindowToTop = user32.func("int __stdcall BringWindowToTop(HWND hWnd)");
const SetActiveWindow = user32.func("HWND __stdcall SetActiveWindow(HWND hWnd)");
const AllowSetForegroundWindow = user32.func("int __stdcall AllowSetForegroundWindow(uint32 dwProcessId)");
const SwitchToThisWindow = user32.func("void __stdcall SwitchToThisWindow(HWND hWnd, int fAltTab)");
const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(HWND hWnd, uint32 *lpdwProcessId)");
const EnumWindows = user32.func("int __stdcall EnumWindows(EnumWindowsProc *lpEnumFunc, intptr lParam)");
const AttachThreadInput = user32.func("int __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, int fAttach)");
const GetCurrentThreadId = kernel32.func("uint32 __stdcall GetCurrentThreadId()");
const GetClientRect = user32.func("int __stdcall GetClientRect(HWND hWnd, _Out_ RECT *lpRect)");
const ClientToScreen = user32.func("int __stdcall ClientToScreen(HWND hWnd, _Inout_ POINT *lpPoint)");
const GetCursorPos = user32.func("int __stdcall GetCursorPos(_Out_ POINT *lpPoint)");
const SetCursorPos = user32.func("int __stdcall SetCursorPos(int X, int Y)");
const GetCursorInfo = user32.func("int __stdcall GetCursorInfo(_Inout_ CURSORINFO *pci)");
const GetIconInfo = user32.func("int __stdcall GetIconInfo(uintptr hIcon, _Out_ ICONINFO *piconinfo)");
const GetSystemMetrics = user32.func("int __stdcall GetSystemMetrics(int nIndex)");
const GetDpiForWindow = user32.func("uint32 __stdcall GetDpiForWindow(HWND hWnd)");
const GetDpiForSystem = user32.func("uint32 __stdcall GetDpiForSystem()");
const GetDC = user32.func("void * __stdcall GetDC(void *hWnd)");
const ReleaseDC = user32.func("int __stdcall ReleaseDC(void *hWnd, void *hDC)");
const CreateCompatibleDC = gdi32.func("void * __stdcall CreateCompatibleDC(void *hdc)");
const CreateCompatibleBitmap = gdi32.func("void * __stdcall CreateCompatibleBitmap(void *hdc, int cx, int cy)");
const SelectObject = gdi32.func("void * __stdcall SelectObject(void *hdc, void *h)");
const BitBlt = gdi32.func("int __stdcall BitBlt(void *hdc, int x, int y, int cx, int cy, void *hdcSrc, int x1, int y1, uint32 rop)");
const GetDIBits = gdi32.func("int __stdcall GetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, void *bits, void *info, uint32 usage)");
const DeleteObject = gdi32.func("int __stdcall DeleteObject(void *ho)");
const DeleteDC = gdi32.func("int __stdcall DeleteDC(void *hdc)");
const MOUSEINPUT = koffi.struct("MOUSEINPUT", {
  dx: "long",
  dy: "long",
  mouseData: "uint32_t",
  dwFlags: "uint32_t",
  time: "uint32_t",
  dwExtraInfo: "uintptr_t",
});
const KEYBDINPUT = koffi.struct("KEYBDINPUT", {
  wVk: "uint16_t",
  wScan: "uint16_t",
  dwFlags: "uint32_t",
  time: "uint32_t",
  dwExtraInfo: "uintptr_t",
});
const HARDWAREINPUT = koffi.struct("HARDWAREINPUT", {
  uMsg: "uint32_t",
  wParamL: "uint16_t",
  wParamH: "uint16_t",
});
const INPUT = koffi.struct("INPUT", {
  type: "uint32_t",
  u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }),
});
const SendInput = user32.func("uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)");
const keybd_event = user32.func("void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr dwExtraInfo)");

const GA_ROOT = 2;
const SW_RESTORE = 9;
const SW_SHOW = 5;
const SM_CYSCREEN = 1;
const SRCCOPY = 0x00cc0020;
const VK_MENU = 0x12;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const INPUT_SIZE = koffi.sizeof(INPUT);
const EXPECTED_INPUT_SIZE = process.arch === "ia32" ? 28 : 40;
const BMIH_SIZE = koffi.sizeof(BITMAPINFOHEADER);
const CAPTURE_MAX_EDGE = 8192;
const CAPTURE_MAX_PIXELS = 8192 * 4320;
const ASFW_ANY = 0xffffffff;

export type Hwnd = object | bigint | number;

export function hwndPtr(hwnd: Hwnd | null | undefined): bigint | null {
  const addr = hwndAddr(hwnd);
  return addr === 0n ? null : addr;
}

function hwndAddr(ptr: unknown): bigint {
  if (ptr == null || ptr === 0 || ptr === 0n) return 0n;
  try {
    if (typeof ptr === "bigint") return ptr;
    if (typeof ptr === "number") return Number.isFinite(ptr) ? BigInt(Math.trunc(ptr)) : 0n;
    return koffi.address(ptr as object) || 0n;
  } catch {
    return 0n;
  }
}

function isNullPtr(ptr: unknown): boolean {
  return hwndAddr(ptr) === 0n;
}

function hwndEq(a: unknown, b: unknown): boolean {
  const left = hwndAddr(a);
  const right = hwndAddr(b);
  return left !== 0n && left === right;
}

export function windowTitle(hwnd: Hwnd | null | undefined): string {
  const h = hwndPtr(hwnd);
  if (!h) return "";
  try {
    const len = GetWindowTextLengthW(h);
    if (len <= 0) return "";
    const buf = Buffer.alloc((len + 2) * 2);
    const n = GetWindowTextW(h, buf, len + 1);
    return buf.toString("utf16le", 0, n * 2);
  } catch {
    return "";
  }
}

export interface WindowInfo {
  hwnd: bigint;
  title: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function windowMetrics(win: WindowInfo) {
  return {
    width: Math.max(0, win.right - win.left),
    height: Math.max(0, win.bottom - win.top),
    center: {
      x: win.left + Math.floor(Math.max(0, win.right - win.left) / 2),
      y: win.top + Math.floor(Math.max(0, win.bottom - win.top) / 2),
    },
  };
}

export function windowFromHwnd(hwnd: Hwnd | null | undefined, title = ""): WindowInfo | null {
  const h = hwndPtr(hwnd);
  if (!h) return null;
  try {
    if (!IsWindow(h)) return null;
    const rect = {};
    if (!GetClientRect(h, rect)) return null;
    const r = rect as { left: number; top: number; right: number; bottom: number };
    const tl = { x: r.left, y: r.top };
    const br = { x: r.right, y: r.bottom };
    ClientToScreen(h, tl);
    ClientToScreen(h, br);
    if (![tl.x, tl.y, br.x, br.y].every(Number.isFinite)) return null;
    const info: WindowInfo = {
      hwnd: h,
      title: title || windowTitle(h),
      left: tl.x,
      top: tl.y,
      right: br.x,
      bottom: br.y,
    };
    const { width, height } = windowMetrics(info);
    return width > 100 && height > 100 && width <= CAPTURE_MAX_EDGE && height <= CAPTURE_MAX_EDGE ? info : null;
  } catch {
    return null;
  }
}

export function peekWindow(hwnd: Hwnd | null | undefined, title = ""): WindowInfo | null {
  return windowFromHwnd(hwnd, title);
}

export function findGameWindow(keywords: string[]): WindowInfo | null {
  try {
    const keys = keywords.filter(Boolean);
    const found: WindowInfo[] = [];
    EnumWindows((raw: Hwnd) => {
      const hwnd = hwndPtr(raw);
      if (!hwnd) return 1;
      try {
        if (!IsWindowVisible(hwnd)) return 1;
        const title = windowTitle(hwnd);
        if (!title) return 1;
        const tl = title.toLowerCase();
        if (!keys.some((k) => tl.includes(k.toLowerCase()) || title.includes(k))) return 1;
        const info = windowFromHwnd(hwnd, title);
        if (info) found.push(info);
      } catch {
        /* 单个无效句柄跳过 */
      }
      return 1;
    }, 0);
    found.sort((a, b) => {
      const aa = windowMetrics(a);
      const bb = windowMetrics(b);
      return bb.width * bb.height - aa.width * aa.height;
    });
    return found[0] ?? null;
  } catch {
    return null;
  }
}

export function isForegroundWindow(hwnd: Hwnd | null | undefined): boolean {
  const h = hwndPtr(hwnd);
  if (!h) return false;
  try {
    const fg = hwndPtr(GetForegroundWindow());
    if (!fg) return false;
    if (hwndEq(fg, h)) return true;
    return hwndEq(hwndPtr(GetAncestor(fg, GA_ROOT)), h);
  } catch {
    return false;
  }
}

const ALT_HOLD_MS = 20;

async function altUnlock(): Promise<void> {
  try {
    keybd_event(VK_MENU, 0, 0, 0);
    await sleepMs(ALT_HOLD_MS);
    keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
  } catch {
    /* ignore */
  }
}

/** settleMs 只作置前的等待上限：一旦目标窗口成为前台就立即返回，不冻结主进程。 */
export async function focusWindow(hwnd: Hwnd | null | undefined, retries = 5, settleMs = 120): Promise<boolean> {
  const h = hwndPtr(hwnd);
  if (!h) return false;
  try {
    if (!IsWindow(h)) return false;
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < Math.max(1, retries); attempt++) {
    try {
      if (IsIconic(h)) {
        ShowWindow(h, SW_RESTORE);
        await waitUntil(() => !IsIconic(h), settleMs, 10);
      } else ShowWindow(h, SW_SHOW);
      const foreground = hwndPtr(GetForegroundWindow());
      const curTid = foreground ? GetWindowThreadProcessId(foreground, null) : 0;
      const tgtTid = GetWindowThreadProcessId(h, null);
      const myTid = GetCurrentThreadId();
      let attachedFg = false;
      let attachedMe = false;
      try {
        if (curTid && curTid !== tgtTid) attachedFg = Boolean(AttachThreadInput(curTid, tgtTid, 1));
        if (myTid && myTid !== tgtTid) attachedMe = Boolean(AttachThreadInput(myTid, tgtTid, 1));
        try {
          AllowSetForegroundWindow(ASFW_ANY);
        } catch {
          /* ignore */
        }
        if (attempt > 0) await altUnlock();
        try {
          BringWindowToTop(h);
        } catch {
          /* ignore */
        }
        try {
          SetActiveWindow(h);
        } catch {
          /* ignore */
        }
        try {
          SetForegroundWindow(h);
        } catch {
          /* ignore */
        }
        try {
          SwitchToThisWindow(h, 1);
        } catch {
          /* ignore */
        }
      } finally {
        if (attachedMe && myTid) {
          try {
            AttachThreadInput(myTid, tgtTid, 0);
          } catch {
            /* ignore */
          }
        }
        if (attachedFg && curTid) {
          try {
            AttachThreadInput(curTid, tgtTid, 0);
          } catch {
            /* ignore */
          }
        }
      }
      if (await waitUntil(() => isForegroundWindow(h), settleMs, 10)) return true;
    } catch {
      await sleepMs(settleMs);
    }
  }
  return isForegroundWindow(h);
}

export async function focusGameWindow(keywords: string[], retries = 6): Promise<[WindowInfo | null, boolean]> {
  try {
    const win = findGameWindow(keywords);
    if (!win) return [null, false];
    return [win, await focusWindow(win.hwnd, retries)];
  } catch {
    return [null, false];
  }
}

export function getCursorPosition(): [number, number] {
  const pt = {};
  if (!GetCursorPos(pt)) return [0, 0];
  const p = pt as { x: number; y: number };
  return [p.x, p.y];
}

export function getCursorHandle(): bigint | null {
  try {
    const info = { cbSize: koffi.sizeof(CURSORINFO), flags: 0, hCursor: null, ptScreenPos: { x: 0, y: 0 } };
    if (!GetCursorInfo(info)) return null;
    const handle = hwndAddr(info.hCursor);
    return handle || null;
  } catch {
    return null;
  }
}

const hotspotCache = new Map<string, [number, number]>();

export function getCursorHotspot(): [number, number] {
  const handle = getCursorHandle();
  if (handle == null) return [0, 0];
  const key = handle.toString();
  const cached = hotspotCache.get(key);
  if (cached) return cached;
  let hotspot: [number, number] = [0, 0];
  const info = { fIcon: 0, xHotspot: 0, yHotspot: 0, hbmMask: null, hbmColor: null };
  try {
    if (GetIconInfo(handle, info)) {
      hotspot = [info.xHotspot, info.yHotspot];
      if (info.hbmMask && !isNullPtr(info.hbmMask)) DeleteObject(info.hbmMask);
      if (info.hbmColor && !isNullPtr(info.hbmColor)) DeleteObject(info.hbmColor);
    }
  } catch {
    /* 无效光标句柄时跳过 */
  }
  hotspotCache.set(key, hotspot);
  return hotspot;
}

export function cursorPatchSize(windowHeight = 0, hwnd: Hwnd | null | undefined = null): number {
  let height = Math.max(0, windowHeight);
  if (height <= 0) height = Math.max(1, GetSystemMetrics(SM_CYSCREEN) || 1080);
  let dpi = 96;
  try {
    const h = hwndPtr(hwnd);
    const raw = h ? GetDpiForWindow(h) : GetDpiForSystem();
    if (raw > 0) dpi = raw;
  } catch {
    /* ignore */
  }
  const scale = Math.max(height / 1080, dpi / 96);
  return Math.max(32, Math.round(32 * scale));
}

export function moveTo(x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  try {
    SetCursorPos(Math.round(x), Math.round(y));
  } catch (e) {
    console.error("[win32] SetCursorPos:", e);
  }
}

type InputEvent = {
  type: number;
  u: {
    mi?: { dx: number; dy: number; mouseData: number; dwFlags: number; time: number; dwExtraInfo: number };
    ki?: { wVk: number; wScan: number; dwFlags: number; time: number; dwExtraInfo: number };
  };
};

function sendInputs(events: InputEvent[]): boolean {
  if (!events.length) return true;
  if (INPUT_SIZE !== EXPECTED_INPUT_SIZE) {
    console.error("[win32] INPUT sizeof", INPUT_SIZE, "expected", EXPECTED_INPUT_SIZE);
    return false;
  }
  try {
    return SendInput(events.length, events, INPUT_SIZE) === events.length;
  } catch (e) {
    console.error("[win32] SendInput:", e);
    return false;
  }
}

function mouseEvent(flags: number): InputEvent {
  return { type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
}

function keyEvent(scan: number, up: boolean): InputEvent {
  return {
    type: INPUT_KEYBOARD,
    u: { ki: { wVk: 0, wScan: scan, dwFlags: KEYEVENTF_SCANCODE | (up ? KEYEVENTF_KEYUP : 0), time: 0, dwExtraInfo: 0 } },
  };
}

export function clickButton(button: "left" | "right"): void {
  const down = button === "right" ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
  const up = button === "right" ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
  if (!sendInputs([mouseEvent(down), mouseEvent(up)])) console.error("[win32] clickButton: SendInput 失败");
}

const SCAN: Record<string, number> = {
  ctrl: 0x1d,
  control: 0x1d,
  alt: 0x38,
  shift: 0x2a,
  c: 0x2e,
  v: 0x2f,
  a: 0x1e,
  f8: 0x42,
};

export function hotkey(...keys: string[]): boolean {
  try {
    const scans = keys.map((k) => {
      const key = k.toLowerCase();
      if (SCAN[key] != null) return SCAN[key];
      if (key.length === 1) return SCAN[key] ?? key.toUpperCase().charCodeAt(0);
      throw new Error(`不支持的按键: ${k}`);
    });
    const events = [...scans.map((s) => keyEvent(s, false)), ...[...scans].reverse().map((s) => keyEvent(s, true))];
    return sendInputs(events);
  } catch (e) {
    console.error("[win32] hotkey:", e);
    return false;
  }
}

function writeBmih(width: number, height: number): Buffer {
  const header = Buffer.alloc(BMIH_SIZE);
  header.writeUInt32LE(BMIH_SIZE, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(-height, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  return header;
}

export function captureRegionBgra(left: number, top: number, width: number, height: number): Buffer {
  if (![left, top, width, height].every(Number.isFinite)) throw new Error("截屏区域无效");
  const w = Math.trunc(width);
  const h = Math.trunc(height);
  if (w < 1 || h < 1) throw new Error("截屏区域无效");
  if (w > CAPTURE_MAX_EDGE || h > CAPTURE_MAX_EDGE || w * h > CAPTURE_MAX_PIXELS) {
    throw new Error(`截屏尺寸过大: ${w}x${h}`);
  }
  let hdc: unknown = null;
  let mem: unknown = null;
  let bmp: unknown = null;
  let old: unknown = null;
  try {
    hdc = GetDC(null);
    if (isNullPtr(hdc)) throw new Error("GetDC 失败");
    mem = CreateCompatibleDC(hdc);
    if (isNullPtr(mem)) throw new Error("CreateCompatibleDC 失败");
    bmp = CreateCompatibleBitmap(hdc, w, h);
    if (isNullPtr(bmp)) throw new Error("CreateCompatibleBitmap 失败");
    old = SelectObject(mem, bmp);
    if (!BitBlt(mem, 0, 0, w, h, hdc, Math.trunc(left), Math.trunc(top), SRCCOPY)) {
      throw new Error("BitBlt 失败");
    }
    const pixels = Buffer.alloc(w * h * 4);
    if (!GetDIBits(hdc, bmp, 0, h, pixels, writeBmih(w, h), 0)) throw new Error("GetDIBits 失败");
    return pixels;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(/截屏|GetDC|BitBlt|GetDIBits|CreateCompatible/.test(msg) ? msg : `截屏失败: ${msg}`);
  } finally {
    try {
      if (!isNullPtr(mem) && !isNullPtr(old)) SelectObject(mem, old);
    } catch {
      /* ignore */
    }
    try {
      if (!isNullPtr(bmp)) DeleteObject(bmp);
    } catch {
      /* ignore */
    }
    try {
      if (!isNullPtr(mem)) DeleteDC(mem);
    } catch {
      /* ignore */
    }
    try {
      if (!isNullPtr(hdc)) ReleaseDC(null, hdc);
    } catch {
      /* ignore */
    }
  }
}
