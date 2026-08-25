import { clearClipboard, getClipboard, waitClipboardChange } from "./clipboard";
import { currencyLabel } from "./currencies";
import { clickScreen, findGameWindow, focusGameWindow, getCursorPosition, hotkey, moveScreen, type WindowInfo, windowMetrics } from "./input";
import { currencySlotCandidates } from "./stashGrid";
import { sleepMs } from "./timing";
import { detectRarity, MapFilter, modsLineCount } from "./mapFilter";

// 供 host/外部引用
export { detectRarity, MapFilter, modsLineCount } from "./mapFilter";
export type { MapFilterRule } from "./mapFilter";

/**
 * 洗地图引擎 —— 在 PoeCrafting 源码基础上按「洗地图.ahk」语义新增。
 *
 * 与现有 CraftAutomation 的关系：复用 input / clipboard / currency / stashGrid / timing 基础设施，
 * 但处理对象是「背包格里的地图」（5 排 x 12 格，起止格由用户校准），词条判断用「想要词条」过滤文本
 * （非规则组）。货币（点金/重铸/混沌/崇高/瓦尔）仍从仓库「非绑定 / 通用」通货页按格位悬停 Ctrl+C 核名。
 */

export type WashMode = "alch" | "chaos"; // 点金洗 / 混沌洗

export interface MapGrid {
  /** 起始格（第1排第1格）在游戏窗口客户区内的比例坐标 fx/fy，0..1 */
  startX: number;
  startY: number;
  /** 结束格（第5排第12格）的比例坐标 */
  endX: number;
  endY: number;
}

export interface MapWashConfig {
  mode: WashMode;
  startSlot: number;
  endSlot: number;
  exaltFill: boolean;
  doVaal: boolean;
  /** 想要词条过滤文本（语义见 MapFilter） */
  filter: string;
  grid: MapGrid;
  windowTitleKeywords: string[];
}

/** 从「通用设置」带入的运行参数（操作间隔、剪贴板超时、窗口标题等） */
export interface MapWasherTiming {
  actionDelayMs?: number;
  craftWaitMs?: number;
  clipboardTimeoutMs?: number;
  windowTitleKeywords?: string[];
}

export interface MapWashStats {
  success: number;
  empty: number;
  fail: number;
  stop: number;
}

export interface MapWashView {
  running: boolean;
  calibrating: "" | "start" | "end";
  mode: WashMode;
  startSlot: number;
  endSlot: number;
  currentSlot: number;
  totalSlots: number;
  phase: "idle" | "wash" | "exalt" | "vaal" | "done";
  message: string;
  config: MapWashConfig;
  stats: MapWashStats;
  logs: string[];
}

export const MAPWASH_ROWS = 5;
export const MAPWASH_COLS = 12;
export const MAPWASH_MAX_SLOTS = MAPWASH_ROWS * MAPWASH_COLS;

const ALCH_MAX = 200;
const CHAOS_MAX = 200;
const EXALT_FILL_MAX = 3;
const COPY_TIMEOUT_MS = 800;

/** 本功能用到的通货（仓库「非绑定 / 通用」页有格位；瓦尔已有格位，其余沿用 stashGrid） */
const CURRENCY_TEMPLATES = {
  alchemy: "currency_alchemy", // 点金
  scouring: "currency_scouring", // 重铸
  chaos: "currency_chaos", // 混沌
  exalted: "currency_exalted", // 崇高
  vaal: "currency_vaal", // 瓦尔
} as const;

function clampSlot(v: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(MAPWASH_MAX_SLOTS, Math.round(n)));
}

const EMPTY_GRID: MapGrid = { startX: 0, startY: 0, endX: 0, endY: 0 };

/** 词条过滤框默认示例文本 */
export const DEFAULT_MAP_FILTER = [
  "// 必须要有的词缀，例如",
  "物品数量 > 100",
  "!格挡",
  "!再生",
  "",
  "## 满足上面条件下可选词缀",
  "塑界者",
  "",
  "### 可选词缀满足一条即视为成功",
  "贤主",
].join("\n");

