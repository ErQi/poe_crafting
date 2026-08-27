import fs from "fs";
import path from "path";
import { resolvePath } from "./configStore";
import { loadCv, type CvApi, type Mat } from "./cv";
import {
  captureRegionBgra,
  cursorPatchSize,
  findGameWindow,
  getCursorHotspot,
  getCursorPosition,
  isMinimizedWindow,
  type Hwnd,
  type WindowInfo,
  windowMetrics,
} from "./win32";
import { captureWindowWgcBgra } from "./wgcCapture";

export type { Mat };

export class VisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionError";
  }
}

/** opencv-wasm 失败时常抛出裸整数（Emscripten 异常指针），不是 BGR/阈值。 */
export function visionErrText(e: unknown): string {
  if (e instanceof VisionError) return e.message;
  const raw = e instanceof Error ? e.message : String(e);
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return `OpenCV内部异常 ${trimmed}`;
  return raw || "未知错误";
}

export interface MatchHit {
  name: string;
  score: number;
  screenX: number;
  screenY: number;
  clientX: number;
  clientY: number;
  width: number;
  height: number;
}

export const DEFAULT_SCALES_FAST = [1.0] as const;
export const DEFAULT_SCALES_FALLBACK = [1.0, 0.95, 1.05] as const;

let cv: CvApi;

export async function initVision(): Promise<void> {
  cv = await loadCv();
}

function requireCv(): CvApi {
  if (!cv) throw new VisionError("OpenCV 尚未初始化");
  return cv;
}

/** opencv-wasm 堆有限，禁止把 4K 整图送进 matFromArray / matchTemplate。 */
const WASM_MAX_SHORT = 1080;

/** 每个目标像素覆盖的源像素区间 [out[i], out[i+1])。 */
function boxBounds(n: number, len: number): Int32Array {
  const edges = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++) edges[i] = Math.min(len, Math.round((i * len) / n));
  for (let i = 0; i < n; i++) if (edges[i + 1] <= edges[i]) edges[i + 1] = Math.min(len, edges[i] + 1);
  return edges;
}

/**
 * 降采样必须与模板侧 resizeGray 的 INTER_AREA 同源：4K 下正好 2×2 盒式平均。
 * 用点采样会随机抽掉一两像素宽的高对比边框，TM_CCOEFF_NORMED 分数系统性偏低。
 */
function shrinkBgraForWasm(
  bgra: Buffer,
  width: number,
  height: number,
): { data: Uint8Array; width: number; height: number; scaleX: number; scaleY: number } {
  const short = Math.min(width, height);
  if (short <= WASM_MAX_SHORT) {
    return { data: new Uint8Array(bgra), width, height, scaleX: 1, scaleY: 1 };
  }
  const scale = WASM_MAX_SHORT / short;
  const nw = Math.max(1, Math.round(width * scale));
  const nh = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(nw * nh * 4);
  const xs = boxBounds(nw, width);
  const ys = boxBounds(nh, height);
  for (let y = 0; y < nh; y++) {
    const sy0 = ys[y];
    const sy1 = ys[y + 1];
    const dstRow = y * nw * 4;
    for (let x = 0; x < nw; x++) {
      const sx0 = xs[x];
      const sx1 = xs[x + 1];
      let b = 0;
      let g = 0;
      let r = 0;
      let a = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let si = (sy * width + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++, si += 4) {
          b += bgra[si];
          g += bgra[si + 1];
          r += bgra[si + 2];
          a += bgra[si + 3];
        }
      }
      const n = (sy1 - sy0) * (sx1 - sx0);
      const di = dstRow + x * 4;
      out[di] = (b / n + 0.5) | 0;
      out[di + 1] = (g / n + 0.5) | 0;
      out[di + 2] = (r / n + 0.5) | 0;
      out[di + 3] = (a / n + 0.5) | 0;
    }
  }
  return { data: out, width: nw, height: nh, scaleX: nw / width, scaleY: nh / height };
}

function attachSrcScale(mat: Mat, scaleX: number, scaleY: number): Mat {
  mat._srcScaleX = scaleX;
  mat._srcScaleY = scaleY;
  return mat;
}

function matScale(mat: Mat | null | undefined): { x: number; y: number } {
  const x = mat?._srcScaleX;
  const y = mat?._srcScaleY;
  return {
    x: typeof x === "number" && x > 0 ? x : 1,
    y: typeof y === "number" && y > 0 ? y : 1,
  };
}

