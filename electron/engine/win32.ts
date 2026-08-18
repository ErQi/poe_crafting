import koffi from "koffi";

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");
const gdi32 = koffi.load("gdi32.dll");

export const POINT = koffi.struct("POINT", { x: "int32", y: "int32" });
export const RECT = koffi.struct("RECT", {
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
const ClientToScreen = user32.func("int __stdcall ClientToScreen(HWND hWnd, POINT *lpPoint)");
const GetCursorPos = user32.func("int __stdcall GetCursorPos(_Out_ POINT *lpPoint)");
const SetCursorPos = user32.func("int __stdcall SetCursorPos(int X, int Y)");
const GetCursorInfo = user32.func("int __stdcall GetCursorInfo(CURSORINFO *pci)");
const GetIconInfo = user32.func("int __stdcall GetIconInfo(HWND hIcon, ICONINFO *piconinfo)");
const GetSystemMetrics = user32.func("int __stdcall GetSystemMetrics(int nIndex)");
const GetDpiForWindow = user32.func("uint32 __stdcall GetDpiForWindow(HWND hWnd)");
const GetDpiForSystem = user32.func("uint32 __stdcall GetDpiForSystem()");
const GetDC = user32.func("void * __stdcall GetDC(void *hWnd)");
const ReleaseDC = user32.func("int __stdcall ReleaseDC(void *hWnd, void *hDC)");
const CreateCompatibleDC = gdi32.func("void * __stdcall CreateCompatibleDC(void *hdc)");
const CreateCompatibleBitmap = gdi32.func("void * __stdcall CreateCompatibleBitmap(void *hdc, int cx, int cy)");
const SelectObject = gdi32.func("void * __stdcall SelectObject(void *hdc, void *h)");
const BitBlt = gdi32.func("int __stdcall BitBlt(void *hdc, int x, int y, int cx, int cy, void *hdcSrc, int x1, int y1, uint32 rop)");
const GetDIBits = gdi32.func("int __stdcall GetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, void *bits, BITMAPINFOHEADER *info, uint32 usage)");
const DeleteObject = gdi32.func("int __stdcall DeleteObject(void *ho)");
const DeleteDC = gdi32.func("int __stdcall DeleteDC(void *hdc)");
const OpenClipboard = user32.func("int __stdcall OpenClipboard(void *hWndNewOwner)");
const CloseClipboard = user32.func("int __stdcall CloseClipboard()");
const EmptyClipboard = user32.func("int __stdcall EmptyClipboard()");
const GetClipboardData = user32.func("void * __stdcall GetClipboardData(uint32 uFormat)");
const SetClipboardData = user32.func("void * __stdcall SetClipboardData(uint32 uFormat, void *hMem)");
const GlobalAlloc = kernel32.func("void * __stdcall GlobalAlloc(uint32 uFlags, size_t dwBytes)");
const GlobalLock = kernel32.func("void * __stdcall GlobalLock(void *hMem)");
const GlobalUnlock = kernel32.func("int __stdcall GlobalUnlock(void *hMem)");
const GlobalFree = kernel32.func("void * __stdcall GlobalFree(void *hMem)");
const GlobalSize = kernel32.func("size_t __stdcall GlobalSize(void *hMem)");
const RtlMoveMemory = kernel32.func("void __stdcall RtlMoveMemory(void *dest, void *src, size_t length)");
const SendInput = user32.func("uint32 __stdcall SendInput(uint32 cInputs, void *pInputs, int cbSize)");
const keybd_event = user32.func("void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr dwExtraInfo)");

const GA_ROOT = 2;
const SW_RESTORE = 9;
const SW_SHOW = 5;
const SM_CYSCREEN = 1;
const SRCCOPY = 0x00cc0020;
const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 0x0002;
const VK_MENU = 0x12;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;
const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const INPUT_SIZE = 40;
const ASFW_ANY = 0xffffffff;

export type Hwnd = object | bigint | number;

export function hwndPtr(hwnd: Hwnd | null | undefined): bigint | null {
  const addr = hwndAddr(hwnd);
  return addr === 0n ? null : addr;
}

export function ptrToNum(ptr: unknown): number {
  const addr = hwndAddr(ptr);
  if (!addr) return 0;
  const n = Number(addr);
  return Number.isSafeInteger(n) ? n : 0;
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
    const info: WindowInfo = {
      hwnd: h,
      title: title || windowTitle(h),
      left: tl.x,
      top: tl.y,
      right: br.x,
      bottom: br.y,
    };
    const { width, height } = windowMetrics(info);
    return width > 100 && height > 100 ? info : null;
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

function altUnlock(): void {
  keybd_event(VK_MENU, 0, 0, 0);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
}

function busySleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function focusWindow(hwnd: Hwnd | null | undefined, retries = 5, settleMs = 120): boolean {
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
        busySleep(50);
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
        if (attempt > 0) altUnlock();
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
      busySleep(settleMs);
      if (isForegroundWindow(h)) return true;
    } catch {
      busySleep(50);
    }
  }
  return isForegroundWindow(h);
}

export function focusGameWindow(keywords: string[], retries = 6): [WindowInfo | null, boolean] {
  try {
    const win = findGameWindow(keywords);
    if (!win) return [null, false];
    return [win, focusWindow(win.hwnd, retries)];
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

export function getCursorHandle(): number | null {
  const info = { cbSize: 24, flags: 0, hCursor: null, ptScreenPos: { x: 0, y: 0 } };
  if (!GetCursorInfo(info)) return null;
  const handle = ptrToNum(info.hCursor);
  return handle || null;
}

const hotspotCache = new Map<number, [number, number]>();

export function getCursorHotspot(): [number, number] {
  const handle = getCursorHandle();
  if (handle == null) return [0, 0];
  const cached = hotspotCache.get(handle);
  if (cached) return cached;
  let hotspot: [number, number] = [0, 0];
  const info = { fIcon: 0, xHotspot: 0, yHotspot: 0, hbmMask: null, hbmColor: null };
  const icon = hwndPtr(handle);
  if (icon && GetIconInfo(icon, info)) {
    hotspot = [info.xHotspot, info.yHotspot];
    if (info.hbmMask) DeleteObject(info.hbmMask);
    if (info.hbmColor) DeleteObject(info.hbmColor);
  }
  hotspotCache.set(handle, hotspot);
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
  SetCursorPos(Math.round(x), Math.round(y));
}

function sendMouse(flags: number): void {
  const buf = Buffer.alloc(INPUT_SIZE);
  buf.writeUInt32LE(INPUT_MOUSE, 0);
  buf.writeUInt32LE(flags, 20);
  SendInput(1, buf, INPUT_SIZE);
}

function sendKey(scan: number, up: boolean): void {
  const buf = Buffer.alloc(INPUT_SIZE);
  buf.writeUInt32LE(INPUT_KEYBOARD, 0);
  buf.writeUInt16LE(0, 8);
  buf.writeUInt16LE(scan, 10);
  buf.writeUInt32LE(KEYEVENTF_SCANCODE | (up ? KEYEVENTF_KEYUP : 0), 12);
  SendInput(1, buf, INPUT_SIZE);
}

export function clickButton(button: "left" | "right"): void {
  const down = button === "right" ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
  const up = button === "right" ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
  sendMouse(down);
  busySleep(20);
  sendMouse(up);
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

export function hotkey(...keys: string[]): void {
  const scans = keys.map((k) => {
    const key = k.toLowerCase();
    if (SCAN[key] != null) return SCAN[key];
    if (key.length === 1) return SCAN[key] ?? key.toUpperCase().charCodeAt(0);
    throw new Error(`不支持的按键: ${k}`);
  });
  for (const s of scans) sendKey(s, false);
  busySleep(12);
  for (const s of [...scans].reverse()) sendKey(s, true);
}

export function getClipboardText(): string {
  if (!OpenClipboard(null)) return "";
  try {
    const handle = GetClipboardData(CF_UNICODETEXT);
    if (!handle) return "";
    const ptr = GlobalLock(handle);
    if (!ptr) return "";
    try {
      if (Number(GlobalSize(handle)) <= 2) return "";
      return String(koffi.decode(ptr, "str16") || "");
    } finally {
      GlobalUnlock(handle);
    }
  } catch {
    return "";
  } finally {
    CloseClipboard();
  }
}

export function setClipboardText(text: string): boolean {
  const encoded = Buffer.concat([Buffer.from(text ?? "", "utf16le"), Buffer.from([0, 0])]);
  if (!OpenClipboard(null)) return false;
  let handle: unknown = null;
  try {
    EmptyClipboard();
    handle = GlobalAlloc(GMEM_MOVEABLE, encoded.length);
    if (!handle) return false;
    const locked = GlobalLock(handle);
    if (!locked) {
      GlobalFree(handle);
      return false;
    }
    RtlMoveMemory(locked, encoded, encoded.length);
    GlobalUnlock(handle);
    if (!SetClipboardData(CF_UNICODETEXT, handle)) {
      GlobalFree(handle);
      return false;
    }
    handle = null;
    return true;
  } catch {
    if (handle) GlobalFree(handle);
    return false;
  } finally {
    CloseClipboard();
  }
}

export function captureRegionBgra(left: number, top: number, width: number, height: number): Buffer {
  if (width <= 0 || height <= 0) throw new Error("截屏区域无效");
  const hdc = GetDC(null);
  if (!hdc) throw new Error("GetDC 失败");
  const mem = CreateCompatibleDC(hdc);
  const bmp = CreateCompatibleBitmap(hdc, width, height);
  const old = SelectObject(mem, bmp);
  try {
    if (!BitBlt(mem, 0, 0, width, height, hdc, left, top, SRCCOPY)) {
      throw new Error("BitBlt 失败");
    }
    const header = {
      biSize: 40,
      biWidth: width,
      biHeight: -height,
      biPlanes: 1,
      biBitCount: 32,
      biCompression: 0,
      biSizeImage: 0,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    };
    const pixels = Buffer.alloc(width * height * 4);
    const ok = GetDIBits(hdc, bmp, 0, height, pixels, header, 0);
    if (!ok) throw new Error("GetDIBits 失败");
    return pixels;
  } finally {
    SelectObject(mem, old);
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(null, hdc);
  }
}
