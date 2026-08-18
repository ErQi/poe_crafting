import fs from "fs";
import { clearClipboard, getClipboard, normalizeClipboardText, waitClipboardChange } from "./clipboard";
import { currencyLabel, currencyStackCount } from "./currencies";
import {
  clickScreen,
  findGameWindow,
  focusGameWindow,
  focusWindow,
  getCursorHandle,
  getCursorPosition,
  hotkey,
  moveScreen,
  peekWindow,
  type WindowInfo,
  windowMetrics,
} from "./input";
import { isEquipmentClipboardText, ItemParseError, parseItemText } from "./itemParser";
import { matchRuleset } from "./matcher";
import {
  AppSettings,
  CraftMode,
  CraftStep,
  CraftWorkflow,
  Item,
  RuleSet,
  RunStatus,
  StopReason,
  type StopReasonValue,
} from "./models";
import { sleepMs, waitUntil } from "./timing";
import { currencySlotCandidates } from "./stashGrid";
import { initVision, patchRmse, VisionError, visionErrText, VisionService, type MatchHit, type Mat } from "./vision";
import {
  evaluateStep,
  firstEnabledStep,
  resolveTransition,
  ROUTE_FINISH,
  ROUTE_STOP,
  validateWorkflow,
} from "./workflow";

export class CurrencyUnavailableError extends Error {}

export interface AutomationConfig {
  settings: AppSettings;
  ruleset: RuleSet;
  craftMode: string;
  craftPreset: string;
  workflow?: CraftWorkflow | null;
}

const LOCATE_CURRENCY_TRIES = 4;
const COPY_TIMEOUT_MS = 280;
const COPY_SLICE_MS = 40;
const COPY_POLL_MS = 2;
const CURSOR_MS = 4;
const APPLY_CONFIRM_TRIES = 3;
const PUT_BACK_TRIES = 3;
const HOLD_CHECK_MS = 80;
const WINDOW_MOVE_PX = 12;
const CURSOR_ON_CURRENCY_RMSE = 18;
const CURSOR_CONFIRM_TIMEOUT_MS = 280;

function workflowAssetLabel(name: string): string {
  if (name === "item_slot") return "目标装备";
  const label = currencyLabel(name);
  return label !== name ? `${label}图标` : name;
}

function hitClientRegion(hit: MatchHit): [number, number, number, number] {
  const hw = Math.floor(hit.width / 2);
  const hh = Math.floor(hit.height / 2);
  return [hit.clientX - hw, hit.clientY - hh, hit.clientX - hw + hit.width, hit.clientY - hh + hit.height];
}

function hitCenterInRegion(hit: MatchHit, region: [number, number, number, number]): boolean {
  const [left, top, right, bottom] = region;
  return left <= hit.clientX && hit.clientX < right && top <= hit.clientY && hit.clientY < bottom;
}

function hitInWindow(hit: MatchHit, win: WindowInfo): boolean {
  return (
    Number.isFinite(hit.screenX) &&
    Number.isFinite(hit.screenY) &&
    hit.screenX >= win.left &&
    hit.screenX < win.right &&
    hit.screenY >= win.top &&
    hit.screenY < win.bottom
  );
}

function pointInHit(x: number, y: number, hit: MatchHit): boolean {
  const hw = Math.floor(hit.width / 2);
  const hh = Math.floor(hit.height / 2);
  return (
    hit.screenX - hw <= x &&
    x < hit.screenX - hw + Math.max(1, hit.width) &&
    hit.screenY - hh <= y &&
    y < hit.screenY - hh + Math.max(1, hit.height)
  );
}

function cursorInHit(hit: MatchHit): boolean {
  const [x, y] = getCursorPosition();
  return pointInHit(x, y, hit);
}

function cursorUnlike(a: Mat | null, b: Mat | null, limit = CURSOR_ON_CURRENCY_RMSE): boolean {
  return a != null && b != null && patchRmse(a, b) >= limit;
}

function hitsClose(a?: MatchHit | null, b?: MatchHit | null, px = 8): boolean {
  if (!a || !b) return false;
  return Math.abs(a.screenX - b.screenX) <= px && Math.abs(a.screenY - b.screenY) <= px;
}

function hitHalfCell(hit: MatchHit): number {
  return Math.max(1, Math.max(hit.width, hit.height) / 2);
}

function currencyHitConflict(hit: MatchHit, other: MatchHit): boolean {
  if (pointInHit(hit.screenX, hit.screenY, other) || pointInHit(other.screenX, other.screenY, hit)) return true;
  const half = Math.max(hitHalfCell(hit), hitHalfCell(other));
  const dx = hit.screenX - other.screenX;
  const dy = hit.screenY - other.screenY;
  return dx * dx + dy * dy < half * half;
}

function isCurrencyClipboardText(text: string): boolean {
  const raw = (text || "").trim();
  if (!raw || raw.includes("未找到物品") || raw.startsWith("http")) return false;
  if (currencyStackCount(raw) != null) return true;
  return raw.includes("通货") || raw.includes("Currency");
}

function shouldSkipAugmentation(step: CraftStep, item: Item): boolean {
  return step.currencyTemplate === "currency_augmentation" && item.craftAffixCount !== 1;
}

export class CraftAutomation {
  private onLog: (m: string) => void;
  private onStatus: (s: RunStatus) => void;
  private stopFlag = false;
  private active = false;
  private status = new RunStatus();
  private verifiedCurrency = new Set<string>();
  private stackCounts = new Map<string, number>();
  private lastHoverHit: MatchHit | null = null;
  private currencyUseArmed = false;
  private itemUseClicked = false;
  private itemPointerPatch: Mat | null = null;
  private itemPointerHandle: bigint | null = null;

  constructor(onLog?: (m: string) => void, onStatus?: (s: RunStatus) => void) {
    this.onLog = onLog ?? (() => undefined);
    this.onStatus = onStatus ?? (() => undefined);
  }

  get currentStatus(): RunStatus {
    return this.status;
  }

  isRunning(): boolean {
    return this.active;
  }

  requestStop(reason: StopReasonValue = StopReason.USER_STOP): void {
    this.stopFlag = true;
    this.update({ stopReason: reason, message: "正在停止…" });
  }

  private log(msg: string): void {
    const ts = new Date().toTimeString().slice(0, 8);
    this.onLog(`[${ts}] ${msg}`);
  }

  private update(patch: Partial<RunStatus>, notify = true): void {
    Object.assign(this.status, patch);
    if (notify) this.onStatus(this.status.clone());
  }

  private shouldStop(): boolean {
    return this.stopFlag;
  }

  start(config: AutomationConfig): void {
    if (this.active) throw new Error("自动化已在运行");
    this.stopFlag = false;
    this.status = new RunStatus();
    this.status.running = true;
    this.active = true;
    this.update({ running: true, message: "启动中" });
    void this.runSafe(config);
  }

  private async runSafe(config: AutomationConfig): Promise<void> {
    try {
      await this.run(config);
    } catch (e) {
      this.log(`异常退出: ${e}`);
      this.update({ running: false, stopReason: StopReason.ERROR, message: String(e) });
    } finally {
      this.active = false;
    }
  }

