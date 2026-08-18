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
  moveTo,
  peekWindow,
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
  peekWindow,
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

export function pressKey(key: string): void {
  hotkey(key.toLowerCase());
}
