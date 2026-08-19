import { contextBridge, ipcRenderer } from "electron";

const CHANNELS = ["overlay:clear", "overlay:line", "overlay:lines"];

contextBridge.exposeInMainWorld("overlay", {
  on(channel: string, cb: (...args: unknown[]) => void): void {
    if (!CHANNELS.includes(channel)) return;
    ipcRenderer.on(channel, (_e, ...args) => cb(...args));
  },
});