export function defaultMapWashConfig(partial?: Partial<MapWashConfig>): MapWashConfig {
  return {
    mode: "alch",
    startSlot: 1,
    endSlot: MAPWASH_MAX_SLOTS,
    exaltFill: false,
    doVaal: false,
    filter: DEFAULT_MAP_FILTER,
    grid: { ...EMPTY_GRID },
    windowTitleKeywords: ["Path of Exile", "流放之路"],
    ...(partial ? JSON.parse(JSON.stringify(partial)) : {}),
  };
}

export class MapWasher {
  private onLog: (m: string) => void;
  private onStatus: (v: MapWashView) => void;
  private stopFlag = false;
  private active = false;
  private paused = false;
  private cfg = defaultMapWashConfig();
  private stats: MapWashStats = { success: 0, empty: 0, fail: 0, stop: 0 };
  private currentSlot = 0;
  private phase: MapWashView["phase"] = "idle";
  private message = "";
  calibrating: "" | "start" | "end" = "";
  private logs: string[] = [];
  private timing: MapWasherTiming = {};

  constructor(onLog?: (m: string) => void, onStatus?: (v: MapWashView) => void) {
    this.onLog = onLog ?? (() => undefined);
    this.onStatus = onStatus ?? (() => undefined);
  }

  isRunning(): boolean {
    return this.active;
  }

  requestStop(): void {
    this.stopFlag = true;
    this.message = "正在停止…";
    this.emit();
    this.onLog("请求停止");
  }

  /** 校准模式开关（外部通过热键触发 captureCalibration） */
  setCalibrating(kind: "" | "start" | "end"): void {
    this.calibrating = kind;
    this.emit();
  }

  private shouldStop(): boolean {
    return this.stopFlag;
  }

  /** 通用设置里的窗口标题关键字（未配置时退回洗地图自身配置） */
  private keywordList(): string[] {
    const kw = this.timing.windowTitleKeywords;
    if (Array.isArray(kw) && kw.length) return kw;
    return this.cfg.windowTitleKeywords;
  }

  /** 操作间隔(ms)：右键/左键/移动等动作间的停顿 */
  private actionMs(): number {
    const n = Number(this.timing.actionDelayMs);
    return Number.isFinite(n) && n > 0 ? Math.max(20, Math.min(2000, Math.round(n))) : 120;
  }

  /** 剪贴板超时(ms)：每次 Ctrl+C 后的等待上限（读物品/核通货名） */
  private copyMs(): number {
    const n = Number(this.timing.clipboardTimeoutMs);
    return Number.isFinite(n) && n > 0 ? Math.max(50, Math.min(10000, Math.round(n))) : COPY_TIMEOUT_MS;
  }

  private log(msg: string): void {
    const ts = new Date().toTimeString().slice(0, 8);
    const line = `[${ts}] ${msg}`;
    this.logs.push(line);
    if (this.logs.length > 120) this.logs = this.logs.slice(-120);
    this.onLog(line);
  }

  private emit(): void {
    this.onStatus(this.view());
  }

  private setConfig(cfg: MapWashConfig): void {
    this.cfg = defaultMapWashConfig(cfg);
  }

  /** 供 host 写入配置（不随运行实例互相污染） */
  applyConfig(cfg: MapWashConfig): void {
    this.setConfig(cfg);
  }

  updateGrid(grid: MapGrid): void {
    this.cfg.grid = { ...grid };
    this.emit();
  }

  get config(): MapWashConfig {
    return defaultMapWashConfig(this.cfg);
  }

