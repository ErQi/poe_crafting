import fs from "fs";
import os from "os";
import path from "path";
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen, type IpcMainInvokeEvent } from "electron";
import { AppHost } from "./engine/host";
import { initFileLog, logPath } from "./logger";
import { formatMatchOverlayLine } from "./engine/overlayFormat";
import { RunStatus } from "./engine/models";
import {
  bundlePath,
  dataRoot,
  hasUserConfig,
  importLegacyConfig,
  legacyConfigDir,
  seedUserData,
} from "./engine/paths";

const DEV =
  !app.isPackaged &&
  (process.env.ELECTRON_DEV === "1" || process.env.POE_DEV === "1" || process.argv.includes("--dev"));
const DEV_URL = process.env.ELECTRON_START_URL || "http://127.0.0.1:5173";

function resolveDevUserData(): string {
  const local = bundlePath(".electron-data");
  try {
    fs.mkdirSync(local, { recursive: true });
    fs.accessSync(local, fs.constants.W_OK);
    return local;
  } catch {
    const tmp = path.join(os.tmpdir(), "poe-crafting-electron");
    fs.mkdirSync(tmp, { recursive: true });
    return tmp;
  }
}

app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
// 品牌更名不迁移用户数据目录，避免老用户升级后看起来像配置被清空。
if (app.isPackaged) {
  app.setPath("userData", path.join(app.getPath("appData"), "PoeCrafting"));
}
if (DEV) {
  app.setPath("userData", resolveDevUserData());
  app.commandLine.appendSwitch("disk-cache-size", "0");
  app.commandLine.appendSwitch("disable-http-cache");
  app.commandLine.appendSwitch(
    "disable-features",
    "LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests",
  );
}

initFileLog(app.getPath("userData"));

const BOOT_MS = 30000;
const SPLASH_WAIT_MS = 8000;

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let overlayHideTimer: ReturnType<typeof setTimeout> | undefined;
let lastAttempt = -1;
let host: AppHost | null = null;
let bootStarted = false;
let bootStatus: { ok: boolean; error?: string } | null = null;
let windowReady = false;
let pendingFocus = false;
let crashNotified = false;

/** 打包版没有控制台，任何致命错误都必须弹窗，否则用户只看到「点了没反应」 */
function fatal(title: string, message: string): never {
  console.error(`[main] ${title}: ${message}`);
  try {
    dialog.showErrorBox(title, `${message}\n\n日志: ${logPath()}`);
  } catch (e) {
    console.error("[main] showErrorBox 失败:", e);
  }
  app.exit(1);
  throw new Error(message);
}

function overlayFile(): string {
  return path.join(__dirname, "overlay.html");
}

function placeOverlay(anchor: { x: number; y: number }): void {
  if (!overlayWindow) return;
  const area = screen.getDisplayNearestPoint(anchor).workArea;
  const w = 420;
  const h = 276;
  overlayWindow.setBounds({ x: area.x + area.width - w - 18, y: area.y + area.height - h - 18, width: w, height: h });
}

function overlaySend(channel: string, ...args: unknown[]): void {
  const win = overlayWindow;
  if (!win || win.isDestroyed()) return;
  try {
    if (win.webContents.isDestroyed()) return;
    win.webContents.send(channel, ...args);
  } catch (e) {
    console.error("[overlay] send:", e);
  }
}

function createOverlay(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 276,
    frame: false,
    transparent: false,
    backgroundColor: "#12141a",
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "overlayPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    win.setIgnoreMouseEvents(true);
  } catch (e) {
    console.error("[overlay] setIgnoreMouseEvents:", e);
  }
  try {
    win.setAlwaysOnTop(true, "pop-up-menu");
  } catch {
    try {
      win.setAlwaysOnTop(true);
    } catch (e) {
      console.error("[overlay] setAlwaysOnTop:", e);
    }
  }
  void win.loadFile(overlayFile()).catch((e) => console.error("[overlay] 加载失败:", e));
  return win;
}

function clearOverlayHideTimer(): void {
  if (!overlayHideTimer) return;
  clearTimeout(overlayHideTimer);
  overlayHideTimer = undefined;
}

/** 隐藏的窗口对 window-all-closed 来说仍算「开着」，关主窗口时必须真销毁 */
function destroyOverlay(): void {
  clearOverlayHideTimer();
  try {
    overlayWindow?.destroy();
  } catch (e) {
    console.error("[overlay] destroy:", e);
  }
  overlayWindow = null;
}