  private async run(config: AutomationConfig): Promise<void> {
    console.log("[craft] run began", config.craftMode);
    await initVision();
    const s = config.settings;
    const scales = config.craftMode === CraftMode.WORKFLOW ? [1, 0.9, 1.1, 0.8, 1.2] : [1];
    const vision = new VisionService(s.templatesDir, s.templateThreshold, 0.7, scales);
    try {
      if (config.craftMode === CraftMode.WORKFLOW) await this.runWorkflow(config, vision);
      else await this.runHarvest(config, vision);
    } finally {
      vision.close();
    }
  }

  private finish(reason: StopReasonValue, message: string, attempt: number, parseFailures: number, unchanged: number): void {
    this.log(`结束: ${reason} — ${message}`);
    this.active = false;
    this.update({
      running: false,
      stopReason: reason,
      message,
      attempt,
      parseFailures,
      unchangedStreak: unchanged,
    });
  }

  private resetPointerBaselines(): void {
    this.itemPointerPatch?.delete();
    this.itemPointerPatch = null;
    this.itemPointerHandle = null;
  }

  private disarmCurrency(): void {
    this.currencyUseArmed = false;
    this.itemUseClicked = false;
  }

  private syncGameWindow(win: WindowInfo): [WindowInfo | null, boolean, string] {
    const next = peekWindow(win.hwnd, win.title);
    if (!next) return [null, false, "游戏窗口丢失"];
    const a = windowMetrics(win);
    const b = windowMetrics(next);
    const moved =
      Math.abs(next.left - win.left) > WINDOW_MOVE_PX ||
      Math.abs(next.top - win.top) > WINDOW_MOVE_PX ||
      Math.abs(a.width - b.width) > WINDOW_MOVE_PX ||
      Math.abs(a.height - b.height) > WINDOW_MOVE_PX;
    return moved ? [next, true, ""] : [win, false, ""];
  }

  private async relocateWorkflow(
    vision: VisionService,
    win: WindowInfo,
    s: AppSettings,
    currencyNames: string[],
  ): Promise<string> {
    vision.clearPositionCache();
    this.verifiedCurrency.clear();
    this.stackCounts.clear();
    this.lastHoverHit = null;
    this.disarmCurrency();
    this.resetPointerBaselines();
    if (!(await this.locateWorkflowRequired(vision, win, s, ["item_slot"]))) return "窗口移动后目标装备重定位失败";
    const itemHit = vision.getCachedPosition("item_slot");
    if (itemHit) {
      await this.moveToHit(itemHit);
      this.captureItemPointerBaseline(vision);
    }
    if (currencyNames.length && !(await this.locateAndVerifyCurrencies(vision, win, s, currencyNames))) {
      return "窗口移动后无法确认所需通货名称与数量";
    }
    return "";
  }

  private async runWorkflow(config: AutomationConfig, vision: VisionService): Promise<void> {
    const s = config.settings;
    this.verifiedCurrency.clear();
    this.stackCounts.clear();
    this.lastHoverHit = null;
    this.disarmCurrency();
    this.resetPointerBaselines();
    if (!config.workflow) {
      this.finish(StopReason.ERROR, "未提供多步骤流程配置", 0, 0, 0);
      return;
    }
    const workflow = CraftWorkflow.fromDict(config.workflow.toDict());
    this.update({ workflowName: workflow.name });
    const errors = validateWorkflow(workflow);
    if (errors.length) {
      this.finish(StopReason.ERROR, `流程配置无效：${errors.join("；")}`, 0, 0, 0);
      return;
    }
    const currencyNames = workflow.enabledSteps().map((st) => st.currencyTemplate).filter((n, i, a) => a.indexOf(n) === i);
    if (!fs.existsSync(vision.templatePath("item_slot"))) {
      const msg = `多步骤流程缺少内置资源: ${workflowAssetLabel("item_slot")}`;
      this.log(msg);
      this.finish(StopReason.TEMPLATE_NOT_FOUND, msg, 0, 0, 0);
      return;
    }
    const [found, focused] = focusGameWindow(s.windowTitleKeywords, 4);
    if (!found) {
      this.finish(StopReason.WINDOW_NOT_FOUND, "未找到流放之路窗口", 0, 0, 0);
      return;
    }
    let win = found;
    this.log(focused ? `已切换到游戏: ${win.title} (${windowMetrics(win).width}x${windowMetrics(win).height})` : `已定位窗口: ${win.title}（未完全置前，继续运行）`);
    this.log(`开始多步骤流程「${workflow.name}」 | 启用步骤=${workflow.enabledSteps().length} | 最大动作数=${s.maxAttempts}`);
    this.log("首次定位目标装备…");
    if (!(await this.locateWorkflowRequired(vision, win, s, ["item_slot"]))) return;
    console.log("[craft] after first: locate done");

    let current = firstEnabledStep(workflow);
    if (!current) {
      this.finish(StopReason.ERROR, "流程没有可执行步骤", 0, 0, 0);
      return;
    }

    let parseFailures = 0;
    this.log("启动检查：正在悬停目标装备并按 Ctrl+C（不点击）…");
    console.log("[craft] after first: read begin");
    let initialItem: Item | null = null;
    for (let readTry = 1; readTry <= s.maxParseFailures; readTry++) {
      try {
        initialItem = await this.readItemFast(vision, win, s);
        parseFailures = 0;
        break;
      } catch (e) {
        parseFailures = readTry;
        this.update({ parseFailures });
        this.log(`启动读取失败 (${readTry}/${s.maxParseFailures})：${e}`);
        if (e instanceof VisionError) vision.clearPositionCache("item_slot");
        if (this.shouldStop()) break;
        await sleepMs(Math.max(40, s.actionDelayMs), () => this.shouldStop());
      }
    }
    if (!initialItem) {
      this.finish(
        this.shouldStop() ? StopReason.USER_STOP : StopReason.PARSE_FAILURES,
        this.shouldStop() ? "用户停止" : "启动时未能读取目标装备，未执行任何鼠标点击",
        0,
        parseFailures,
        0,
      );
      return;
    }
    this.update({ lastItem: initialItem, parseFailures: 0 });
    this.log(this.captureItemPointerBaseline(vision) ? "已采集装备格普通指针基线" : "未能采集装备格指针基线，未确认通货前不会左键");
    this.log(`启动读取成功：稀有度=${initialItem.rarity || "-"} | 显式词缀=${initialItem.craftAffixCount}`);

    const matching = workflow.enabledSteps().filter((st) => st.expectedRarity && st.expectedRarity.trim() === initialItem!.rarity.trim());
    if (matching.length) {
      const inspected = matching[0];
      const evaluation = evaluateStep(initialItem, inspected);
      this.update({ lastMatch: evaluation.match });
      this.log(`已有装备状态按步骤「${inspected.name}」判定：${evaluation.success ? "命中" : "未命中"} | ${evaluation.summary}`);
      let route;
      try {
        route = resolveTransition(workflow, inspected.id, evaluation.success ? inspected.onSuccess : inspected.onFailure);
      } catch (e) {
        this.finish(StopReason.ERROR, String(e), 0, 0, 0);
        return;
      }
      if (route.kind === ROUTE_FINISH) {
        this.finish(StopReason.SUCCESS, "当前装备已满足流程目标", 0, 0, 0);
        return;
      }
      if (route.kind === ROUTE_STOP) {
        this.finish(StopReason.WORKFLOW_STOP, `当前装备按步骤「${inspected.name}」的配置停止`, 0, 0, 0);
        return;
      }
      const resumed = workflow.getStep(route.nextStepId);
      if (!resumed) {
        this.finish(StopReason.ERROR, `找不到下一步骤: ${route.nextStepId}`, 0, 0, 0);
        return;
      }
      current = resumed;
      this.log(`启动后将从步骤「${current.name}」继续`);
    }

    this.log("正在按仓库通货格坐标定位，并逐个悬停 Ctrl+C 核对中文名称…");
    console.log("[craft] after first: currency locate");
    if (!(await this.locateAndVerifyCurrencies(vision, win, s, currencyNames))) {
      this.finish(StopReason.CURRENCY_UNAVAILABLE, "未找到数量可确认的流程通货，未执行任何通货点击", 0, 0, 0);
      return;
    }
    const itemHit = vision.getCachedPosition("item_slot");
    if (itemHit) {
      await this.moveToHit(itemHit);
      if (this.captureItemPointerBaseline(vision)) this.log("已更新装备格普通指针基线");
    }
    await this.runWorkflowLoop(vision, win, s, workflow, current, initialItem, currencyNames);
  }

