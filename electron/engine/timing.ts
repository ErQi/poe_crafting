export async function sleepMs(ms: number, shouldStop?: () => boolean): Promise<boolean> {
  if (ms <= 0) return Boolean(shouldStop?.());
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (shouldStop?.()) return true;
    await new Promise((r) => setTimeout(r, Math.min(50, Math.max(0, end - Date.now()))));
  }
  return Boolean(shouldStop?.());
}

export async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  timeoutMs: number,
  pollMs = 4,
  shouldStop?: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const interval = Math.max(1, pollMs);
  while (true) {
    if (shouldStop?.()) return false;
    if (await pred()) return true;
    const remain = deadline - Date.now();
    if (remain <= 0) return false;
    await new Promise((r) => setTimeout(r, Math.min(interval, remain)));
  }
}
