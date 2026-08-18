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
  type Hwnd,
  type WindowInfo,
  windowMetrics,
} from "./win32";

export type { Mat };

export class VisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionError";
  }
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
  colorRmse?: number;
  featureMatches?: number;
}

interface FeatureCandidate {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  matchCount: number;
  meanDistance: number;
}

export const DEFAULT_SCALES_FAST = [1.0] as const;
export const DEFAULT_SCALES_FALLBACK = [1.0, 0.95, 1.05] as const;
export const DEFAULT_SCALES_FULL = [1.0, 0.9, 1.1, 0.8, 1.2] as const;

let cv: CvApi;

export async function initVision(): Promise<void> {
  cv = await loadCv();
}

function requireCv(): CvApi {
  if (!cv) throw new VisionError("OpenCV 尚未初始化");
  return cv;
}

export function bgraToBgr(bgra: Buffer, width: number, height: number): Mat {
  const api = requireCv();
  const src = api.matFromArray(height, width, api.CV_8UC4, new Uint8Array(bgra));
  const bgr = new api.Mat();
  api.cvtColor(src, bgr, api.COLOR_BGRA2BGR);
  src.delete();
  return bgr;
}

export function captureRegion(left: number, top: number, width: number, height: number): Mat {
  return bgraToBgr(captureRegionBgra(left, top, width, height), width, height);
}

export function captureWindow(window: WindowInfo): Mat {
  const { width, height } = windowMetrics(window);
  return captureRegion(window.left, window.top, width, height);
}

export function patchRmse(a: Mat | null, b: Mat | null): number {
  if (!a || !b || a.rows !== b.rows || a.cols !== b.cols || a.channels() !== b.channels()) return 0;
  const api = requireCv();
  const diff = new api.Mat();
  a.convertTo(diff, api.CV_32F);
  const b32 = new api.Mat();
  b.convertTo(b32, api.CV_32F);
  api.subtract(diff, b32, diff);
  const sq = new api.Mat();
  api.multiply(diff, diff, sq);
  const mean = api.mean(sq);
  let acc = 0;
  const n = a.channels();
  for (let i = 0; i < n; i++) acc += mean[i];
  diff.delete();
  b32.delete();
  sq.delete();
  return Math.sqrt(acc / n);
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
    const bytes = fs.readFileSync(file);
    const buf = api.matFromArray(1, bytes.length, api.CV_8UC1, new Uint8Array(bytes));
    const img = api.imdecode(buf, api.IMREAD_UNCHANGED);
    buf.delete();
    if (img && !img.empty()) return img;
  }
  const { nativeImage } = require("electron");
  const ni = nativeImage.createFromPath(file);
  if (ni.isEmpty()) throw new VisionError(`无法读取模板: ${file}`);
  const { width, height } = ni.getSize();
  return api.matFromArray(height, width, api.CV_8UC4, new Uint8Array(ni.toBitmap()));
}

function sanitizeResult(result: Mat, fill: number): void {
  const data = result.data32F as Float32Array;
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
          const data = mask.data as Uint8Array;
          for (let i = 0; i < data.length; i++) if (data[i] < 8) data[i] = 0;
        }
        const result = new api.Mat();
        const method = mask ? api.TM_CCORR_NORMED : api.TM_CCOEFF_NORMED;
        if (mask) api.matchTemplate(smallH, needle, result, method, mask);
        else api.matchTemplate(smallH, needle, result, method);
        sanitizeResult(result, -1);
        applyExclusions(result, excludeRegions, ss, nw, nh, -1);
        const loc = api.minMaxLoc(result);
        const score = loc.maxVal;
        const ox = Math.round(loc.maxLoc.x / ss);
        const oy = Math.round(loc.maxLoc.y / ss);
        const ow = Math.max(1, Math.round(needle.cols / ss));
        const oh = Math.max(1, Math.round(needle.rows / ss));
        if (!best || score > best[0]) best = [score, ox, oy, ow, oh];
        result.delete();
        if (!noResize) needle.delete();
        if (mask && !noResize) mask.delete();
        if (score >= Math.max(threshold, 0.92)) break;
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