function overlayApi() {
  return {
    resetRun() {
      lastAttempt = -1;
    },
    show(anchor: { x: number; y: number }) {
      try {
        clearOverlayHideTimer();
        if (!overlayWindow || overlayWindow.isDestroyed()) overlayWindow = createOverlay();
        placeOverlay(anchor);
        overlayWindow.showInactive();
      } catch (e) {
        console.error("[overlay] 显示失败:", e);
        destroyOverlay();
      }
    },
    hide() {
      clearOverlayHideTimer();
      try {
        overlayWindow?.hide();
        overlaySend("overlay:clear");
      } catch (e) {
        console.error("[overlay] hide:", e);
      }
    },
    addLine(text: string, success = false) {
      overlaySend("overlay:line", text, success);
    },
    pushStatus(status: RunStatus) {
      if (!status.running) {
        this.hide();
        return;
      }
      if (!status.lastMatch || status.parseFailures) return;
      if (status.attempt === lastAttempt) return;
      lastAttempt = status.attempt;
      let line = formatMatchOverlayLine(status.attempt, status.lastMatch);
      if (status.workflowStepName) {
        line = `[${status.workflowStepIndex}. ${status.workflowStepName.slice(0, 14)}] ${line}`;
      }
      this.addLine(line, Boolean(status.lastMatch.success));
    },
    showCompletion(lines: string[], success: boolean) {
      try {
        clearOverlayHideTimer();
        if (!overlayWindow || overlayWindow.isDestroyed()) overlayWindow = createOverlay();
        overlayWindow.showInactive();
        overlaySend("overlay:lines", lines, success);
        overlayHideTimer = setTimeout(() => this.hide(), 5000);
      } catch (e) {
        console.error("[overlay] 完成提示失败:", e);
      }
    },
  };
}

function hotkeyErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/Invalid argument/i.test(raw)) return "未找到流放之路窗口";
  return raw || "热键处理失败";
}

function notifyHotkeyFail(err: unknown): void {
  const message = hotkeyErrorText(err);
  console.error("[hotkey] start fail:", err);
  try {
    host?.notifyError("启动失败", message);
  } catch {
    /* host 尚未就绪或窗口已销毁 */
  }
}

type HotkeyKind = "start" | "stop";
const HOTKEY_LABEL: Record<HotkeyKind, string> = { start: "开始热键", stop: "停止热键" };
let activeHotkeys: Record<HotkeyKind, string> = { start: "", stop: "" };

function runHotkey(key: string, kind: HotkeyKind): void {
  console.log(`[hotkey] ${key}`);
  void (async () => {
    try {
      const result = kind === "start" ? await host?.onHotkeyStart() : host?.onHotkeyStop();
      if (kind !== "start") return;
      if (result && typeof result === "object" && "ok" in result && (result as { ok?: boolean }).ok === false) {
        console.error("[hotkey] start fail:", (result as { error?: string }).error);
        return;
      }
      console.log("[hotkey] start accepted");
    } catch (err) {
      if (kind === "start") notifyHotkeyFail(err);
      else console.error(`[hotkey] ${key} fail:`, err);
    }
  })();
}

/** register() 返回 false 表示被别的程序占用，非法键名则直接抛错，两种都要拿到 */
function tryRegister(accel: string, kind: HotkeyKind): boolean {
  try {
    return globalShortcut.register(accel, () => runHotkey(accel, kind));
  } catch (e) {
    console.error(`[hotkey] register ${accel} 失败:`, e);
    return false;
  }
}

/**
 * 停止热键是工艺运行中唯一的中断手段（游戏在前台，界面按钮点不到），
 * 注册失败必须让用户看见，并回退到上一个还能用的键而不是留空。
 */
function registerHotkeys(): void {
  if (!host) return;
  globalShortcut.unregisterAll();
  const wanted: Record<HotkeyKind, string> = {
    start: (host.settings.hotkeyStart || "f7").toUpperCase(),
    stop: (host.settings.hotkeyStop || "f8").toUpperCase(),
  };
  const next: Record<HotkeyKind, string> = { start: "", stop: "" };
  const failed: string[] = [];
  for (const kind of ["start", "stop"] as const) {
    const accel = wanted[kind];
    if (kind === "stop" && accel === next.start) {
      failed.push(`${HOTKEY_LABEL.stop}与开始热键同为 ${accel}，未注册；请在设置里换一个`);
      continue;
    }
    if (tryRegister(accel, kind)) {
      next[kind] = accel;
      continue;
    }
    const previous = activeHotkeys[kind];
    if (previous && previous !== accel && previous !== next.start && tryRegister(previous, kind)) {
      next[kind] = previous;
      failed.push(`${HOTKEY_LABEL[kind]} ${accel} 注册失败，已回退到 ${previous}`);
    } else {
      failed.push(`${HOTKEY_LABEL[kind]} ${accel} 注册失败，可能被其他程序占用，请在设置里换一个`);
    }
  }
  activeHotkeys = next;
  host.setActiveHotkeys(next.start, next.stop);
  console.log(`[hotkey] 已注册 start=${next.start || "无"} stop=${next.stop || "无"}`);
  if (failed.length) host.notifyError("热键注册失败", failed.join("\n"));
}

