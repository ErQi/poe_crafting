const { ipcRenderer } = require("electron") as typeof import("electron");

const host = document.getElementById("lines")!;
const MAX = 8;

function addLine(text: string, success = false): void {
  while (host.children.length >= MAX) host.lastElementChild?.remove();
  const el = document.createElement("div");
  el.className = `line ${success ? "ok" : "fail"}`;
  el.textContent = text;
  host.prepend(el);
}

function clear(): void {
  host.innerHTML = "";
}

ipcRenderer.on("overlay:clear", () => clear());
ipcRenderer.on("overlay:line", (_e, text: string, success?: boolean) => addLine(text, Boolean(success)));
ipcRenderer.on("overlay:lines", (_e, lines: string[], success?: boolean) => {
  clear();
  for (const text of [...lines].reverse()) addLine(text, Boolean(success));
});