  private async runWorkflowLoop(
    vision: VisionService,
    win: WindowInfo,
    s: AppSettings,
    workflow: CraftWorkflow,
    current: CraftStep,
    currentItem: Item,
    currencyNames: string[],
  ): Promise<void> {
    let reason: StopReasonValue = StopReason.MAX_ATTEMPTS;
    let message = `已达最大动作数 ${s.maxAttempts}`;
    let lastRaw = `${currentItem.rarity}|${currentItem.affixTexts().join("|")}`;
    let lastActionStepId = "";
    let unchanged = 0;
    let parseFailures = 0;
    let item = currentItem;
    let step = current;
    let game = win;
    for (let attempt = 1; attempt <= s.maxAttempts; attempt++) {
      if (this.shouldStop()) {
        reason = StopReason.USER_STOP;
        message = "用户停止";
        break;
      }
      const live = workflow.getStep(step.id);
      if (!live?.enabled) {
        reason = StopReason.ERROR;
        message = `当前步骤不存在或已禁用: ${step.id}`;
        break;
      }
      step = live;
      const stepIndex = workflow.steps.indexOf(step) + 1;
      console.log("[craft] after first: step", stepIndex, step.name);
      this.update({ attempt, workflowStepName: step.name, workflowStepIndex: stepIndex, message: `步骤 ${stepIndex}: ${step.name}` }, false);
      const t0 = Date.now();
      const actionPerformed = !shouldSkipAugmentation(step, item);
      let nextItem: Item | null = null;
      if (!actionPerformed) {
        nextItem = item;
        this.log(`显式词缀=${item.craftAffixCount}，跳过增幅`);
      } else {
        const applied = await this.applyUntilNewItem(vision, game, step, s, item, currencyNames);
        nextItem = applied.item;
        game = applied.win;
        if (applied.reason) {
          reason = applied.reason;
          message = applied.message;
          if (applied.message && applied.reason !== StopReason.USER_STOP) this.log(applied.message);
          break;
        }
        if (!nextItem) {
          if (this.shouldStop()) {
            reason = StopReason.USER_STOP;
            message = "用户停止";
            break;
          }
          this.log("通货未确认，本轮不判定，继续");
          await this.waitAfterFailedUse();
          continue;
        }
        parseFailures = 0;
      }
      item = nextItem;
      const evaluation = evaluateStep(item, step);
      this.update({ lastItem: item, lastMatch: evaluation.match, parseFailures: 0 });
      this.log(`#${attempt} ${Date.now() - t0}ms | ${evaluation.success ? "命中" : "未命中"} | ${evaluation.summary}`);
      if (actionPerformed) {
        const rawKey = `${item.rarity}|${item.affixTexts().join("|")}`;
        if (rawKey && rawKey === lastRaw && step.id === lastActionStepId) {
          unchanged += 1;
          this.update({ unchangedStreak: unchanged });
          if (unchanged >= s.maxUnchanged) {
            reason = StopReason.UNCHANGED;
            message = `步骤「${step.name}」连续 ${unchanged} 次未改变装备（可能通货耗尽、位置失效或物品状态不允许）`;
            break;
          }
        } else {
          unchanged = 0;
          this.update({ unchangedStreak: 0 });
        }
        lastRaw = rawKey;
        lastActionStepId = step.id;
      } else {
        unchanged = 0;
        this.update({ unchangedStreak: 0 });
      }
      let route;
      try {
        route = resolveTransition(workflow, step.id, evaluation.success ? step.onSuccess : step.onFailure);
      } catch (e) {
        reason = StopReason.ERROR;
        message = String(e);
        break;
      }
      if (route.kind === ROUTE_FINISH) {
        reason = StopReason.SUCCESS;
        message = `流程完成：步骤「${step.name}」命中`;
        for (const affix of item.affixes) this.log(`  • ${affix.text}`);
        break;
      }
      if (route.kind === ROUTE_STOP) {
        reason = StopReason.WORKFLOW_STOP;
        message = `步骤「${step.name}」按配置停止`;
        break;
      }
      const nextStep = workflow.getStep(route.nextStepId);
      if (!nextStep) {
        reason = StopReason.ERROR;
        message = `找不到下一步骤: ${route.nextStepId}`;
        break;
      }
      if (nextStep.id !== step.id) this.log(`转到步骤 ${workflow.steps.indexOf(nextStep) + 1}: ${nextStep.name}`);
      step = nextStep;
      if (await sleepMs(s.actionDelayMs, () => this.shouldStop())) {
        reason = StopReason.USER_STOP;
        message = "用户停止";
        break;
      }
    }
    this.finish(reason, message, this.status.attempt, parseFailures, unchanged);
  }

