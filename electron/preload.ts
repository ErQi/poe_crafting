import { contextBridge, ipcRenderer } from "electron";

function jsonClone(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

contextBridge.exposeInMainWorld("craft", {
  invoke: (name: string, payload: unknown = null) =>
    ipcRenderer.invoke("craft:invoke", String(name), jsonClone(payload)),
  onPush: (cb: (rt: unknown) => void) => {
    const handler = (_e: unknown, data: unknown) => cb(data);
    ipcRenderer.on("poe-push", handler);
    return () => ipcRenderer.removeListener("poe-push", handler);
  },
  splashReady: () => ipcRenderer.send("splash-ready"),
  onBootStatus: (cb: (status: { ok: boolean; error?: string }) => void) => {
    const handler = (_e: unknown, data: { ok: boolean; error?: string }) => cb(data);
    ipcRenderer.on("boot-status", handler);
    return () => ipcRenderer.removeListener("boot-status", handler);
  },
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
    onMaximized: (cb: (max: boolean) => void) => {
      const handler = (_e: unknown, max: boolean) => cb(max);
      ipcRenderer.on("window:maximized", handler);
      return () => ipcRenderer.removeListener("window:maximized", handler);
    },
  },
});