  view(): MapWashView {
    const nowRunning = this.active;
    const lo = Math.min(this.cfg.startSlot, this.cfg.endSlot);
    const hi = Math.max(this.cfg.startSlot, this.cfg.endSlot);
    return {
      running: nowRunning,
      calibrating: this.calibrating,
      mode: this.cfg.mode,
      startSlot: this.cfg.startSlot,
      endSlot: this.cfg.endSlot,
      currentSlot: this.currentSlot,
      totalSlots: nowRunning && hi >= lo ? hi - lo + 1 : 0,
      phase: this.phase,
      message: this.message,
      config: this.config,
      stats: { ...this.stats },
      logs: this.logs.slice(),
    };
  }

  // ---------------- 核心流程 ----------------

  start(config: MapWashConfig, timing: MapWasherTiming = {}): void {
    if (this.active) throw new Error("洗地图已在运行");
    this.stopFlag = false;
    this.paused = false;
    this.timing = timing;
    this.setConfig(config);
    this.stats = { success: 0, empty: 0, fail: 0, stop: 0 };
    this.currentSlot = 0;
    this.active = true;
    this.phase = "wash";
    this.message = "启动中…";
    this.log(`开始洗地图（模式=${this.cfg.mode === "alch" ? "点金洗" : "混沌洗"}）`);
    void this.runSafe();
  }