  private async runHarvest(config: AutomationConfig, vision: VisionService): Promise<void> {
    const s = config.settings;
    const logic = config.ruleset.groupCombine === "any" ? "OR" : "AND";
    this.log(`开始自动化 | 模式=${config.craftMode} | 组间=${logic} | 组数=${config.ruleset.groups.length} | 最大次数=${s.maxAttempts}`);
    const names = ["craft_button", "item_slot"];
    const missing = names.filter((n) => !fs.existsSync(vision.templatePath(n))).map((n) => `${n}.png`);
    if (missing.length) {
      const msg = `缺少模板文件: ${missing.join(", ")}`;
      this.log(msg);
      this.update({ running: false, stopReason: StopReason.TEMPLATE_NOT_FOUND, message: msg });
      this.active = false;
      return;
    }
    const [found, focused] = focusGameWindow(s.windowTitleKeywords, 4);
    if (!found) {
      const msg = "未找到流放之路窗口";
      this.log(msg);
      this.update({ running: false, stopReason: StopReason.WINDOW_NOT_FOUND, message: msg });
      this.active = false;
      return;
    }
    let win = found;
    this.log(focused ? `已切换到游戏: ${win.title}` : `已定位窗口: ${win.title}（未完全置前，继续运行）`);
    this.log("首次定位模板坐标…");
    if (!(await this.locateRequired(vision, win, s))) return;
    console.log("[craft] after first: locate done");
    let parseFailures = 0;
    let unchanged = 0;
    let lastRaw = "";
    let reason: StopReasonValue = StopReason.MAX_ATTEMPTS;
    let message = "达到最大尝试次数";
    for (let attempt = 1; attempt <= s.maxAttempts; attempt++) {
      if (this.shouldStop()) {
        reason = StopReason.USER_STOP;
        message = "用户停止";
        break;
      }
      this.update({ attempt, message: `第 ${attempt} 次工艺` }, false);
      const t0 = Date.now();
      let ok = await this.clickCachedOrMatch(vision, win, "craft_button", s);
      if (!ok) {
        this.log("craft_button 缓存失效，重新匹配…");
        vision.clearPositionCache("craft_button");
        ok = await this.clickCachedOrMatch(vision, win, "craft_button", s, true);
      }
      if (!ok) {
        if (this.shouldStop()) {
          reason = StopReason.USER_STOP;
          message = "用户停止";
          break;
        }
        reason = StopReason.TEMPLATE_NOT_FOUND;
        message = "未找到 craft_button.png（执行工艺按钮）";
        this.log(message);
        break;
      }
      if (await sleepMs(s.craftWaitMs, () => this.shouldStop())) {
        reason = StopReason.USER_STOP;
        message = "用户停止";
        break;
      }
      let parsed: Item;
      try {
        parsed = await this.readItemFast(vision, win, s);
      } catch (e) {
        parseFailures += 1;
        this.log(`解析失败 (${parseFailures}/${s.maxParseFailures}): ${e}`);
        this.update({ parseFailures });
        if (e instanceof VisionError) vision.clearPositionCache("item_slot");
        if (parseFailures >= 2) {
          const [next, relocateError] = await this.relocateHarvestIfMoved(vision, win, s);
          if (relocateError) {
            reason = next ? StopReason.TEMPLATE_NOT_FOUND : StopReason.WINDOW_NOT_FOUND;
            message = relocateError;
            break;
          }
          win = next!;
        }
        if (parseFailures >= s.maxParseFailures) {
          reason = StopReason.PARSE_FAILURES;
          message = e instanceof VisionError ? String(e) : "连续解析失败次数过多";
          break;
        }
        continue;
      }
      parseFailures = 0;
      const result = matchRuleset(parsed, config.ruleset);
      this.update({ lastItem: parsed, lastMatch: result, parseFailures: 0 });
      this.log(`#${attempt} ${Date.now() - t0}ms | 词缀=${parsed.affixes.length} | ${result.summary}`);
      if (result.success) {
        reason = StopReason.SUCCESS;
        message = "已命中目标词缀";
        this.log(message);
        for (const a of parsed.affixes) this.log(`  • ${a.text}`);
        break;
      }
      const rawKey = parsed.affixTexts().join("|");
      if (rawKey && rawKey === lastRaw) {
        unchanged += 1;
        this.update({ unchangedStreak: unchanged });
        if (unchanged >= s.maxUnchanged) {
          reason = StopReason.UNCHANGED;
          message = "连续多次词缀未变化（可能点空/材料不足/未选中工艺）";
          this.log(message);
          break;
        }
      } else {
        unchanged = 0;
        lastRaw = rawKey;
        this.update({ unchangedStreak: 0 });
      }
      if (await sleepMs(s.actionDelayMs, () => this.shouldStop())) {
        reason = StopReason.USER_STOP;
        message = "用户停止";
        break;
      }
    }
    this.finish(reason, message, this.status.attempt, parseFailures, unchanged);
  }

  private async relocateHarvestIfMoved(
    vision: VisionService,
    win: WindowInfo,
    s: AppSettings,
  ): Promise<[WindowInfo | null, string]> {
    const [next, moved, lost] = this.syncGameWindow(win);
    if (!next) return [null, lost || "游戏窗口丢失"];
    if (!moved) return [win, ""];
    this.log("连续读取失败且窗口已移动，重新匹配模板");
    vision.clearPositionCache();
    if (!(await this.locateRequired(vision, next, s))) {
      return [null, "窗口移动后模板重定位失败"];
    }
    focusWindow(next.hwnd, 1, 20);
    return [next, ""];
  }

  private async locateRequired(vision: VisionService, win: WindowInfo, s: AppSettings): Promise<boolean> {
    return this.locateWorkflowRequired(vision, win, s, ["craft_button", "item_slot"]);
  }

  private async locateWorkflowRequired(vision: VisionService, win: WindowInfo, s: AppSettings, names: string[]): Promise<boolean> {
    console.log("[craft] grab begin", windowMetrics(win).width, "x", windowMetrics(win).height);
    let frame: Mat | null = null;
    try {
      frame = vision.grabWindow(win);
      console.log("[craft] grab ok", frame.cols, "x", frame.rows);
      for (const name of names) {
        const hit = vision.matchInFrame(win, frame, name, s.templateThreshold);
        if (!hit) {
          const msg = `无法定位${workflowAssetLabel(name)}`;
          this.log(msg);
          this.update({ running: false, stopReason: StopReason.TEMPLATE_NOT_FOUND, message: msg });
          this.active = false;
          return false;
        }
        this.log(`定位${workflowAssetLabel(name)} @(${hit.screenX},${hit.screenY}) score=${hit.score.toFixed(3)}`);
      }
      console.log("[craft] first action ok");
      return true;
    } catch (e) {
      const msg = `截屏或识别失败: ${e instanceof Error ? e.message : String(e)}`;
      console.error("[craft]", msg);
      this.log(msg);
      this.update({ running: false, stopReason: StopReason.ERROR, message: msg });
      this.active = false;
      return false;
    } finally {
      console.log("[craft] after first: frame delete", frame?.cols ?? 0, "x", frame?.rows ?? 0);
      try {
        frame?.delete();
      } catch (e) {
        console.error("[craft] after first: frame delete err", e);
      }
    }
  }

  private async locateAndVerifyCurrencies(
    vision: VisionService,
    win: WindowInfo,
    s: AppSettings,
    names: string[],
  ): Promise<boolean> {
    const itemHit = vision.getCachedPosition("item_slot");
    if (!itemHit) {
      this.log("核对通货前丢失了目标装备坐标");
      return false;
    }
    const excluded: [number, number, number, number][] = [hitClientRegion(itemHit)];
    for (const name of names) {
      const hit = await this.findVerifiedCurrency(vision, win, s, name, excluded);
      if (!hit) {
        this.log(`未找到${currencyLabel(name)}`);
        return false;
      }
      excluded.push(hitClientRegion(hit));
    }
    return true;
  }

