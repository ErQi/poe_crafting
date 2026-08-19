const bridge = (window as unknown as {
  overlay: { on(channel: string, cb: (...args: any[]) => void): void };
}).overlay;

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

bridge.on("overlay:clear", () => clear());
bridge.on("overlay:line", (text: string, success?: boolean) => addLine(text, Boolean(success)));
bridge.on("overlay:lines", (lines: string[], success?: boolean) => {
  clear();
  for (const text of [...lines].reverse()) addLine(text, Boolean(success));
});