export function matchTemplateColorRmse(
  haystackBgr: Mat | null,
  needleBgr: Mat | null,
  needleMask: Mat | null,
  maxRmse = 80,
  scales: readonly number[] | null = null,
  searchScale = 1.0,
  excludeRegions?: [number, number, number, number][],
): [number, number, number, number, number, number] | null {
  const api = requireCv();
  if (!haystackBgr || !needleBgr || haystackBgr.channels() < 3 || needleBgr.channels() < 3) return null;
  const hImg = haystackBgr.rows;
  const wImg = haystackBgr.cols;
  let ss = searchScale > 0 ? Math.min(searchScale, 1) : 1;
  let smallH = haystackBgr;
  let ownSmall = false;
  if (ss < 0.99) {
    smallH = new api.Mat();
    api.resize(
      haystackBgr,
      smallH,
      new api.Size(Math.max(1, Math.floor(wImg * ss)), Math.max(1, Math.floor(hImg * ss))),
      0,
      0,
      api.INTER_AREA,
    );
    ownSmall = true;
  } else ss = 1;
  const sh = smallH.rows;
  const sw = smallH.cols;
  let best: [number, number, number, number, number, number] | null = null;
  try {
    for (const scale of scales ?? DEFAULT_SCALES_FAST) {
      const nh = Math.max(1, Math.floor(needleBgr.rows * scale * ss));
      const nw = Math.max(1, Math.floor(needleBgr.cols * scale * ss));
      if (nh >= sh || nw >= sw) continue;
      const interp = scale * ss < 1 ? api.INTER_AREA : api.INTER_LINEAR;
      const needle = new api.Mat();
      api.resize(needleBgr, needle, new api.Size(nw, nh), 0, 0, interp);
      let mask: Mat;
      let ownMask = true;
      if (!needleMask) {
        mask = api.Mat.ones(nh, nw, api.CV_8UC1);
        mask.setTo(new api.Scalar(255));
      } else {
        const alpha = new api.Mat();
        api.resize(needleMask, alpha, new api.Size(nw, nh), 0, 0, api.INTER_LINEAR);
        mask = new api.Mat();
        api.threshold(alpha, mask, 191, 255, api.THRESH_BINARY);
        if (cvCount(mask) < 16) api.threshold(alpha, mask, 7, 255, api.THRESH_BINARY);
        alpha.delete();
      }
      const pixelCount = cvCount(mask);
      if (pixelCount <= 0) {
        needle.delete();
        if (ownMask) mask.delete();
        continue;
      }
      const result = new api.Mat();
      api.matchTemplate(smallH, needle, result, api.TM_SQDIFF, mask);
      sanitizeResult(result, 1e30);
      applyExclusions(result, excludeRegions, ss, nw, nh, 1e30);
      const loc = api.minMaxLoc(result);
      const rmse = Math.sqrt(Math.max(0, loc.minVal) / (pixelCount * 3));
      const ox = Math.round(loc.minLoc.x / ss);
      const oy = Math.round(loc.minLoc.y / ss);
      const ow = Math.max(1, Math.round(nw / ss));
      const oh = Math.max(1, Math.round(nh / ss));
      const score = Math.max(0, Math.min(1, 1 - rmse / 255));
      if (!best || rmse < best[5]) best = [score, ox, oy, ow, oh, rmse];
      result.delete();
      needle.delete();
      if (ownMask) mask.delete();
    }
  } finally {
    if (ownSmall) smallH.delete();
  }
  if (!best || best[5] > maxRmse) return null;
  return best;
}

function cvCount(mask: Mat): number {
  return requireCv().countNonZero(mask);
}

function extractSift(image: Mat, mask?: Mat | null): [unknown[], Mat | null] {
  const api = requireCv();
  try {
    if (typeof api.SIFT_create !== "function") return [[], null];
    const sift = api.SIFT_create(0, 3, 0.02, 10);
    const gray = image.channels() === 1 ? image : toGray(image);
    const keypoints = new api.KeyPointVector();
    const descriptors = new api.Mat();
    sift.detectAndCompute(gray, mask ?? new api.Mat(), keypoints, descriptors);
    if (gray !== image) gray.delete();
    const list = [];
    for (let i = 0; i < keypoints.size(); i++) list.push(keypoints.get(i));
    keypoints.delete();
    if (!descriptors || descriptors.empty()) {
      descriptors?.delete();
      return [[], null];
    }
    return [list, descriptors];
  } catch {
    return [[], null];
  }
}