  private async findVerifiedCurrency(
    vision: VisionService,
    win: WindowInfo,
    s: AppSettings,
    templateName: string,
    excluded: [number, number, number, number][],
    _allowItemSlot = false,
  ): Promise<MatchHit | null> {
    const expected = currencyLabel(templateName);
    for (let attempt = 1; attempt <= LOCATE_CURRENCY_TRIES; attempt++) {
      if (this.shouldStop()) return null;
      vision.clearPositionCache(templateName);
      this.verifiedCurrency.delete(templateName);
      this.stackCounts.delete(templateName);
      try {
        const hit = await this.findAndVerifyInFrame(vision, win, s, templateName, excluded);
        if (hit) return hit;
      } catch (e) {
        this.log(`${expected}定位失败：${visionErrText(e)}`);
      }
      if (attempt < LOCATE_CURRENCY_TRIES) {
        this.log(`未能核对${expected}（${attempt}/${LOCATE_CURRENCY_TRIES}），请确认已打开「非绑定 / 通用」通货页后再试`);
      }
    }
    return null;
  }

  private safeParkHit(
    vision: VisionService,
    avoidHit?: MatchHit,
    allowItemSlot = false,
    allowOtherCurrency = true,
  ): MatchHit | null {
    const avoid = avoidHit ?? this.lastHoverHit;
    if (this.currencyUseArmed) allowOtherCurrency = false;
    if (allowOtherCurrency) {
      for (const name of this.verifiedCurrency) {
        const hit = vision.getCachedPosition(name);
        if (hit && !hitsClose(hit, avoid)) return hit;
      }
    }
    if (allowItemSlot) {
      const hit = vision.getCachedPosition("item_slot");
      if (hit && !hitsClose(hit, avoid)) return hit;
    }
    return null;
  }

  private conflictingCurrencyName(vision: VisionService, hit: MatchHit, templateName: string): string | null {
    for (const name of this.verifiedCurrency) {
      if (name === templateName) continue;
      const other = vision.getCachedPosition(name);
      if (other && currencyHitConflict(hit, other)) return name;
    }
    return null;
  }

  private async findAndVerifyInFrame(
    vision: VisionService,
    win: WindowInfo,
    s: AppSettings,
    templateName: string,
    baseExcluded: [number, number, number, number][],
  ): Promise<MatchHit | null> {
    const expectedName = currencyLabel(templateName);
    const itemHit = vision.getCachedPosition("item_slot");
    const itemRegion = itemHit ? hitClientRegion(itemHit) : null;
    const hits = currencySlotCandidates(win, templateName);
    if (!hits.length) {
      this.log(`没有${expectedName}的仓库格坐标，请打开「非绑定 / 通用」通货页`);
      return null;
    }
    let verifyTry = 0;
    for (const hit of hits) {
      if (this.shouldStop()) return null;
      if (itemRegion && hitCenterInRegion(hit, itemRegion)) {
        this.log(`${expectedName}格落在装备区域内，不悬停`);
        continue;
      }
      if (baseExcluded.some((region) => hitCenterInRegion(hit, region))) continue;
      const other = this.conflictingCurrencyName(vision, hit, templateName);
      if (other) {
        this.log(`${expectedName}格与已核实${currencyLabel(other)}重叠，排除`);
        continue;
      }
      verifyTry += 1;
      this.log(
        `${expectedName}仓库格 ${verifyTry}/${hits.length} @(${hit.screenX},${hit.screenY})，正在 Ctrl+C 核对…`,
      );
      const copied = await this.copyHoveredText(hit, s);
      if (!copied) {
        this.log(`该格未能复制到${expectedName}文本，将尝试相邻格`);
        continue;
      }
      if (copied.includes(expectedName)) {
        const remaining = currencyStackCount(copied);
        if (remaining == null) {
          this.log(`该格是${expectedName}，但未识别到堆叠数量；为避免误点已拒绝`);
          continue;
        }
        if (remaining <= 0) {
          this.log(`${expectedName}堆叠数量为 0，已拒绝`);
          continue;
        }
        vision.setCachedPosition(templateName, hit);
        this.verifiedCurrency.add(templateName);
        this.stackCounts.set(templateName, remaining);
        this.log(`已验证${expectedName} @(${hit.screenX},${hit.screenY}) | 剩余=${remaining}`);
        return hit;
      }
      const observed = copied.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "未复制到物品文本";
      this.log(`该格不是${expectedName}：${observed}`);
    }
    this.log(`未能在仓库通货格核到${expectedName}，请打开「非绑定 / 通用」通货页`);
    return null;
  }

  private refundCurrency(name: string): void {
    const n = this.stackCounts.get(name);
    if (n != null) this.stackCounts.set(name, n + 1);
  }

  private confirmCurrencySpent(vision: VisionService, name: string): void {
    if ((this.stackCounts.get(name) ?? 1) > 0) return;
    vision.clearPositionCache(name);
    this.verifiedCurrency.delete(name);
    this.log(`已使用当前堆叠最后 1 个${currencyLabel(name)}；后续再次需要时将自动检查并停止`);
  }

  private async moveToHit(hit: MatchHit): Promise<void> {
    await moveScreen(hit.screenX, hit.screenY, CURSOR_MS);
    this.lastHoverHit = hit;
  }

  private async clickItemSlotLeft(hit: MatchHit): Promise<void> {
    await clickScreen(hit.screenX, hit.screenY, CURSOR_MS, "left");
    this.lastHoverHit = hit;
  }

  private async putItemBack(vision: VisionService, itemHit?: MatchHit | null): Promise<void> {
    const hit = itemHit ?? vision.getCachedPosition("item_slot");
    if (!hit) return;
    this.disarmCurrency();
    await this.clickItemSlotLeft(hit);
  }

  private isWrongItem(before: Item, after: Item): boolean {
    return Boolean(before.baseType && after.baseType && before.baseType !== after.baseType);
  }

  private sameItemText(before: Item, after: Item): boolean {
    return normalizeClipboardText(before.rawText) === normalizeClipboardText(after.rawText);
  }

  private async tryReadItem(
    vision: VisionService,
    win: WindowInfo,
    s: AppSettings,
    alreadyOnItem = false,
    timeoutMs = COPY_TIMEOUT_MS,
  ): Promise<Item | null> {
    try {
      const item = await this.readItemFast(vision, win, s, alreadyOnItem, "", timeoutMs);
      if ((item.rarity === "魔法" || item.rarity === "稀有") && !item.affixes.length) return null;
      return item;
    } catch (e) {
      const message = String(e);
      if (message.includes("等待剪贴板超时") || message.includes("未读到通货") || message.includes("词缀尚未刷新")) {
        return null;
      }
      throw e;
    }
  }

  private async holdingItem(vision: VisionService, itemHit: MatchHit, s: AppSettings): Promise<boolean> {
    let park = this.safeParkHit(vision, itemHit, false, true);
    if (!park) {
      for (const name of this.verifiedCurrency) {
        const hit = vision.getCachedPosition(name);
        if (hit && !hitsClose(hit, itemHit)) {
          park = hit;
          break;
        }
      }
    }
    if (!park) return false;
    await this.moveToHit(park);
    clearClipboard();
    const leftover = normalizeClipboardText(getClipboard());
    if (leftover && isEquipmentClipboardText(leftover)) return false;
    const text = await this.copyItemText(Math.max(HOLD_CHECK_MS, COPY_TIMEOUT_MS), leftover, true);
    return Boolean(text);
  }