  private async runSafe(): Promise<void> {
    try {
      await this.run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`异常退出: ${msg}`);
      this.phase = "done";
      this.message = `异常：${msg}`;
    } finally {
      this.active = false;
      this.emit();
    }
  }

  private async resolveWindow(): Promise<[WindowInfo | null, boolean]> {
    return focusGameWindow(this.keywordList(), 6);
  }

  private slotClient(win: WindowInfo, index: number): [number, number] {
    const { width, height } = windowMetrics(win);
    const { startX, startY, endX, endY } = this.cfg.grid;
    const r = Math.floor((index - 1) / MAPWASH_COLS);
    const c = (index - 1) % MAPWASH_COLS;
    const fx = startX + ((endX - startX) * c) / (MAPWASH_COLS - 1);
    const fy = startY + ((endY - startY) * r) / (MAPWASH_ROWS - 1);
    return [Math.round(fx * width), Math.round(fy * height)];
  }

  private toScreen(win: WindowInfo, x: number, y: number): [number, number] {
    return [Math.round(win.left + x), Math.round(win.top + y)];
  }

  private async readAt(win: WindowInfo, index: number): Promise<string> {
    const [ix, iy] = this.slotClient(win, index);
    const [sx, sy] = this.toScreen(win, ix, iy);
    await moveScreen(sx, sy, this.actionMs());
    clearClipboard();
    const prev = getClipboard();
    hotkey("ctrl", "c");
    const text = await waitClipboardChange(prev, this.copyMs(), 2, true);
    return text || "";
  }

  private async resolveCurrency(win: WindowInfo, templateName: string): Promise<{ screenX: number; screenY: number } | null> {
    const label = currencyLabel(templateName);
    const candidates = currencySlotCandidates(win, templateName);
    if (!candidates.length) {
      this.log(`没有${label}的仓库格位（请打开仓库「非绑定 / 通用」通货页）`);
      return null;
    }
    for (const hit of candidates) {
      if (this.shouldStop()) return null;
      await moveScreen(hit.screenX, hit.screenY, this.actionMs());
      clearClipboard();
      const prev = getClipboard();
      hotkey("ctrl", "c");
      const text = await waitClipboardChange(prev, this.copyMs(), 2, true);
      if (text && text.includes(label)) return { screenX: hit.screenX, screenY: hit.screenY };
    }
    this.log(`未能核到${label}（请确认该通货页与地图同屏可见）`);
    return null;
  }

  private async useCurrencyOn(win: WindowInfo, templateName: string, index: number): Promise<string | null> {
    const label = currencyLabel(templateName);
    const currency = await this.resolveCurrency(win, templateName);
    if (!currency) return null;
    await moveScreen(currency.screenX, currency.screenY, this.actionMs());
    await clickScreen(currency.screenX, currency.screenY, this.actionMs(), "right");
    await sleepMs(this.actionMs(), () => this.shouldStop());
    const [ix, iy] = this.slotClient(win, index);
    const [sx, sy] = this.toScreen(win, ix, iy);
    await moveScreen(sx, sy, this.actionMs());
    await clickScreen(sx, sy, this.actionMs(), "left");
    await sleepMs(this.actionMs(), () => this.shouldStop());
    const text = await this.readAt(win, index);
    if (!text) this.log(`${label}后未复制到物品文本`);
    return text;
  }

  private async washAlch(win: WindowInfo, index: number): Promise<boolean> {
    for (let attempt = 1; attempt <= ALCH_MAX; attempt++) {
      if (this.shouldStop()) return false;
      this.log(`格${index} 点金 #${attempt}`);
      let text = await this.useCurrencyOn(win, CURRENCY_TEMPLATES.alchemy, index);
      if (text == null) return false;
      const [ok, why] = MapFilter.matches(text, this.cfg.filter);
      this.log(`    点金判断: ${ok ? "成功✓" : "失败✗"} (${why})`);
      if (ok) return true;
      if (this.shouldStop()) return false;
      this.log(`格${index} 重铸 #${attempt}`);
      text = await this.useCurrencyOn(win, CURRENCY_TEMPLATES.scouring, index);
      if (text == null) return false;
    }
    return false;
  }

  private async washChaos(win: WindowInfo, index: number): Promise<boolean> {
    let text: string | null = await this.readAt(win, index);
    if (detectRarity(text) !== "稀有") {
      this.log(`格${index} 非稀有，先用点金升稀有`);
      const t = await this.useCurrencyOn(win, CURRENCY_TEMPLATES.alchemy, index);
      if (t != null) text = t;
    }
    for (let attempt = 1; attempt <= CHAOS_MAX; attempt++) {
      if (this.shouldStop()) return false;
      this.log(`格${index} 混沌 #${attempt}`);
      text = await this.useCurrencyOn(win, CURRENCY_TEMPLATES.chaos, index);
      if (text == null) return false;
      const [ok, why] = MapFilter.matches(text, this.cfg.filter);
      this.log(`    混沌判断: ${ok ? "成功✓" : "失败✗"} (${why})`);
      if (ok) return true;
    }
    return false;
  }

  private async exaltFill(win: WindowInfo, index: number): Promise<void> {
    for (let i = 0; i < EXALT_FILL_MAX; i++) {
      if (this.shouldStop()) return;
      const text = await this.readAt(win, index);
      const n = modsLineCount(text);
      if (n >= 6) {
        this.log(`格${index} 词缀已满(${n}条)，跳过E满`);
        return;
      }
      this.log(`格${index} 词缀${n}条<6，使用崇高`);
      const after = await this.useCurrencyOn(win, CURRENCY_TEMPLATES.exalted, index);
      if (after == null) return;
      if (modsLineCount(after) <= n) return;
    }
  }

  private async vaalStep(win: WindowInfo, index: number): Promise<void> {
    this.log(`格${index} 最后上瓦尔`);
    await this.useCurrencyOn(win, CURRENCY_TEMPLATES.vaal, index);
  }

  private async washSlot(win: WindowInfo, index: number): Promise<"success" | "empty" | "fail"> {
    this.currentSlot = index;
    this.message = `处理格 ${index}`;
    this.emit();
    const text = await this.readAt(win, index);
    if (!text.trim()) {
      this.log(`格${index}: 空，跳过`);
      return "empty";
    }
    const rarity = detectRarity(text);
    this.log(`格${index}: 稀有度=${rarity}`);

    let ok: boolean;
    if (this.cfg.mode === "alch") ok = await this.washAlch(win, index);
    else ok = await this.washChaos(win, index);
    if (!ok) return "fail";

    this.phase = "exalt";
    if (this.cfg.exaltFill) await this.exaltFill(win, index);
    this.phase = "vaal";
    if (this.cfg.doVaal) await this.vaalStep(win, index);
    this.phase = "wash";
    return "success";
  }

  private async run(): Promise<void> {
    const [win, focused] = await this.resolveWindow();
    if (!win) {
      this.log("未找到流放之路窗口");
      this.phase = "done";
      this.message = "未找到流放之路窗口";
      this.stats.stop += 1;
      return;
    }
    this.log(focused ? `已切换到游戏: ${win.title}` : `已定位窗口: ${win.title}（未完全置前，继续运行）`);
    const g = this.cfg.grid;
    if (!g.startX && !g.startY && !g.endX && !g.endY) {
      this.log("[警告] 尚未校准背包起始格 / 结束格，请先校准");
    }
    if (this.cfg.doVaal && !await this.resolveCurrency(win, CURRENCY_TEMPLATES.vaal)) {
      this.log("[提示] 勾选了上瓦尔但未能确认瓦尔位置，瓦尔步骤将自然跳过");
    }

    const lo = Math.min(this.cfg.startSlot, this.cfg.endSlot);
    const hi = Math.max(this.cfg.startSlot, this.cfg.endSlot);
    for (let idx = lo; idx <= hi; idx++) {
      while (this.paused && this.active && !this.stopFlag) {
        await sleepMs(300, () => this.shouldStop());
      }
      if (this.stopFlag) {
        this.log("已停止");
        this.stats.stop += 1;
        break;
      }
      this.phase = "wash";
      const out = await this.washSlot(win, idx);
      this.stats[out] += 1;
      if (this.stopFlag) {
        this.log("已停止");
        this.stats.stop += 1;
        break;
      }
    }
    this.phase = "done";
    this.message = "完成";
    this.log(`完成: 成功=${this.stats.success} 空=${this.stats.empty} 失败=${this.stats.fail} 停止=${this.stats.stop}`);
  }

  /** 供 main/前端热键捕获当前光标，换算成起始格/结束格比例 */
  captureCalibration(kind: "start" | "end"): { ok: boolean; error?: string } {
    const [mx, my] = getCursorPosition();
    const win = findGameWindow(this.keywordList());
    if (!win) {
      return { ok: false, error: "未找到流放之路窗口，无法校准" };
    }
    const m = windowMetrics(win);
    if (m.width <= 0 || m.height <= 0) {
      return { ok: false, error: "游戏窗口尺寸无效，无法校准" };
    }
    const fx = (mx - win.left) / (win.right - win.left);
    const fy = (my - win.top) / (win.bottom - win.top);
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) {
      return { ok: false, error: `光标不在游戏窗口内 (${mx},${my})` };
    }
    const grid = { ...this.cfg.grid };
    if (kind === "start") {
      grid.startX = fx;
      grid.startY = fy;
    } else {
      grid.endX = fx;
      grid.endY = fy;
    }
    this.cfg.grid = grid;
    this.calibrating = "";
    this.log(`${kind === "start" ? "起始格" : "结束格"}已校准: (${fx.toFixed(4)}, ${fy.toFixed(4)})`);
    this.emit();
    return { ok: true };
  }

  /** 一次性读取某背包格的地图文本（用于页面「试读当前格」），不影响循环状态 */
  async readSlotOnce(index: number): Promise<{ ok: boolean; slot: number; text: string; rarity: string; error?: string }> {
    const idx = clampSlot(index);
    const g = this.cfg.grid;
    if (!g.startX && !g.startY && !g.endX && !g.endY) {
      return { ok: false, slot: idx, text: "", rarity: "", error: "尚未校准背包起始格/结束格，请先校准" };
    }
    const [win] = await this.resolveWindow();
    if (!win) return { ok: false, slot: idx, text: "", rarity: "", error: "未找到流放之路窗口" };
    const text = await this.readAt(win, idx);
    return { ok: true, slot: idx, text, rarity: text ? detectRarity(text) : "" };
  }
}