function sendBootStatus(status: { ok: boolean; error?: string }): void {
  bootStatus = status;
  mainWindow?.webContents.send("boot-status", status);
}

/** 洗地图校准：进入校准模式时临时把 F6 用作校准热键（捕获当前「起始格/结束格」模式对应的格位），退出即恢复正式开始/停止热键。 */
function bindMapWashHotkeys(): void {
  if (!host) return;
  host.onMapWashCalibration((enabled) => {
    // 先复位正式开始/停止热键（会 unregisterAll），再按需叠加校准热键
    try {
      registerHotkeys();
    } catch (e) {
      console.error("[hotkey] 复位失败:", e);
    }
    if (!enabled) return;
    try {
      globalShortcut.register("F6", () => host?.captureMapWashCalibrateActive());
    } catch (e) {
      console.error("[hotkey] 注册校准 F6 失败:", e);
    }
  });
}

function scheduleBoot(): void {
  setImmediate(() => {
    if (!host) return;
    const current = host;
    console.log("[main] boot 开始");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("初始化超时")), BOOT_MS);
    });
    void Promise.race([current.boot(), limit])
      .then(() => {
        if (timer) clearTimeout(timer);
        console.log("[main] boot 结束");
        sendBootStatus({ ok: true });
      })
      .catch((err) => {
        if (timer) clearTimeout(timer);
        const raw = err instanceof Error ? err.message : String(err);
        const error = /超时/.test(raw) ? "初始化超时，识别功能可能不可用" : `初始化失败: ${raw}`;
        console.error("[main] boot failed:", err);
        current.noteInitError(error);
        sendBootStatus({ ok: false, error });
      });
  });
}

function listenSplashReady(): void {
  ipcMain.on("splash-ready", (e) => {
    if (e.sender !== mainWindow?.webContents) return;
    if (bootStatus) {
      e.sender.send("boot-status", bootStatus);
      return;
    }
    if (bootStarted) return;
    bootStarted = true;
    scheduleBoot();
  });
  setTimeout(() => {
    if (bootStarted) return;
    console.log("[main] splash-ready 未收到，继续 boot");
    bootStarted = true;
    scheduleBoot();
  }, SPLASH_WAIT_MS);
}

function senderWindow(e: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender);
}

function notifyMaximized(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.webContents.send("window:maximized", win.isMaximized());
}

