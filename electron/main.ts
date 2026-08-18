import path from "path";
import { app, BrowserWindow, globalShortcut, ipcMain, screen, type IpcMainInvokeEvent } from "electron";
import { setProjectRoot } from "./engine/configStore";
import { AppHost } from "./engine/host";
import { formatMatchOverlayLine } from "./engine/overlayFormat";
import { RunStatus } from "./engine/models";

setProjectRoot(path.resolve(__dirname, "..", ".."));

const DEV =
  process.env.ELECTRON_DEV === "1" || process.env.POE_DEV === "1" || process.argv.includes("--dev");
const DEV_URL = process.env.ELECTRON_START_URL || "http://127.0.0.1:5173";

if (DEV) {
  app.commandLine.appendSwitch(
    "disable-features",
    "LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests",
  );
}

const BOOT_MS = 30000;
const SPLASH_WAIT_MS = 8000;

let mainWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let lastAttempt = -1;
let host: AppHost;
let bootStarted = false;
let bootStatus: { ok: boolean; error?: string } | null = null;

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

function createOverlay(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 276,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, "screen-saver");
  win.loadFile(overlayFile());
  return win;
}

function overlayApi() {
  return {
    resetRun() {
      lastAttempt = -1;
    },
    show(anchor: { x: number; y: number }) {
      if (!overlayWindow) overlayWindow = createOverlay();
      placeOverlay(anchor);
      overlayWindow.showInactive();
    },
    hide() {
      overlayWindow?.hide();
      overlayWindow?.webContents.send("overlay:clear");
    },
    addLine(text: string, success = false) {
      overlayWindow?.webContents.send("overlay:line", text, success);
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
      if (!overlayWindow) overlayWindow = createOverlay();
      overlayWindow.showInactive();
      overlayWindow.webContents.send("overlay:lines", lines, success);
      setTimeout(() => this.hide(), 5000);
    },
  };
}

function registerHotkeys(): void {
  globalShortcut.unregisterAll();
  const start = (host.settings.hotkeyStart || "f7").toUpperCase();
  const stop = (host.settings.hotkeyStop || "f8").toUpperCase();
  try {
    globalShortcut.register(start, () => host.onHotkeyStart());
  } catch {
    /* ignore */
  }
  if (stop !== start) {
    try {
      globalShortcut.register(stop, () => host.onHotkeyStop());
    } catch {
      /* ignore */
    }
  }
}

function sendBootStatus(status: { ok: boolean; error?: string }): void {
  bootStatus = status;
  mainWindow?.webContents.send("boot-status", status);
}

function scheduleBoot(): void {
  setImmediate(() => {
    console.log("[main] boot 开始");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("初始化超时")), BOOT_MS);
    });
    void Promise.race([host.boot(), limit])
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
        host.noteInitError(error);
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

async function createMain(): Promise<void> {
  mainWindow = new BrowserWindow({
    title: "PoE1 自动工艺",
    width: 1180,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    show: true,
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
  console.log("[main] 窗口已创建");
  if (DEV) allowViteHmr(mainWindow);
  host = new AppHost();
  host.attach((rt) => mainWindow?.webContents.send("poe-push", rt), overlayApi());
  host.bindHotkeys(registerHotkeys, registerHotkeys);
  bindWindowChrome();
  mainWindow.on("maximize", () => {
    if (mainWindow) notifyMaximized(mainWindow);
  });
  mainWindow.on("unmaximize", () => {
    if (mainWindow) notifyMaximized(mainWindow);
  });
  ipcMain.handle("craft:invoke", async (_e, name: string, payload: unknown) => {
    const args = payload == null ? [] : Array.isArray(payload) ? payload : [payload];
    try {
      const result = await host.invoke(String(name || ""), args);
      if (name === "save_settings" || name === "update_settings") registerHotkeys();
      return result ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(/Invalid argument/i.test(msg) ? "未找到流放之路窗口" : `${name}: ${msg}`);
    }
  });
  registerHotkeys();
  listenSplashReady();
  if (DEV) {
    mainWindow.webContents.once("did-finish-load", () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.openDevTools({ mode: "detach" });
    });
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
    host.shutdown();
  });
  try {
    if (DEV) {
      console.log("[main] 开发模式加载", DEV_URL);
      await Promise.race([mainWindow.loadURL(DEV_URL), timeout(15000, "页面加载")]);
    } else {
      console.log("[main] 生产模式加载 web/dist（npm start 不会自动刷新）");
      await Promise.race([
        mainWindow.loadFile(path.join(__dirname, "..", "..", "web", "dist", "index.html")),
        timeout(15000, "页面加载"),
      ]);
    }
  } catch (err) {
    console.error("[main] 页面加载失败:", err);
  }
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

app.whenReady().then(() => {
  void createMain().catch((err) => console.error("[main] createMain failed:", err));
});
app.on("window-all-closed", () => {
  globalShortcut.unregisterAll();
  overlayWindow?.destroy();
  app.quit();
});
app.on("will-quit", () => globalShortcut.unregisterAll());