  private async itemInSlot(
    vision: VisionService,
    win: WindowInfo,
    s: AppSettings,
    before: Item,
    alreadyOnItem: boolean,
  ): Promise<Item | null> {
    try {
      const item = await this.tryReadItem(vision, win, s, alreadyOnItem);
      if (!item || this.isWrongItem(before, item)) return null;
      const itemHit = vision.getCachedPosition("item_slot");
      if (itemHit && (await this.holdingItem(vision, itemHit, s))) return null;
      return item;
    } catch {
      return null;
    }
  }

  private async canPutItemBack(
    vision: VisionService,
    win: WindowInfo,
    s: AppSettings,
    itemHit?: MatchHit | null,
  ): Promise<boolean> {
    if (itemHit && (await this.holdingItem(vision, itemHit, s))) return true;
    if (itemHit && cursorInHit(itemHit)) return false;
    try {
      return vision.findInWindow(win, "item_slot", s.templateThreshold) == null;
    } catch {
      return false;
    }
  }

  private async recoverPickedItem(vision: VisionService, win: WindowInfo, s: AppSettings, before: Item): Promise<Item | null> {
    const itemHit = vision.getCachedPosition("item_slot");
    let slotted = await this.itemInSlot(vision, win, s, before, itemHit != null);
    if (slotted) return slotted;
    if (!itemHit || !(await this.canPutItemBack(vision, win, s, itemHit))) return null;
    for (let putTry = 1; putTry <= PUT_BACK_TRIES; putTry++) {
      if (this.shouldStop()) return null;
      this.log(`放回装备 (${putTry}/${PUT_BACK_TRIES})`);
      await this.putItemBack(vision, itemHit);
      slotted = await this.itemInSlot(vision, win, s, before, true);
      if (slotted) return slotted;
      slotted = await this.itemInSlot(vision, win, s, before, false);
      if (slotted) return slotted;
      if (!(await this.canPutItemBack(vision, win, s, itemHit))) return null;
    }
    return null;
  }

  private async readAfterCurrency(
    vision: VisionService,
    win: WindowInfo,
    s: AppSettings,
    before: Item,
  ): Promise<[string, Item | null]> {
    const itemHit = vision.getCachedPosition("item_slot");
    const waitMs = Math.max(COPY_TIMEOUT_MS, s.craftWaitMs);
    try {
      const fresh = await this.readItemFast(vision, win, s, true, before.rawText, waitMs);
      if (!this.isWrongItem(before, fresh)) return ["new", fresh];
    } catch (e) {
      const message = String(e);
      if (!message.includes("等待剪贴板超时") && !message.includes("未读到通货") && !message.includes("词缀尚未刷新")) {
        return ["parse", null];
      }
    }
    let item: Item | null = null;
    try {
      item = await this.tryReadItem(vision, win, s, true);
    } catch (e) {
      if (e instanceof ItemParseError) return ["parse", null];
    }
    if (item && !this.isWrongItem(before, item)) {
      if (!this.sameItemText(before, item)) return ["new", item];
      if (itemHit && (await this.holdingItem(vision, itemHit, s))) {
        return ["pickup", await this.recoverPickedItem(vision, win, s, before)];
      }
      return ["stale", item];
    }
    if (await this.canPutItemBack(vision, win, s, itemHit)) {
      return ["pickup", await this.recoverPickedItem(vision, win, s, before)];
    }
    return ["pickup", null];
  }

  private async applyUntilNewItem(
    vision: VisionService,
    win: WindowInfo,
    step: CraftStep,
    s: AppSettings,
    before: Item,
    currencyNames: string[],
  ): Promise<{ item: Item | null; win: WindowInfo; reason: StopReasonValue | null; message: string }> {
    const templateName = step.currencyTemplate;
    let parseFailures = 0;
    let needRecover = false;
    let game = win;
    for (let applyTry = 1; applyTry <= APPLY_CONFIRM_TRIES; applyTry++) {
      if (this.shouldStop()) return { item: null, win: game, reason: StopReason.USER_STOP, message: "用户停止" };
      if (needRecover) {
        const recovered = await this.recoverPickedItem(vision, game, s, before);
        if (!recovered) continue;
        needRecover = false;
        this.captureItemPointerBaseline(vision);
      }
      let kind: string;
      let readItem: Item | null;
      try {
        [kind, readItem] = await this.useCurrencyOnItem(vision, game, step, s, before);
      } catch (e) {
        if (e instanceof CurrencyUnavailableError) {
          this.disarmCurrency();
          return { item: null, win: game, reason: StopReason.CURRENCY_UNAVAILABLE, message: e.message };
        }
        throw e;
      }
      if (this.shouldStop() || kind === "stop") {
        return { item: null, win: game, reason: StopReason.USER_STOP, message: "用户停止" };
      }
      if (kind === "no_select") {
        this.disarmCurrency();
        this.log("堆叠名称未核对，回到本步通货再右键");
        continue;
      }
      if (kind === "like_pointer") {
        this.disarmCurrency();
        this.log("装备格光标仍像普通指针，不左键，回到堆叠再右键");
        continue;
      }
      if (kind === "no_click") {
        this.disarmCurrency();
        this.log("未停在装备格内，不左键，回到堆叠再右键");
        continue;
      }
      if (kind === "new" && readItem) {
        this.disarmCurrency();
        this.captureItemPointerBaseline(vision);
        this.confirmCurrencySpent(vision, templateName);
        return { item: readItem, win: game, reason: null, message: "" };
      }
      if (kind === "parse") {
        parseFailures += 1;
        this.update({ parseFailures });
        this.log(`剪贴板无法解析为物品 (${parseFailures}/${s.maxParseFailures})`);
        if (parseFailures >= s.maxParseFailures) {
          this.disarmCurrency();
          return { item: null, win: game, reason: StopReason.PARSE_FAILURES, message: "连续解析失败次数过多" };
        }
        continue;
      }
      this.refundCurrency(templateName);
      this.disarmCurrency();
      if (kind === "pickup") {
        this.log(readItem ? "检测到拾取，已放回" : "检测到拾取，无铁证不左键放回");
        if (!readItem) {
          needRecover = true;
          const [next, moved, lost] = this.syncGameWindow(game);
          if (!next) return { item: null, win: game, reason: StopReason.WINDOW_NOT_FOUND, message: lost || "游戏窗口丢失" };
          if (moved) {
            this.log("拾取恢复前发现窗口已移动，重新定位");
            game = next;
            const relocateError = await this.relocateWorkflow(vision, game, s, currencyNames);
            if (relocateError) return { item: null, win: game, reason: StopReason.TEMPLATE_NOT_FOUND, message: relocateError };
          }
        }
      } else {
        this.log("通货未生效，装备仍在格子，不左键，回到堆叠再右键");
      }
    }
    return { item: null, win: game, reason: null, message: "" };
  }

