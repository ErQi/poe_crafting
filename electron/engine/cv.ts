export type CvApi = any;
export type Mat = any;

let ready: Promise<CvApi> | null = null;

function removeNewListeners(event: "unhandledRejection" | "uncaughtException", before: Function[]): void {
  const listeners = (process.listeners as unknown as (name: string) => Function[])(event);
  for (const listener of listeners) {
    if (!before.includes(listener)) process.removeListener(event, listener as never);
  }
}

function disarmEmscriptenExits(beforeReject: Function[], beforeUncaught: Function[]): void {
  removeNewListeners("unhandledRejection", beforeReject);
  removeNewListeners("uncaughtException", beforeUncaught);
}

export async function loadCv(): Promise<CvApi> {
  if (!ready) {
    ready = new Promise<CvApi>((resolve, reject) => {
      setImmediate(() => {
        const beforeReject = process.listeners("unhandledRejection").slice();
        const beforeUncaught = process.listeners("uncaughtException").slice();
        try {
          console.log("[cv] opencv-wasm 开始加载");
          const wasm = require("opencv-wasm");
          const api = wasm.cv;
          if (!api?.Mat) throw new Error("opencv-wasm 未能初始化");
          if (typeof api.then === "function") delete api.then;
          disarmEmscriptenExits(beforeReject, beforeUncaught);
          try {
            api.onAbort = (what: unknown) => {
              console.error("[cv] opencv abort:", what);
            };
          } catch {
            /* ignore */
          }
          setImmediate(() => disarmEmscriptenExits(beforeReject, beforeUncaught));
          console.log("[cv] opencv-wasm 已就绪");
          resolve(api);
        } catch (err) {
          disarmEmscriptenExits(beforeReject, beforeUncaught);
          ready = null;
          reject(err);
        }
      });
    });
  }
  return ready;
}