function bindWindowChrome(): void {
  ipcMain.handle("window:minimize", (e) => {
    senderWindow(e)?.minimize();
    return null;
  });
  ipcMain.handle("window:maximize", (e) => {
    const win = senderWindow(e);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle("window:close", (e) => {
    senderWindow(e)?.close();
    return null;
  });
  ipcMain.handle("window:isMaximized", (e) => Boolean(senderWindow(e)?.isMaximized()));
}

/**
 * 老用户一直在项目目录里跑，装了 portable 后会以为流程库丢了。
 * 首次运行且 userData 还没有配置时，探测 exe 同目录并询问是否导入。
 */
function offerLegacyImport(): void {
  if (!app.isPackaged || hasUserConfig()) return;
  const dir = legacyConfigDir();
  if (!dir) return;
  const choice = dialog.showMessageBoxSync({
    type: "question",
    buttons: ["导入", "跳过"],
    defaultId: 0,
    cancelId: 1,
    title: "发现已有配置",
    message: "是否导入旧版配置？",
    detail: `来源: ${dir}\n目标: ${path.join(dataRoot(), "config")}`,
  });
  if (choice !== 0) return;
  const done = importLegacyConfig(dir);
  console.log("[main] 已导入旧配置:", done.join("、") || "无");
}

/** 透明无边框窗口在加载失败时完全看不见，所以等内容画出来再显示 */
function revealMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  windowReady = true;
  mainWindow.show();
  if (!pendingFocus) return;
  pendingFocus = false;
  focusMain();
}

/** loadJson 已做隔离，这里再兜一层：宁可带默认配置起来，也不要留个透明空窗口 */
function createHost(): AppHost {
  try {
    return new AppHost();
  } catch (e) {
    console.error("[main] 配置加载失败，重试一次:", e);
    try {
      return new AppHost();
    } catch (retryErr) {
      return fatal("配置加载失败", String(retryErr));
    }
  }
}

function bindHost(): void {
  offerLegacyImport();
  for (const line of seedUserData()) console.log("[main]", line);
  host = createHost();
  host.attach((rt) => mainWindow?.webContents.send("poe-push", rt), overlayApi());
  host.onHotkeysChanged(registerHotkeys);
  ipcMain.handle("craft:invoke", async (e, name: string, payload: unknown) => {
    if (e.sender !== mainWindow?.webContents) throw new Error("非法调用来源");
    if (!host) throw new Error("宿主尚未就绪");
    const args = payload == null ? [] : Array.isArray(payload) ? payload : [payload];
    try {
      if (String(name) === "price_patch_choose_client_root") {
        const requested = String(args[0] || "").trim();
        const options: Electron.OpenDialogOptions = {
          title: "选择《流放之路》国服客户端目录",
          buttonLabel: "选择此目录",
          properties: ["openDirectory"],
          ...(requested && fs.existsSync(requested) ? { defaultPath: requested } : {}),
        };
        const selected = mainWindow
          ? await dialog.showOpenDialog(mainWindow, options)
          : await dialog.showOpenDialog(options);
        if (selected.canceled || !selected.filePaths[0]) return { ok: true, canceled: true };
        return (await host.invoke("price_patch_set_client_root", [selected.filePaths[0]])) ?? null;
      }
      return (await host.invoke(String(name || ""), args)) ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(/Invalid argument/i.test(msg) ? "未找到流放之路窗口" : `${name}: ${msg}`);
    }
  });
  registerHotkeys();
  bindMapWashHotkeys();
  listenSplashReady();
}

async function createMain(): Promise<void> {
  const win = new BrowserWindow({
    title: "POE Tools",
    width: 1180,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    show: false,
    frame: false,
    transparent: true,
    roundedCorners: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  console.log("[main] 窗口已创建");
  if (DEV) allowViteHmr(win);
  win.once("ready-to-show", () => revealMain());
  bindWindowChrome();
  win.on("maximize", () => notifyMaximized(win));
  win.on("unmaximize", () => notifyMaximized(win));
  win.on("closed", () => {
    mainWindow = null;
    destroyOverlay();
    host?.shutdown();
  });
  bindHost();
  if (DEV) {
    win.webContents.once("did-finish-load", () => {
      if (win.isDestroyed()) return;
      win.webContents.openDevTools({ mode: "detach" });
    });
  }
  try {
    if (DEV) {
      console.log("[main] 开发模式加载", DEV_URL);
      await Promise.race([win.loadURL(DEV_URL), timeout(15000, "页面加载")]);
    } else {
      console.log("[main] 生产模式加载 web/dist（npm start 不会自动刷新）");
      await Promise.race([win.loadFile(bundlePath("web/dist/index.html")), timeout(15000, "页面加载")]);
    }
  } catch (err) {
    fatal("页面加载失败", DEV ? `${DEV_URL}\n${String(err)}` : String(err));
  }
  revealMain();
}

function allowViteHmr(win: BrowserWindow): void {
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase().startsWith("content-security-policy")) delete headers[key];
    }
    callback({ responseHeaders: headers });
  });
}

function timeout(ms: number, label: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}超时`)), ms));
}

/**
 * 装了处理器就关掉了 Electron 默认的崩溃退出：opencv / koffi 可能已经处于坏状态，
 * 最坏情况是继续用错误的坐标点鼠标，所以先停自动化再提示。
 */
function onCrash(label: string, err: unknown, fatalBeforeReady: boolean): void {
  console.error(`[main] ${label}:`, err);
  const detail = err instanceof Error ? err.message : String(err);
  if (fatalBeforeReady && !windowReady) fatal("启动失败", `${label}: ${detail}`);
  try {
    host?.shutdown();
  } catch (e) {
    console.error("[main] 崩溃后停止自动化失败:", e);
  }
  if (crashNotified) return;
  crashNotified = true;
  try {
    host?.notifyError("内部错误", `已停止工艺，建议重启程序。\n${label}: ${detail}\n日志: ${logPath()}`);
  } catch (e) {
    console.error("[main] 崩溃提示失败:", e);
  }
}

process.on("uncaughtException", (err) => onCrash("未捕获异常", err, true));
// Promise 拒绝比同步异常更容易是良性的，只提示不退出，避免启动期误杀
process.on("unhandledRejection", (reason) => onCrash("未处理的 Promise 拒绝", reason, false));

function focusMain(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return true;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log("[main] 已有实例在运行，退出以免抢缓存");
  app.quit();
} else {
  if (DEV) {
    try {
      fs.writeFileSync(path.join(app.getPath("userData"), "main.pid"), String(process.pid), "utf8");
    } catch (e) {
      console.error("[main] 写 pid 文件失败:", e);
    }
  }
  // 启动那一两秒里用户再点一次图标，第二个进程会静默退出，这里记下来等窗口出来补聚焦
  app.on("second-instance", () => {
    if (!focusMain()) pendingFocus = true;
  });
  app.whenReady().then(() => {
    void createMain().catch((err) => fatal("启动失败", String(err)));
  });
}
app.on("window-all-closed", () => {
  destroyOverlay();
  globalShortcut.unregisterAll();
  app.quit();
});
app.on("will-quit", () => globalShortcut.unregisterAll());
