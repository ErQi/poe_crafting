function api() {
  return window.craft;
}

export function ready() {
  if (api()?.invoke) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (api()?.invoke) {
        clearInterval(timer);
        resolve();
      }
    }, 30);
  });
}

function toPayload(args) {
  if (!args.length) return null;
  try {
    return JSON.parse(JSON.stringify(args.map((a) => (a === undefined ? null : a))));
  } catch {
    return null;
  }
}

export async function call(name, ...args) {
  const bridge = api();
  if (!bridge?.invoke) throw new Error("未连接到工艺引擎");
  try {
    return await bridge.invoke(name, toPayload(args));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${name}: ${msg}`);
  }
}

export function onPush(cb) {
  return api()?.onPush?.(cb);
}

export function splashReady() {
  api()?.splashReady?.();
}

export function onBootStatus(cb) {
  return api()?.onBootStatus?.(cb);
}

function winApi() {
  return api()?.window;
}

export function minimizeWindow() {
  return winApi()?.minimize?.();
}

export function toggleMaximizeWindow() {
  return winApi()?.maximize?.();
}

export function closeWindow() {
  return winApi()?.close?.();
}

export function isWindowMaximized() {
  const fn = winApi()?.isMaximized;
  return fn ? Promise.resolve(fn()) : Promise.resolve(false);
}

export function onWindowMaximized(cb) {
  return winApi()?.onMaximized?.(cb);
}

export function debounce(fn, ms = 280) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function isTextField(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return Boolean(el.isContentEditable);
}