function toClient(v: number, scale: number): number {
  return scale === 1 ? Math.round(v) : Math.round(v / scale);
}

function scaleNeedles(scales: readonly number[], srcScale: number): number[] {
  if (srcScale >= 0.999) return [...scales];
  return scales.map((s) => s * srcScale);
}

function scaleExcludes(
  regions: [number, number, number, number][] | undefined,
  sx: number,
  sy: number,
): [number, number, number, number][] | undefined {
  if (!regions?.length || (sx === 1 && sy === 1)) return regions;
  return regions.map(([l, t, r, b]) => [l * sx, t * sy, r * sx, b * sy]);
}

export function bgraToBgr(
  bgra: Buffer,
  width: number,
  height: number,
  sourceWidth = width,
  sourceHeight = height,
): Mat {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new VisionError("截图像素尺寸无效");
  }
  if (!Number.isInteger(sourceWidth) || !Number.isInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1) {
    throw new VisionError("截图源尺寸无效");
  }
  if (bgra.length < width * height * 4) throw new VisionError("截图像素缓冲大小不符");
  const api = requireCv();
  const fitted = shrinkBgraForWasm(bgra, width, height);
  try {
    const src = api.matFromArray(fitted.height, fitted.width, api.CV_8UC4, fitted.data);
    const bgr = new api.Mat();
    api.cvtColor(src, bgr, api.COLOR_BGRA2BGR);
    src.delete();
    return attachSrcScale(bgr, fitted.scaleX * (width / sourceWidth), fitted.scaleY * (height / sourceHeight));
  } catch (e) {
    throw new VisionError(`图像转换失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function captureRegion(left: number, top: number, width: number, height: number): Mat {
  return bgraToBgr(captureRegionBgra(left, top, width, height), width, height);
}

export function captureWindow(window: WindowInfo): Mat {
  const { width, height } = windowMetrics(window);
  if (width < 32 || height < 32) throw new VisionError("游戏窗口尺寸无效");
  return captureRegion(window.left, window.top, width, height);
}

/** 每次左键前会被轮询十余次：opencv 抛异常时必须释放 Mat 并返回 0（＝看不出差别＝不点击）。 */
export function patchRmse(a: Mat | null, b: Mat | null): number {
  if (!a || !b || a.rows !== b.rows || a.cols !== b.cols || a.channels() !== b.channels()) return 0;
  let diff: Mat | null = null;
  let b32: Mat | null = null;
  let sq: Mat | null = null;
  try {
    const api = requireCv();
    diff = new api.Mat();
    a.convertTo(diff, api.CV_32F);
    b32 = new api.Mat();
    b.convertTo(b32, api.CV_32F);
    api.subtract(diff, b32, diff);
    sq = new api.Mat();
    api.multiply(diff, diff, sq);
    const mean = api.mean(sq);
    let acc = 0;
    const n = a.channels();
    for (let i = 0; i < n; i++) acc += mean[i];
    return Math.sqrt(acc / n);
  } catch (e) {
    console.warn("[vision] 光标差异计算失败", visionErrText(e));
    return 0;
  } finally {
    for (const m of [diff, b32, sq]) {
      try {
        m?.delete();
      } catch {
        /* ignore */
      }
    }
  }
}

export function captureCursorPatch(size?: number): Mat | null {
  const patch = size == null ? cursorPatchSize() : Math.max(32, size);
  const [cx, cy] = getCursorPosition();
  const [hx, hy] = getCursorHotspot();
  try {
    return captureRegion(Math.max(0, cx - hx), Math.max(0, cy - hy), patch, patch);
  } catch {
    return null;
  }
}

function toGray(src: Mat): Mat {
  const api = requireCv();
  if (src.channels() === 1) return src.clone();
  const gray = new api.Mat();
  api.cvtColor(src, gray, api.COLOR_BGR2GRAY);
  return gray;
}

export function loadTemplate(file: string): Mat {
  const api = requireCv();
  if (!fs.existsSync(file)) throw new VisionError(`模板不存在: ${file}`);
  if (typeof api.imdecode === "function") {
    try {
      const bytes = fs.readFileSync(file);
      if (bytes.length < 24) throw new VisionError(`模板文件过小: ${file}`);
      const buf = api.matFromArray(1, bytes.length, api.CV_8UC1, new Uint8Array(bytes));
      try {
        const img = api.imdecode(buf, api.IMREAD_UNCHANGED);
        if (img && !img.empty()) return img;
        img?.delete?.();
      } finally {
        buf.delete();
      }
    } catch (e) {
      console.error("[vision] imdecode 失败，改用 Electron 读图:", e);
    }
  }
  const { nativeImage } = require("electron");
  const ni = nativeImage.createFromPath(file);
  if (ni.isEmpty()) throw new VisionError(`无法读取模板: ${file}`);
  const { width, height } = ni.getSize();
  if (width < 1 || height < 1) throw new VisionError(`模板尺寸无效: ${file}`);
  return api.matFromArray(height, width, api.CV_8UC4, new Uint8Array(ni.toBitmap()));
}

function sanitizeResult(result: Mat, fill: number): void {
  if (!result || result.rows <= 0 || result.cols <= 0) return;
  const data = result.data32F as Float32Array | undefined;
  if (!data || typeof data.length !== "number") return;
  for (let i = 0; i < data.length; i++) {
    if (!Number.isFinite(data[i])) data[i] = fill;
  }
}

function applyExclusions(
  result: Mat,
  exclude: [number, number, number, number][] | undefined,
  ss: number,
  nw: number,
  nh: number,
  fill: number,
): void {
  if (!exclude?.length) return;
  const rh = result.rows;
  const rw = result.cols;
  for (const [left, top, right, bottom] of exclude) {
    const x0 = Math.max(0, Math.min(rw, Math.floor(left * ss - nw / 2)));
    const x1 = Math.max(0, Math.min(rw, Math.ceil(right * ss - nw / 2)));
    const y0 = Math.max(0, Math.min(rh, Math.floor(top * ss - nh / 2)));
    const y1 = Math.max(0, Math.min(rh, Math.ceil(bottom * ss - nh / 2)));
    if (x1 > x0 && y1 > y0) {
      const roi = result.roi(new (requireCv().Rect)(x0, y0, x1 - x0, y1 - y0));
      roi.setTo(new (requireCv().Scalar)(fill));
      roi.delete();
    }
  }
}

function resizeGray(src: Mat, w: number, h: number, scale: number): Mat {
  const api = requireCv();
  const dst = new api.Mat();
  api.resize(src, dst, new api.Size(w, h), 0, 0, scale < 1 ? api.INTER_AREA : api.INTER_LINEAR);
  return dst;
}

export function matchTemplate(
  haystackBgr: Mat | null,
  needleBgr: Mat | null,
  threshold = 0.82,
  scales: readonly number[] | null = null,
  haystackGray?: Mat | null,
  needleGray?: Mat | null,
  needleMask?: Mat | null,
  searchScale = 1.0,
  excludeRegions?: [number, number, number, number][],
): [number, number, number, number, number] | null {
  const api = requireCv();
  const grayH = haystackGray ?? (haystackBgr ? toGray(haystackBgr) : null);
  const grayN0 = needleGray ?? (needleBgr ? toGray(needleBgr) : null);
  const ownH = !haystackGray && grayH;
  const ownN = !needleGray && grayN0;
  if (!grayH || !grayN0) {
    if (ownH) grayH?.delete();
    if (ownN) grayN0?.delete();
    return null;
  }
  try {
    const hImg = grayH.rows;
    const wImg = grayH.cols;
    if (Math.min(hImg, wImg) > WASM_MAX_SHORT + 16) {
      throw new VisionError(`画面过大，已拒绝送入 OpenCV: ${wImg}x${hImg}`);
    }
    const scaleList = [...(scales ?? DEFAULT_SCALES_FAST)];
    let ss = searchScale > 0 ? Math.min(searchScale, 1) : 1;
    let smallH = grayH;
    let ownSmall = false;
    if (ss < 0.99) {
      smallH = resizeGray(grayH, Math.max(1, Math.floor(wImg * ss)), Math.max(1, Math.floor(hImg * ss)), ss);
      ownSmall = true;
    } else ss = 1;
    const sh = smallH.rows;
    const sw = smallH.cols;
    let best: [number, number, number, number, number] | null = null;
    const ordered = scaleList.includes(1) ? [1, ...scaleList.filter((s) => s !== 1)] : scaleList;
    try {
      for (const scale of ordered) {
        const nh = Math.max(1, Math.floor(grayN0.rows * scale * ss));
        const nw = Math.max(1, Math.floor(grayN0.cols * scale * ss));
        if (nh >= sh || nw >= sw) continue;
        const noResize = Math.abs(scale * ss - 1) < 1e-6 && ss === 1;
        const needle = noResize ? grayN0 : resizeGray(grayN0, nw, nh, scale * ss);
        let mask: Mat | null = null;
        if (needleMask) {
          mask = noResize ? needleMask : resizeGray(needleMask, nw, nh, scale * ss);
          const data = mask.data as Uint8Array | undefined;
          if (data) {
            for (let i = 0; i < data.length; i++) if (data[i] < 8) data[i] = 0;
          }
        }
        const result = new api.Mat();
        const method = mask ? api.TM_CCORR_NORMED : api.TM_CCOEFF_NORMED;
        let score = -1;
        try {
          if (mask) api.matchTemplate(smallH, needle, result, method, mask);
          else api.matchTemplate(smallH, needle, result, method);
          sanitizeResult(result, -1);
          applyExclusions(result, excludeRegions, ss, nw, nh, -1);
          const loc = api.minMaxLoc(result);
          score = loc.maxVal;
          const ox = Math.round(loc.maxLoc.x / ss);
          const oy = Math.round(loc.maxLoc.y / ss);
          const ow = Math.max(1, Math.round(needle.cols / ss));
          const oh = Math.max(1, Math.round(needle.rows / ss));
          if (!best || score > best[0]) best = [score, ox, oy, ow, oh];
        } catch (e) {
          console.warn("[vision] 模板匹配跳过 scale", scale, visionErrText(e));
        }
        result.delete();
        if (!noResize) needle.delete();
        if (mask && !noResize) mask.delete();
        // 命中即停，剩下的 scale 不再扫（threshold=0 是只求分数的诊断调用，仍扫全部）
        if (threshold > 0 && score >= threshold) break;
      }
    } finally {
      if (ownSmall) smallH.delete();
    }
    if (!best || best[0] < threshold) return null;
    return best;
  } finally {
    if (ownH) grayH.delete();
    if (ownN) grayN0.delete();
  }
}

export class VisionService {
  templatesDir: string;
  threshold: number;
  searchScale: number;
  scales: number[];
  private cacheBgr = new Map<string, Mat>();
  private cacheGray = new Map<string, Mat>();
  private cacheMask = new Map<string, Mat | null>();
  private posCache = new Map<string, MatchHit>();
  private windowHeight = 0;
  private windowHwnd: Hwnd | null = null;
  private lastCapture = { backend: "none", detail: "尚未捕获" };

  constructor(templatesDir: string, threshold = 0.82, searchScale = 0.75, scales?: number[]) {
    this.templatesDir = resolvePath(templatesDir);
    this.threshold = threshold;
    this.searchScale = searchScale;
    this.scales = scales ? [...scales] : [...DEFAULT_SCALES_FAST];
  }

  close(): void {
    this.clearCache();
  }

  templatePath(name: string): string {
    const p = path.parse(name);
    return path.join(this.templatesDir, p.ext ? path.basename(name) : `${name}.png`);
  }

  getTemplate(name: string): Mat {
    const key = this.templatePath(name);
    if (!this.cacheBgr.has(key)) {
      const api = requireCv();
      const raw = loadTemplate(key);
      let bgr: Mat;
      let gray: Mat;
      let mask: Mat | null = null;
      if (raw.channels() === 1) {
        gray = raw;
        bgr = new api.Mat();
        api.cvtColor(raw, bgr, api.COLOR_GRAY2BGR);
      } else if (raw.channels() === 4) {
        const ch = new api.MatVector();
        api.split(raw, ch);
        mask = ch.get(3).clone();
        bgr = new api.Mat();
        api.cvtColor(raw, bgr, api.COLOR_BGRA2BGR);
        gray = toGray(bgr);
        const hasAlpha = api.minMaxLoc(mask);
        if (!(hasAlpha.minVal < 255 && hasAlpha.maxVal >= 8)) {
          mask.delete();
          mask = null;
        }
        for (let i = 0; i < ch.size(); i++) ch.get(i).delete();
        ch.delete();
        raw.delete();
      } else {
        bgr = raw;
        gray = toGray(bgr);
      }
      this.cacheBgr.set(key, bgr);
      this.cacheGray.set(key, gray);
      this.cacheMask.set(key, mask);
    }
    return this.cacheBgr.get(key)!;
  }

  getTemplateGray(name: string): Mat {
    this.getTemplate(name);
    return this.cacheGray.get(this.templatePath(name))!;
  }

  getTemplateMask(name: string): Mat | null {
    this.getTemplate(name);
    return this.cacheMask.get(this.templatePath(name)) ?? null;
  }

  clearCache(): void {
    for (const m of this.cacheBgr.values()) m.delete();
    for (const m of this.cacheGray.values()) m.delete();
    for (const m of this.cacheMask.values()) m?.delete();
    this.cacheBgr.clear();
    this.cacheGray.clear();
    this.cacheMask.clear();
    this.posCache.clear();
  }

  clearPositionCache(name?: string): void {
    if (!name) this.posCache.clear();
    else this.posCache.delete(name);
  }

  listTemplates(): string[] {
    if (!fs.existsSync(this.templatesDir)) return [];
    return fs.readdirSync(this.templatesDir).filter((n) => n.endsWith(".png")).sort();
  }

  private noteWindow(window: WindowInfo): void {
    this.windowHeight = windowMetrics(window).height;
    this.windowHwnd = window.hwnd;
  }

  captureInfo(): { backend: string; detail: string } {
    return { ...this.lastCapture };
  }

  async grabWindow(window: WindowInfo): Promise<Mat> {
    this.noteWindow(window);
    if (isMinimizedWindow(window.hwnd)) {
      this.lastCapture = { backend: "none", detail: "游戏窗口已最小化" };
      throw new VisionError("游戏窗口已最小化；WGC 遮挡捕获不支持最小化窗口");
    }
    try {
      const captured = await captureWindowWgcBgra(window);
      const frame = bgraToBgr(
        captured.bgra,
        captured.width,
        captured.height,
        captured.sourceWidth,
        captured.sourceHeight,
      );
      this.lastCapture = { backend: "wgc", detail: `${captured.width}x${captured.height} · ${captured.sourceId}` };
      const { x: sx, y: sy } = matScale(frame);
      console.log("[vision] WGC frame", frame.cols, "x", frame.rows, "srcScale", sx.toFixed(3), sy.toFixed(3));
      if (sx < 0.999 || sy < 0.999) {
        console.log("[vision] wasm frame", frame.cols, "x", frame.rows, "srcScale", sx.toFixed(3));
      }
      return frame;
    } catch (wgcError) {
      const wgcReason = visionErrText(wgcError);
      console.warn(`[vision] WGC 捕获失败，回退 GDI: ${wgcReason}`);
      try {
        const frame = captureWindow(window);
        this.lastCapture = { backend: "gdi", detail: `WGC 失败: ${wgcReason}` };
        return frame;
      } catch (gdiError) {
        this.lastCapture = { backend: "none", detail: `WGC: ${wgcReason}; GDI: ${visionErrText(gdiError)}` };
        throw new VisionError(`截屏失败（WGC: ${wgcReason}；GDI: ${visionErrText(gdiError)}）`);
      }
    }
  }

  captureCursorPatch(size?: number): Mat | null {
    const patch = size ?? cursorPatchSize(this.windowHeight, this.windowHwnd);
    return captureCursorPatch(patch);
  }

  matchInFrame(
    window: WindowInfo,
    frameBgr: Mat,
    templateName: string,
    threshold?: number,
    frameGray?: Mat,
    scales?: number[],
    useFallbackScales = true,
    excludeRegions?: [number, number, number, number][],
    cachePosition = true,
  ): MatchHit | null {
    this.noteWindow(window);
    const thr = threshold ?? this.threshold;
    const { x: sx, y: sy } = matScale(frameBgr);
    const srcScale = (sx + sy) / 2;
    const excludes = scaleExcludes(excludeRegions, sx, sy);
    console.log("[craft] match begin", templateName, frameBgr.cols, "x", frameBgr.rows, "srcScale", srcScale.toFixed(3));
    try {
      let hit = matchTemplate(
        frameBgr,
        null,
        thr,
        scaleNeedles(scales ?? this.scales, srcScale),
        frameGray ?? undefined,
        this.getTemplateGray(templateName),
        this.getTemplateMask(templateName),
        this.searchScale,
        excludes,
      );
      if (!hit && useFallbackScales) {
        hit = matchTemplate(
          frameBgr,
          null,
          thr,
          scaleNeedles(DEFAULT_SCALES_FALLBACK, srcScale),
          frameGray ?? undefined,
          this.getTemplateGray(templateName),
          this.getTemplateMask(templateName),
          Math.min(1, this.searchScale + 0.1),
          excludes,
        );
      }
      if (!hit) {
        console.log("[craft] match miss", templateName);
        return null;
      }
      const result = this.makeHit(window, templateName, hit[0], hit[1], hit[2], hit[3], hit[4], sx, sy);
      if (cachePosition) this.posCache.set(templateName, result);
      console.log("[craft] match ok", templateName, "score", result.score.toFixed(3));
      return result;
    } catch (e) {
      console.warn("[vision] 模板匹配失败", templateName, visionErrText(e));
      return null;
    }
  }

  async findInWindow(
    window: WindowInfo,
    templateName: string,
    threshold?: number,
    frameBgr?: Mat,
    frameGray?: Mat,
    excludeRegions?: [number, number, number, number][],
  ): Promise<MatchHit | null> {
    const own = !frameBgr;
    const frame = frameBgr ?? (await this.grabWindow(window));
    try {
      return this.matchInFrame(window, frame, templateName, threshold, frameGray, undefined, true, excludeRegions);
    } finally {
      if (own) frame.delete();
    }
  }

  getCachedPosition(name: string): MatchHit | undefined {
    return this.posCache.get(name);
  }

  setCachedPosition(name: string, hit: MatchHit): void {
    this.posCache.set(name, hit);
  }

  async testMatchReport(keywords: string[], names: string[], threshold?: number) {
    const win = findGameWindow(keywords);
    if (!win) {
      return names.map((name) => ({
        template: name,
        ok: false,
        error: "未找到流放之路窗口",
        capture_backend: "none",
        capture_detail: "未找到窗口",
      }));
    }
    let frame: Mat;
    try {
      frame = await this.grabWindow(win);
    } catch (e) {
      const capture = this.captureInfo();
      return names.map((name) => ({
        template: name,
        ok: false,
        error: `截屏失败: ${visionErrText(e)}`,
        capture_backend: capture.backend,
        capture_detail: capture.detail,
      }));
    }
    const capture = this.captureInfo();
    const gray = toGray(frame);
    const thr = threshold ?? this.threshold;
    const results = names.map((name) => {
      const file = this.templatePath(name);
      if (!fs.existsSync(file)) {
        return {
          template: name,
          ok: false,
          error: `文件不存在: ${path.basename(file)}`,
          capture_backend: capture.backend,
          capture_detail: capture.detail,
        };
      }
      try {
        const hit = this.matchInFrame(win, frame, name, thr, gray, undefined, true);
        if (!hit) {
          const { x: sx, y: sy } = matScale(frame);
          const raw = matchTemplate(
            frame,
            null,
            0,
            scaleNeedles(DEFAULT_SCALES_FALLBACK, (sx + sy) / 2),
            gray,
            this.getTemplateGray(name),
            this.getTemplateMask(name),
            this.searchScale,
          );
          return {
            template: name,
            ok: false,
            score: raw ? round4(raw[0]) : 0,
            error: `低于阈值 ${thr}`,
            capture_backend: capture.backend,
            capture_detail: capture.detail,
          };
        }
        return {
          template: name,
          ok: true,
          score: round4(hit.score),
          client_xy: [hit.clientX, hit.clientY],
          screen_xy: [hit.screenX, hit.screenY],
          capture_backend: capture.backend,
          capture_detail: capture.detail,
        };
      } catch (e) {
        return {
          template: name,
          ok: false,
          error: visionErrText(e),
          capture_backend: capture.backend,
          capture_detail: capture.detail,
        };
      }
    });
    gray.delete();
    frame.delete();
    return results;
  }

  private makeHit(
    window: WindowInfo,
    name: string,
    score: number,
    x: number,
    y: number,
    w: number,
    h: number,
    scaleX = 1,
    scaleY = 1,
  ): MatchHit {
    const cx = toClient(x + w / 2, scaleX);
    const cy = toClient(y + h / 2, scaleY);
    return {
      name,
      score,
      screenX: window.left + cx,
      screenY: window.top + cy,
      clientX: cx,
      clientY: cy,
      width: Math.max(1, toClient(w, scaleX)),
      height: Math.max(1, toClient(h, scaleY)),
    };
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
