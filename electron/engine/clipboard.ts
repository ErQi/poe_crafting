import { getClipboardText, setClipboardText } from "./win32";

export function getClipboard(): string {
  try {
    return getClipboardText();
  } catch {
    return "";
  }
}

export function setClipboard(text: string): boolean {
  try {
    return setClipboardText(text);
  } catch {
    return false;
  }
}

export function clearClipboard(): void {
  for (let i = 0; i < 6; i++) {
    if (setClipboard("")) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
}

export function normalizeClipboardText(text: string): string {
  return (text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

export async function waitClipboardChange(
  previous: string,
  timeoutMs = 1500,
  pollMs = 2,
  rejectEmpty = true,
  rejectTexts: string[] = [],
): Promise<string | null> {
  const prev = normalizeClipboardText(previous);
  const rejected = new Set(rejectTexts.map(normalizeClipboardText).filter(Boolean));
  const deadline = Date.now() + timeoutMs;
  const interval = Math.max(1, pollMs);
  while (Date.now() < deadline) {
    const current = getClipboard();
    const key = normalizeClipboardText(current);
    if (key !== prev && !rejected.has(key) && !(rejectEmpty && !key)) return current;
    const remain = deadline - Date.now();
    if (remain <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(interval, remain)));
  }
  return null;
}