export function matchTemplateFeatureCandidates(
  haystackBgr: Mat,
  needleBgr: Mat,
  needleMask: Mat | null,
  targetWidth: number,
  excludeRegions?: [number, number, number, number][],
  maxCandidates = 6,
  haystackFeatures?: [unknown[], Mat | null],
): FeatureCandidate[] {
  const api = requireCv();
  if (!haystackBgr || !needleBgr || targetWidth <= 0) return [];
  const sourceH = needleBgr.rows;
  const sourceW = needleBgr.cols;
  if (sourceH <= 0 || sourceW <= 0) return [];
  const width = Math.max(12, Math.round(targetWidth));
  const height = Math.max(12, Math.round((sourceH * width) / sourceW));
  const needle = new api.Mat();
  api.resize(needleBgr, needle, new api.Size(width, height), 0, 0, api.INTER_CUBIC);
  let mask: Mat | null = null;
  if (needleMask) {
    const alpha = new api.Mat();
    api.resize(needleMask, alpha, new api.Size(width, height), 0, 0, api.INTER_LINEAR);
    mask = new api.Mat();
    api.threshold(alpha, mask, 31, 255, api.THRESH_BINARY);
    alpha.delete();
  }
  const [needleKp, needleDesc] = extractSift(needle, mask);
  needle.delete();
  mask?.delete();
  if (!needleDesc || needleKp.length < 4) {
    needleDesc?.delete();
    return [];
  }
  let frameKp: unknown[];
  let frameDesc: Mat | null;
  if (!haystackFeatures) [frameKp, frameDesc] = extractSift(haystackBgr);
  else [frameKp, frameDesc] = haystackFeatures;
  if (!frameDesc || frameKp.length < 4) {
    needleDesc.delete();
    if (!haystackFeatures) frameDesc?.delete();
    return [];
  }
  try {
    const matcher = new api.BFMatcher(api.NORM_L2, false);
    const knn = new api.DMatchVectorVector();
    matcher.knnMatch(needleDesc, frameDesc, knn, 2);
    const predictions: [number, number, number][] = [];
    for (let i = 0; i < knn.size(); i++) {
      const pair = knn.get(i);
      if (pair.size() < 2) continue;
      const first = pair.get(0);
      const second = pair.get(1);
      if (first.distance >= 0.78 * second.distance) continue;
      const src = needleKp[first.queryIdx] as { pt: { x: number; y: number } };
      const dst = frameKp[first.trainIdx] as { pt: { x: number; y: number } };
      const centerX = dst.pt.x - src.pt.x + width / 2;
      const centerY = dst.pt.y - src.pt.y + height / 2;
      if (centerX < 0 || centerY < 0 || centerX >= haystackBgr.cols || centerY >= haystackBgr.rows) continue;
      if (
        excludeRegions?.some(
          ([left, top, right, bottom]) => left <= centerX && centerX < right && top <= centerY && centerY < bottom,
        )
      ) {
        continue;
      }
      predictions.push([centerX, centerY, first.distance]);
    }
    knn.delete();
    if (predictions.length < 4) return [];
    const radius = Math.max(10, width * 0.27);
    const radiusSq = radius * radius;
    const clusters: FeatureCandidate[] = [];
    for (const [seedX, seedY] of predictions) {
      const members = predictions.filter(([x, y]) => (x - seedX) ** 2 + (y - seedY) ** 2 <= radiusSq);
      if (members.length < 4) continue;
      const xs = members.map((m) => m[0]).sort((a, b) => a - b);
      const ys = members.map((m) => m[1]).sort((a, b) => a - b);
      const mid = Math.floor(xs.length / 2);
      clusters.push({
        centerX: Math.round(xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2),
        centerY: Math.round(ys.length % 2 ? ys[mid] : (ys[mid - 1] + ys[mid]) / 2),
        width,
        height,
        matchCount: members.length,
        meanDistance: members.reduce((s, m) => s + m[2], 0) / members.length,
      });
    }
    const ordered = clusters.sort((a, b) => b.matchCount - a.matchCount || a.meanDistance - b.meanDistance);
    const selected: FeatureCandidate[] = [];
    const dedupe = (radius * 1.5) ** 2;
    for (const c of ordered) {
      if (selected.some((p) => (c.centerX - p.centerX) ** 2 + (c.centerY - p.centerY) ** 2 <= dedupe)) continue;
      selected.push(c);
      if (selected.length >= maxCandidates) break;
    }
    return selected;
  } catch {
    return [];
  } finally {
    needleDesc.delete();
    if (!haystackFeatures) frameDesc.delete();
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
  private featureFrame: Mat | null = null;
  private featureData: [unknown[], Mat | null] | null = null;
  private windowHeight = 0;
  private windowHwnd: Hwnd | null = null;

  constructor(templatesDir: string, threshold = 0.82, searchScale = 0.75, scales?: number[]) {
    this.templatesDir = resolvePath(templatesDir);
    this.threshold = threshold;
    this.searchScale = searchScale;
    this.scales = scales ? [...scales] : [...DEFAULT_SCALES_FAST];
  }

  close(): void {
    this.clearCache();
    this.featureData?.[1]?.delete();
    this.featureFrame = null;
    this.featureData = null;
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

  grabWindow(window: WindowInfo): Mat {
    this.noteWindow(window);
    return captureWindow(window);
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
  ): MatchHit | null {
    this.noteWindow(window);
    const thr = threshold ?? this.threshold;
    let hit = matchTemplate(
      frameBgr,
      null,
      thr,
      scales ?? this.scales,
      frameGray ?? undefined,
      this.getTemplateGray(templateName),
      this.getTemplateMask(templateName),
      this.searchScale,
      excludeRegions,
    );
    if (!hit && useFallbackScales && !scales) {
      hit = matchTemplate(
        frameBgr,
        null,
        thr,
        DEFAULT_SCALES_FALLBACK,
        frameGray ?? undefined,
        this.getTemplateGray(templateName),
        this.getTemplateMask(templateName),
        Math.min(1, this.searchScale + 0.1),
        excludeRegions,
      );
    }
    if (!hit) return null;
    const result = this.makeHit(window, templateName, hit[0], hit[1], hit[2], hit[3], hit[4]);
    this.posCache.set(templateName, result);
    return result;
  }

  matchColorInFrame(
    window: WindowInfo,
    frameBgr: Mat,
    templateName: string,
    maxRmse = 80,
    scales?: number[],
    excludeRegions?: [number, number, number, number][],
    cachePosition = false,
  ): MatchHit | null {
    this.noteWindow(window);
    const raw = matchTemplateColorRmse(
      frameBgr,
      this.getTemplate(templateName),
      this.getTemplateMask(templateName),
      maxRmse,
      scales ?? this.scales,
      this.searchScale,
      excludeRegions,
    );
    if (!raw) return null;
    const hit = this.makeHit(window, templateName, raw[0], raw[1], raw[2], raw[3], raw[4], raw[5]);
    if (cachePosition) this.posCache.set(templateName, hit);
    return hit;
  }

  featureCandidatesInFrame(
    window: WindowInfo,
    frameBgr: Mat,
    templateName: string,
    targetWidth: number,
    excludeRegions?: [number, number, number, number][],
    maxCandidates = 6,
  ): MatchHit[] {
    if (this.featureFrame !== frameBgr) {
      this.featureData?.[1]?.delete();
      this.featureFrame = frameBgr;
      this.featureData = extractSift(frameBgr);
    }
    const candidates = matchTemplateFeatureCandidates(
      frameBgr,
      this.getTemplate(templateName),
      this.getTemplateMask(templateName),
      targetWidth,
      excludeRegions,
      maxCandidates,
      this.featureData ?? undefined,
    );
    return candidates.map((c) => ({
      name: templateName,
      score: Math.min(1, c.matchCount / 12),
      screenX: window.left + c.centerX,
      screenY: window.top + c.centerY,
      clientX: c.centerX,
      clientY: c.centerY,
      width: c.width,
      height: c.height,
      featureMatches: c.matchCount,
    }));
  }

  findInWindow(
    window: WindowInfo,
    templateName: string,
    threshold?: number,
    frameBgr?: Mat,
    frameGray?: Mat,
    excludeRegions?: [number, number, number, number][],
  ): MatchHit | null {
    const own = !frameBgr;
    const frame = frameBgr ?? this.grabWindow(window);
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

  testMatchReport(keywords: string[], names: string[], threshold?: number) {
    const win = findGameWindow(keywords);
    if (!win) return names.map((name) => ({ template: name, ok: false, error: "未找到流放之路窗口" }));
    let frame: Mat;
    try {
      frame = this.grabWindow(win);
    } catch (e) {
      return names.map((name) => ({ template: name, ok: false, error: `截屏失败: ${e}` }));
    }
    const gray = toGray(frame);
    const thr = threshold ?? this.threshold;
    const results = names.map((name) => {
      const file = this.templatePath(name);
      if (!fs.existsSync(file)) return { template: name, ok: false, error: `文件不存在: ${path.basename(file)}` };
      try {
        const hit = this.matchInFrame(win, frame, name, thr, gray, undefined, true);
        if (!hit) {
          const raw = matchTemplate(
            frame,
            null,
            0,
            DEFAULT_SCALES_FALLBACK,
            gray,
            this.getTemplateGray(name),
            this.getTemplateMask(name),
            this.searchScale,
          );
          return { template: name, ok: false, score: raw ? round4(raw[0]) : 0, error: `低于阈值 ${thr}` };
        }
        return {
          template: name,
          ok: true,
          score: round4(hit.score),
          client_xy: [hit.clientX, hit.clientY],
          screen_xy: [hit.screenX, hit.screenY],
        };
      } catch (e) {
        return { template: name, ok: false, error: String(e) };
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
    rmse?: number,
  ): MatchHit {
    const cx = x + Math.floor(w / 2);
    const cy = y + Math.floor(h / 2);
    const hit: MatchHit = {
      name,
      score,
      screenX: window.left + cx,
      screenY: window.top + cy,
      clientX: cx,
      clientY: cy,
      width: w,
      height: h,
      colorRmse: rmse,
    };
    return hit;
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