  private async copyHoveredText(hit: MatchHit, s: AppSettings): Promise<string | null> {
    console.log("[craft] copy: hover", hit.screenX, hit.screenY);
    await this.moveToHit(hit);
    return this.copyItemText(COPY_TIMEOUT_MS, "", false, true);
  }

  private clearCurrencyHit(vision: VisionService, name: string): void {
    vision.clearPositionCache(name);
    this.verifiedCurrency.delete(name);
    this.stackCounts.delete(name);
  }

  private resolveItemHit(vision: VisionService, win: WindowInfo, s: AppSettings): MatchHit | null {
    return vision.getCachedPosition("item_slot") ?? vision.findInWindow(win, "item_slot", s.templateThreshold);
  }

  private usableStepCurrencyHit(vision: VisionService, name: string, itemRegion: [number, number, number, number]): MatchHit | null {
    if (!this.verifiedCurrency.has(name)) return null;
    const hit = vision.getCachedPosition(name);
    if (!hit || hitCenterInRegion(hit, itemRegion) || this.conflictingCurrencyName(vision, hit, name)) return null;
    return hit;
  }

  private async selectStepCurrency(vision: VisionService, win: WindowInfo, step: CraftStep, s: AppSettings): Promise<boolean> {
    const itemHit = this.resolveItemHit(vision, win, s);
    if (!itemHit) return false;
    const itemRegion = hitClientRegion(itemHit);
    const templateName = step.currencyTemplate;
    const expectedName = currencyLabel(templateName);
    let excluded: [number, number, number, number][] = [itemRegion];
    let currencyHit = this.usableStepCurrencyHit(vision, templateName, itemRegion);
    if (!currencyHit) currencyHit = await this.findVerifiedCurrency(vision, win, s, templateName, excluded, false);
    if (currencyHit && (hitCenterInRegion(currencyHit, itemRegion) || this.conflictingCurrencyName(vision, currencyHit, templateName))) {
      const conflict = this.conflictingCurrencyName(vision, currencyHit, templateName);
      this.log(`已拒绝${expectedName}匹配结果：${conflict ? `与已核实${currencyLabel(conflict)}中心过近` : "坐标落在目标装备区域内"}`);
      this.clearCurrencyHit(vision, templateName);
      excluded = [itemRegion];
      if (conflict) {
        const other = vision.getCachedPosition(conflict);
        if (other) excluded.push(hitClientRegion(other));
      }
      currencyHit = await this.findVerifiedCurrency(vision, win, s, templateName, excluded, false);
    }
    if (!currencyHit) {
      if (this.shouldStop()) return false;
      throw new CurrencyUnavailableError(`没有找到可用的${expectedName}：可能已用完或已移出可见区域`);
    }
    let copied = await this.copyHoveredText(currencyHit, s);
    if (!copied || !copied.includes(expectedName)) {
      this.log(`堆叠上不是${expectedName}，不右键，重新查找`);
      excluded = [itemRegion, hitClientRegion(currencyHit)];
      this.clearCurrencyHit(vision, templateName);
      currencyHit = await this.findVerifiedCurrency(vision, win, s, templateName, excluded, false);
      if (!currencyHit) {
        if (this.shouldStop()) return false;
        throw new CurrencyUnavailableError(`没有找到可用的${expectedName}：可能已用完或已移出可见区域`);
      }
      copied = await this.copyHoveredText(currencyHit, s);
      if (!copied || !copied.includes(expectedName)) {
        this.log(`再次核对仍不是${expectedName}，本轮不右键`);
        return false;
      }
    }
    let remaining = currencyStackCount(copied);
    if (remaining == null || remaining <= 0) {
      if (this.shouldStop()) return false;
      this.log(`${expectedName}原位置已空或数量无法确认，正在查找其他堆叠…`);
      excluded = [itemRegion, hitClientRegion(currencyHit)];
      currencyHit = await this.findVerifiedCurrency(vision, win, s, templateName, excluded, false);
      remaining = this.stackCounts.get(templateName) ?? null;
      if (!currencyHit || remaining == null || remaining <= 0) {
        if (this.shouldStop()) return false;
        throw new CurrencyUnavailableError(`${expectedName}已用完，或当前画面中没有数量可确认的堆叠`);
      }
      copied = await this.copyHoveredText(currencyHit, s);
      if (!copied || !copied.includes(expectedName)) {
        this.log(`新堆叠不是${expectedName}，本轮不右键`);
        return false;
      }
      remaining = currencyStackCount(copied) ?? remaining;
      if (remaining <= 0) throw new CurrencyUnavailableError(`${expectedName}已用完，或当前画面中没有数量可确认的堆叠`);
    }
    this.stackCounts.set(templateName, remaining);
    if (remaining <= 5 || remaining % 100 === 0) this.log(`${expectedName}使用前剩余=${remaining}`);
    if (!(await this.rightClickCurrencyStack(currencyHit))) {
      this.disarmCurrency();
      return false;
    }
    this.currencyUseArmed = true;
    this.itemUseClicked = false;
    return true;
  }

  private async useCurrencyOnItem(
    vision: VisionService,
    win: WindowInfo,
    step: CraftStep,
    s: AppSettings,
    before: Item,
  ): Promise<[string, Item | null]> {
    if (!this.itemUseClicked) {
      if (!(await this.selectStepCurrency(vision, win, step, s))) return ["no_select", null];
      const itemHit = this.resolveItemHit(vision, win, s);
      if (!itemHit) return ["no_click", null];
      const clickKind = await this.leftClickItemUse(vision, itemHit);
      if (clickKind !== "ok") return [clickKind, null];
      this.itemUseClicked = true;
      const remaining = this.stackCounts.get(step.currencyTemplate);
      if (remaining != null) this.stackCounts.set(step.currencyTemplate, remaining - 1);
    }
    return this.readAfterCurrency(vision, win, s, before);
  }

  private captureItemPointerBaseline(vision: VisionService): boolean {
    const itemHit = vision.getCachedPosition("item_slot");
    if (!itemHit || !cursorInHit(itemHit)) return false;
    const handle = getCursorHandle();
    const patch = vision.captureCursorPatch();
    if (handle == null && !patch) return false;
    this.itemPointerPatch?.delete();
    this.itemPointerHandle = handle;
    this.itemPointerPatch = patch;
    return true;
  }

  private itemCursorHoldsCurrency(vision: VisionService): boolean {
    const handle = getCursorHandle();
    const patch = vision.captureCursorPatch();
    try {
      const handleChanged =
        this.itemPointerHandle != null && handle != null && handle !== this.itemPointerHandle;
      return handleChanged || cursorUnlike(this.itemPointerPatch, patch);
    } finally {
      patch?.delete();
    }
  }

  private async waitAfterFailedUse(): Promise<void> {
    await sleepMs(CURSOR_CONFIRM_TIMEOUT_MS, () => this.shouldStop());
  }

  private async rightClickCurrencyStack(stackHit: MatchHit): Promise<boolean> {
    await this.moveToHit(stackHit);
    if (!cursorInHit(stackHit)) {
      this.log("未能停在已核实通货堆叠上，本轮不右键");
      return false;
    }
    console.log("[craft] after first: click begin right currency");
    await clickScreen(stackHit.screenX, stackHit.screenY, CURSOR_MS, "right");
    console.log("[craft] after first: click ok right currency");
    this.lastHoverHit = stackHit;
    return true;
  }

