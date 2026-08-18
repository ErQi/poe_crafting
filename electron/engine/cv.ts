export type CvApi = any;
export type Mat = any;

let ready: Promise<CvApi> | null = null;

export async function loadCv(): Promise<CvApi> {
  if (!ready) {
    ready = new Promise<CvApi>((resolve, reject) => {
      setImmediate(() => {
        try {
          console.log("[cv] opencv-wasm 开始加载");
          const wasm = require("opencv-wasm");
          const api = wasm.cv;
          if (!api?.Mat) throw new Error("opencv-wasm 未能初始化");
          if (typeof api.then === "function") delete api.then;
          console.log("[cv] opencv-wasm 已就绪");
          resolve(api);
        } catch (err) {
          ready = null;
          reject(err);
        }
      });
    });
  }
  return ready;
}
