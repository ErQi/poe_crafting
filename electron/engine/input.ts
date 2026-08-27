import { sleepMs } from "./timing";
import {
  clickButton,
  findGameWindow,
  focusGameWindow,
  focusWindow,
  getCursorHandle,
  getCursorHotspot,
  getCursorPosition,
  hotkey,
  isForegroundWindow,
  isMinimizedWindow,
  isWindowAvailable,
  moveTo,
  peekWindow,
  postWindowCopy,
  postWindowMouseButton,
  postWindowMouseMove,
  sendWindowCopyWithThreadState,
  type WindowInfo,
  windowMetrics,
} from "./win32";

export {
  findGameWindow,
  focusGameWindow,
  focusWindow,
  getCursorHandle,
  getCursorHotspot,
  getCursorPosition,
  hotkey,
  isForegroundWindow,
  isMinimizedWindow,
  isWindowAvailable,
  peekWindow,
  postWindowCopy,
  postWindowMouseButton,
  postWindowMouseMove,
  sendWindowCopyWithThreadState,
  type WindowInfo,
  windowMetrics,
};

export async function clickScreen(x: number, y: number, settleMs = 40, button: "left" | "right"): Promise<void> {
  moveTo(x, y);
  await sleepMs(settleMs);
  clickButton(button);
}

export async function moveScreen(x: number, y: number, settleMs = 40): Promise<void> {
  moveTo(x, y);
  await sleepMs(settleMs);
}

export async function clickWindowClient(
  hwnd: WindowInfo["hwnd"],
  clientX: number,
  clientY: number,
  settleMs = 40,
  button: "left" | "right",
): Promise<boolean> {
  if (!postWindowMouseMove(hwnd, clientX, clientY)) return false;
  await sleepMs(settleMs);
  let downSent = false;
  let upSent = false;
  try {
    downSent = postWindowMouseButton(hwnd, clientX, clientY, button, true);
    if (!downSent) return false;
    await sleepMs(Math.max(8, Math.min(settleMs, 40)));
    upSent = postWindowMouseButton(hwnd, clientX, clientY, button, false);
    return upSent;
  } finally {
    if (downSent && !upSent) postWindowMouseButton(hwnd, clientX, clientY, button, false);
  }
}