  private async leftClickItemUse(vision: VisionService, itemHit: MatchHit): Promise<string> {
    if (!this.currencyUseArmed) return "no_select";
    if (!this.itemPointerPatch && this.itemPointerHandle == null) {
      this.log("没有装备格指针基线，不左键");
      return "like_pointer";
    }
    if (this.conflictingCurrencyName(vision, itemHit, "")) {
      this.log("装备格坐标落在通货区域，不左键");
      return "no_click";
    }
    await this.moveToHit(itemHit);
    if (!(await waitUntil(() => cursorInHit(itemHit), CURSOR_CONFIRM_TIMEOUT_MS, 20, () => this.shouldStop()))) {
      this.log("未能停在装备格内，本轮不左键");
      return "no_click";
    }
    const [x, y] = getCursorPosition();
    for (const name of this.verifiedCurrency) {
      const other = vision.getCachedPosition(name);
      if (other && pointInHit(x, y, other)) {
        this.log("光标仍在通货堆叠上，不左键");
        return "no_click";
      }
    }
    let stable = 0;
    const holds = () => {
      if (!cursorInHit(itemHit)) {
        stable = 0;
        return false;
      }
      if (this.itemCursorHoldsCurrency(vision)) {
        stable += 1;
        return stable >= 2;
      }
      stable = 0;
      return false;
    };
    if (!(await waitUntil(holds, CURSOR_CONFIRM_TIMEOUT_MS, 20, () => this.shouldStop()))) return "like_pointer";
    console.log("[craft] after first: click begin item_slot left");
    await this.clickItemSlotLeft(itemHit);
    console.log("[craft] after first: click ok item_slot left");
    return "ok";
  }

  private async clickCachedOrMatch(
    vision: VisionService,
    win: WindowInfo,
    templateName: string,
    s: AppSettings,
    forceRematch = false,
    button: "left" | "right" = "left",
  ): Promise<boolean> {
    let hit = forceRematch ? undefined : vision.getCachedPosition(templateName);
    if (!hit) {
      try {
        hit = vision.findInWindow(win, templateName, s.templateThreshold) ?? undefined;
      } catch (e) {
        this.log(`模板匹配错误 [${templateName}]: ${e}`);
        return false;
      }
    }
    if (!hit) return false;
    if (templateName === "item_slot") {
      this.log("item_slot 只能在使用或确认放回时左键，已拒绝通用点击");
      return false;
    }
    console.log("[craft] after first: click begin", templateName, button);
    await clickScreen(hit.screenX, hit.screenY, 15, button);
    console.log("[craft] after first: click ok", templateName);
    return true;
  }

  private async copyItemText(
    timeoutMs: number,
    staleText = "",
    requireItem = false,
    requireCurrency = false,
  ): Promise<string | null> {
    const stale = normalizeClipboardText(staleText);
    const rejectTexts = stale ? [stale] : [];
    console.log("[craft] copy: clear clipboard");
    try {
      clearClipboard();
    } catch (e) {
      console.error("[craft] 复制失败", e);
      throw new ItemParseError("复制失败");
    }
    let previous = "";
    let found: string | null = null;
    let logged = false;
    let sendFailed = false;
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const pred = async () => {
      if (sendFailed) return false;
      const remain = deadline - Date.now();
      if (remain <= 0) return false;
      try {
        if (!logged) console.log("[craft] copy: keydown");
        if (!hotkey("ctrl", "c")) {
          sendFailed = true;
          console.error("[craft] 复制失败");
          return false;
        }
        if (!logged) {
          console.log("[craft] copy: keyup");
          console.log("[craft] copy: read clipboard");
          logged = true;
        }
        const text = await waitClipboardChange(previous, Math.min(COPY_SLICE_MS, remain), COPY_POLL_MS, true, rejectTexts);
        if (!text) return false;
        if (requireCurrency) {
          if (!isCurrencyClipboardText(text)) {
            previous = normalizeClipboardText(text);
            return false;
          }
        } else if (requireItem) {
          if (!isEquipmentClipboardText(text)) {
            previous = normalizeClipboardText(text);
            return false;
          }
          try {
            const parsed = parseItemText(text);
            if ((parsed.rarity === "魔法" || parsed.rarity === "稀有") && !parsed.affixes.length) {
              previous = normalizeClipboardText(text);
              return false;
            }
          } catch {
            previous = normalizeClipboardText(text);
            return false;
          }
        }
        found = text;
        return true;
      } catch (e) {
        sendFailed = true;
        console.error("[craft] 复制失败", e);
        return false;
      }
    };
    if (await waitUntil(pred, timeoutMs, COPY_POLL_MS, () => this.shouldStop())) return found;
    if (sendFailed) throw new ItemParseError("复制失败");
    return null;
  }

  private async readItemFast(
    vision: VisionService,
    win: WindowInfo,
    s: AppSettings,
    alreadyOnItem = false,
    staleText = "",
    timeoutMs = COPY_TIMEOUT_MS,
  ): Promise<Item> {
    let hit = vision.getCachedPosition("item_slot");
    if (!hit) {
      alreadyOnItem = false;
      hit = vision.findInWindow(win, "item_slot", s.templateThreshold) ?? undefined;
    }
    if (!hit) throw new VisionError("未找到 item_slot.png（工艺槽物品区域）");
    if (!hitInWindow(hit, win)) throw new VisionError("装备格坐标不在游戏窗口内");
    console.log("[craft] copy: hover", hit.screenX, hit.screenY);
    if (!alreadyOnItem) await this.moveToHit(hit);
    else this.lastHoverHit = hit;
    console.log("[craft] after first: copy begin");
    const text = await this.copyItemText(timeoutMs, staleText, true);
    if (!text) {
      throw new ItemParseError(
        staleText ? "未读到通货动作后的新物品文本" : "等待剪贴板超时，请确认鼠标悬停在物品上且复制键为 Ctrl+C",
      );
    }
    console.log("[craft] after first: copy ok");
    const item = parseItemText(text);
    if ((item.rarity === "魔法" || item.rarity === "稀有") && !item.affixes.length) {
      throw new ItemParseError("物品词缀尚未刷新");
    }
    return item;
  }

  async readItemOnce(settings: AppSettings): Promise<Item> {
    await initVision();
    const vision = new VisionService(settings.templatesDir, settings.templateThreshold, 0.7, [1]);
    try {
      if (!fs.existsSync(vision.templatePath("item_slot"))) throw new VisionError("缺少模板 item_slot.png");
      const win = findGameWindow(settings.windowTitleKeywords);
      if (!win) throw new VisionError("未找到流放之路窗口");
      focusWindow(win.hwnd, 3, 50);
      const hit = vision.findInWindow(win, "item_slot", settings.templateThreshold);
      if (!hit) throw new VisionError("未找到 item_slot.png");
      return this.readItemFast(vision, win, settings);
    } finally {
      vision.close();
    }
  }
}
