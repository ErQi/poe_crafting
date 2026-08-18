import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { clipboard, nativeImage, shell } from "electron";
import { AutomationConfig, CraftAutomation } from "./automation";
import { getClipboard } from "./clipboard";
import {
  loadLibrary,
  loadRuleset,
  loadSettings,
  resolvePath,
  saveLibrary,
  saveRuleset,
  saveSettings,
} from "./configStore";
import { CURRENCIES, CURRENCY_BY_TEMPLATE, currencyLabel } from "./currencies";
import { ensureCurrencyIcons } from "./currencyIcons";
import { focusGameWindow } from "./input";
import { formatItemPreview, ItemParseError, parseItemText } from "./itemParser";
import { matchRuleset, normalizeOperator, parseThresholdText } from "./matcher";
import {
  AppSettings,
  CRAFT_PRESET_LABELS,
  CRAFT_PRESETS,
  CraftMode,
  CraftStep,
  CraftWorkflow,
  Item,
  MatchMode,
  MatchResult,
  RuleGroup,
  RuleSet,
  RunStatus,
  StopReason,
} from "./models";
import { formatCompletionOverlayLines, STOP_REASON_TEXT } from "./overlayFormat";
import { initVision, VisionError, VisionService } from "./vision";
import { TRANSITION_GOTO_PREFIX, TRANSITION_STOP, validateWorkflow } from "./workflow";

export const UI_HELP = "help";
export const UI_GARDEN = "garden";
export const UI_NORMAL = "normal";
export const UI_TEMPLATES = "templates";
export const UI_SETTINGS = "settings";
const UI_PAGES = [UI_HELP, UI_GARDEN, UI_NORMAL, UI_TEMPLATES, UI_SETTINGS];
const IDLE_START_PAGES = [UI_HELP, UI_SETTINGS];

const TEMPLATE_SLOTS: [string, string, boolean][] = [
  ["craft_button", "执行工艺按钮", true],
  ["item_slot", "目标装备位置（工艺槽/背包）", true],
];

type HostResult =
  | ({ ok: true } & Record<string, unknown>)
  | ({ ok: false; error: string } & Record<string, unknown>);

function ok(extra: Record<string, unknown> = {}): HostResult {
  return { ok: true, ...extra };
}
function err(message: string, extra: Record<string, unknown> = {}): HostResult {
  return { ok: false, error: message, ...extra };
}
function startErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Invalid argument/i.test(msg)) return "未找到流放之路窗口";
  return msg || "启动失败";
}

function normalizeRuleset(data: Record<string, unknown>): RuleSet {
  const raw = { ...data };
  for (const group of (raw.groups as Record<string, unknown>[]) || []) {
    if (!group || typeof group !== "object") continue;
    for (const rule of (group.rules as Record<string, unknown>[]) || []) {
      if (!rule || typeof rule !== "object") continue;
      const thr = rule.threshold;
      if (typeof thr === "string") {
        const [a, b] = parseThresholdText(thr);
        rule.threshold = a;
        rule.threshold2 = b;
      }
      rule.operator = normalizeOperator(String(rule.operator || ""));
    }
  }
  return RuleSet.fromDict(raw);
}

function formatItem(item: Item, match?: MatchResult | null): string {
  let text = formatItemPreview(item);
  if (!match) return text;
  const outer = match.mode === MatchMode.ANY ? "OR" : "AND";
  text += `\n\n匹配结果: ${match.success ? "成功" : "未达标"}（组间${outer}）\n${match.summary}`;
  if (match.groupResults.length) {
    for (const gr of match.groupResults) {
      text += `\n${gr.summary}`;
      for (const hit of gr.hits) {
        const mark = hit.matched ? "✓" : "✗";
        const extra = hit.matchedAffix ? ` | ${hit.matchedAffix}` : "";
        const val = hit.actualValue != null ? ` | 实际=${hit.actualValue}` : "";
        text += `\n    ${mark} ${hit.rule.pattern} ${hit.reason}${extra}${val}`;
      }
    }
    return text;
  }
  for (const hit of match.hits) {
    const mark = hit.matched ? "✓" : "✗";
    const extra = hit.matchedAffix ? ` | ${hit.matchedAffix}` : "";
    const val = hit.actualValue != null ? ` | 实际=${hit.actualValue}` : "";
    text += `\n  ${mark} ${hit.rule.pattern} ${hit.reason}${extra}${val}`;
  }
  return text;
}

function imageUrl(png: Buffer, maxW = 0, maxH = 0): string {
  let img = nativeImage.createFromBuffer(png);
  if (maxW && maxH) {
    const { width, height } = img.getSize();
    const scale = Math.min(maxW / width, maxH / height, 1);
    if (scale < 1) img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale) });
  }
  return img.toDataURL();
}

export interface OverlayBridge {
  resetRun(): void;
  show(anchor: { x: number; y: number }): void;
  hide(): void;
  addLine(text: string, success?: boolean): void;
  pushStatus(status: RunStatus): void;
  showCompletion(lines: string[], success: boolean): void;
}

export class AppHost {
  settings: AppSettings;
  ruleset: RuleSet;
  library;
  workflow: CraftWorkflow;
  private logs: string[] = [];
  itemPreview = "（尚未读取）";
  private wasRunning = false;
  private lastItemTs = 0;
  private pendingPng: Buffer | null = null;
  templateTest: { status: string; color: string; testing: boolean } = { status: "", color: "", testing: false };
  alert: { id: number; title: string; message: string } | null = null;
  private alertId = 0;
  automation: CraftAutomation;
  private uiPage = UI_NORMAL;
  private lastCraftPage = UI_NORMAL;
  private pushFn: ((rt: Record<string, unknown>) => void) | null = null;
  private overlay: OverlayBridge | null = null;
  private hotkeyStart: (() => void) | null = null;
  private hotkeyStop: (() => void) | null = null;
  private templateRowCache: { key: string; rows: ReturnType<AppHost["buildTemplateRows"]> } | null = null;
  private pendingPreviewUrl: string | null = null;
  initError = "";
  private launchQueued = false;

  constructor() {
    this.settings = loadSettings();
    this.ruleset = loadRuleset(resolvePath(this.settings.rulesFile));
    this.library = loadLibrary(resolvePath(this.settings.workflowFile));
    this.workflow = this.library.active();
    this.automation = new CraftAutomation((m) => this.onLog(m), (s) => this.onStatus(s));
    this.uiPage = UI_HELP;
    this.lastCraftPage = this.settings.craftMode === CraftMode.WORKFLOW ? UI_NORMAL : UI_GARDEN;
  }

  async boot(): Promise<void> {
    this.log("正在读取配置、加载识别库…");
    try {
      await ensureCurrencyIcons(resolvePath(this.settings.templatesDir), (m) => this.log(m));
    } catch (e) {
      console.error("[main] 通货图标下载失败:", e);
      this.log(`内置通货图标下载失败（可稍后手动放入 templates）: ${e}`);
    }
    try {
      console.log("[main] opencv 开始加载");
      await new Promise<void>((r) => setImmediate(r));
      await initVision();
      console.log("[main] opencv 已就绪");
    } catch (e) {
      console.error("[main] opencv 加载失败:", e);
      this.log(`识别库加载失败: ${e}`);
      throw e;
    }
    this.log("就绪。当前页决定启动哪套：花园工艺 / 普通工艺。");
    this.log(`当前流程: ${this.workflow.name}`);
    this.log(`模板目录: ${resolvePath(this.settings.templatesDir)}`);
    this.log(`开始热键: ${this.settings.hotkeyStart.toUpperCase()}  停止热键: ${this.settings.hotkeyStop.toUpperCase()}`);
  }

  noteInitError(message: string): void {
    this.initError = message;
    this.log(message);
  }

  notifyError(title: string, message: string): void {
    try {
      this.setAlert(title, message);
      this.log(message);
    } catch (e) {
      console.error("[hotkey] 通知窗口失败:", e);
    }
  }

  attach(push: (rt: Record<string, unknown>) => void, overlay: OverlayBridge): void {
    this.pushFn = push;
    this.overlay = overlay;
  }

  shutdown(): void {
    this.automation.requestStop(StopReason.USER_STOP);
  }

  bindHotkeys(start: () => void, stop: () => void): void {
    this.hotkeyStart = start;
    this.hotkeyStop = stop;
  }

  async onHotkeyStart(): Promise<{ ok: boolean; error?: string }> {
    try {
      if (this.busy()) return ok();
      if (IDLE_START_PAGES.includes(this.uiPage)) {
        this.log(`热键 ${this.settings.hotkeyStart.toUpperCase()}：${this.uiPage === UI_HELP ? "使用说明" : "设置"}页不启动工艺`);
        return ok();
      }
      const kind = this.resolveKind("");
      this.log(`热键 ${this.settings.hotkeyStart.toUpperCase()}：开始（${kind === UI_GARDEN ? "花园工艺" : "普通工艺"}）`);
      const result = await this.start(kind);
      if (result && result.ok === false) {
        this.notifyError("启动失败", String(result.error || "启动失败"));
      }
      return result;
    } catch (e) {
      const message = startErrorText(e);
      this.notifyError("启动失败", message);
      return err(message);
    }
  }

  onHotkeyStop(): void {
    try {
      if (this.automation.isRunning()) {
        this.automation.requestStop(StopReason.USER_STOP);
        this.log(`热键 ${this.settings.hotkeyStop.toUpperCase()}：请求停止`);
      }
    } catch (e) {
      console.error("[hotkey] stop fail:", e);
    }
  }

  snapshot() {
    return {
      library: this.library.toDict(),
      workflow: this.workflow.toDict(),
      settings: this.settings.toDict(),
      ruleset: this.ruleset.toDict(),
      item_preview: this.itemPreview,
      meta: this.meta(),
      runtime: this.runtime(),
      templates: this.templateRows(),
    };
  }

  runtime() {
    const status = this.automation.currentStatus;
    const reason = STOP_REASON_TEXT[status.stopReason] || status.stopReason;
    let text = "状态: 空闲";
    if (status.running) text = `状态: 运行中 | 第 ${status.attempt} 次 | ${status.message}`;
    else if (status.stopReason !== StopReason.NOT_STARTED) text = `状态: 已停止 | ${reason} | ${status.message}`;
    else if (status.message) text = `状态: 空闲 | ${status.message}`;
    return {
      running: this.automation.isRunning(),
      attempt: status.attempt,
      message: status.message,
      stop_reason: status.stopReason,
      stop_reason_text: reason,
      status_text: text,
      workflow_step_name: status.workflowStepName,
      workflow_step_index: status.workflowStepIndex,
      workflow_name: status.workflowName,
      logs: this.logs.slice(-120),
      item_preview: this.itemPreview,
      alert: this.alert,
      template_test: { ...this.templateTest },
      pending_preview: this.pendingPreviewUrl,
      pending_info: this.pendingInfo(),
      init_error: this.initError,
    };
  }

  private meta() {
    return {
      currencies: CURRENCIES.map((c) => ({ label: c.label, template: c.templateName })),
      presets: Object.keys(CRAFT_PRESETS).map((k) => ({ key: k, label: CRAFT_PRESET_LABELS[k] })),
      rarities: [
        { value: "", label: "不校验" },
        { value: "普通", label: "普通" },
        { value: "魔法", label: "魔法" },
        { value: "稀有", label: "稀有" },
      ],
      ops: ["", ">=", ">", "<=", "<", "="],
      template_slots: TEMPLATE_SLOTS.map(([key, title, required]) => ({ key, title, required })),
      hotkey_start: (this.settings.hotkeyStart || "f7").toUpperCase(),
      hotkey_stop: (this.settings.hotkeyStop || "f8").toUpperCase(),
    };
  }

  private pendingInfo(): string {
    if (!this.pendingPng) return "未粘贴";
    const { width, height } = nativeImage.createFromBuffer(this.pendingPng).getSize();
    return `已粘贴 ${width}×${height}，选择目标后点「保存到模板」`;
  }

  private wf() {
    return { ok: true, workflow: this.workflow.toDict(), library: this.library.toDict() };
  }

  private onLog(msg: string): void {
    this.log(msg);
  }

  private setAlert(title: string, message: string): void {
    this.alertId += 1;
    this.alert = { id: this.alertId, title, message };
  }

  private log(msg: string): void {
    this.logs.push(String(msg));
    if (this.logs.length > 240) this.logs = this.logs.slice(-120);
    this.push();
  }

  private onStatus(status: RunStatus): void {
    if (status.running) {
      this.wasRunning = true;
      this.overlay?.pushStatus(status);
    } else {
      const just = this.wasRunning;
      this.wasRunning = false;
      if (just && status.stopReason !== StopReason.NOT_STARTED) {
        const reason = STOP_REASON_TEXT[status.stopReason] || status.stopReason;
        this.overlay?.showCompletion(formatCompletionOverlayLines(status, reason), status.stopReason === StopReason.SUCCESS);
      } else this.overlay?.pushStatus(status);
    }
    if (status.lastItem) {
      const now = Date.now();
      if (!status.running || now - this.lastItemTs >= 1500) {
        this.lastItemTs = now;
        this.itemPreview = formatItem(status.lastItem, status.lastMatch);
      }
    }
    this.push();
  }

  private push(): void {
    try {
      this.pushFn?.(this.runtime());
    } catch {
      /* 窗口已销毁时忽略 */
    }
  }

  private busy(): boolean {
    return this.automation.isRunning() || this.launchQueued;
  }

  async invoke(name: string, args: unknown[]): Promise<unknown> {
    const map: Record<string, (...a: unknown[]) => unknown> = {
      get_state: () => this.snapshot(),
      get_runtime: () => this.runtime(),
      select_workflow: (id) => this.selectWorkflow(String(id || "")),
      new: (g) => this.newWorkflow(String(g || "自定义")),
      new_workflow: (g) => this.newWorkflow(String(g || "自定义")),
      duplicate: () => this.duplicateWorkflow(),
      duplicate_workflow: () => this.duplicateWorkflow(),
      delete: () => this.deleteWorkflow(),
      delete_workflow: () => this.deleteWorkflow(),
      save_workflow: () => this.saveWorkflow(),
      update_workflow_fields: (f) => this.updateWorkflowFields((f as Record<string, unknown>) || {}),
      update_step: (id, f) => this.updateStep(String(id || ""), (f as Record<string, unknown>) || {}),
      add_step: () => this.addStep(),
      remove_step: (id) => this.removeStep(String(id || "")),
      move_step: (id, d) => this.moveStep(String(id || ""), Number(d || 0)),
      update_rules: (rs, id) => this.updateRules((rs as Record<string, unknown>) || {}, id == null ? null : String(id)),
      set_ui_page: (p) => this.setUiPage(String(p || "")),
      prepare_start: (k) => this.prepareStart(String(k || "")),
      start: (k) => this.start(String(k || "")),
      stop: () => this.stop(),
      update_settings: (p) => this.updateSettings((p as Record<string, unknown>) || {}),
      save_settings: () => this.saveSettingsNow(),
      save_rules: () => this.saveRulesNow(),
      refresh_item: () => this.refreshItem(),
      parse_clipboard: () => this.parseClipboard(),
      list_templates: () => this.listTemplates(),
      paste_template: () => this.pasteTemplate(),
      save_template: (key, overwrite) => this.saveTemplate(String(key || ""), Boolean(overwrite)),
      open_templates_dir: () => this.openTemplatesDir(),
      refresh_templates: () => this.refreshTemplates(),
      test_templates: () => this.testTemplates(),
    };
    const fn = map[name];
    if (!fn) return err(`未知接口: ${name}`);
    return fn(...args);
  }

  selectWorkflow(id: string) {
    if (this.busy()) return err("运行中不能切换流程");
    const target = this.library.select(id);
    this.workflow = target;
    this.log(`已切换流程: ${target.name}`);
    return this.wf();
  }

  newWorkflow(group = "自定义") {
    if (this.busy()) return err("运行中不能新建流程");
    const step = new CraftStep({
      name: "新步骤 1",
      currencyTemplate: "currency_alteration",
      ruleset: new RuleSet({ groups: [new RuleGroup({ name: "本步条件" })] }),
    });
    const workflow = new CraftWorkflow({
      name: `新流程 ${this.library.workflows.length + 1}`,
      group: group.trim() || "自定义",
      steps: [step],
      startStepId: step.id,
    });
    this.library.put(workflow);
    this.library.select(workflow.id);
    this.workflow = workflow;
    this.log(`已新建流程: ${workflow.name}`);
    return this.wf();
  }

  duplicateWorkflow() {
    if (this.busy()) return err("运行中不能复制流程");
    const cloned = CraftWorkflow.fromDict(this.library.active().toDict());
    cloned.id = randomUUID();
    cloned.name = `${this.library.active().name} 副本`;
    cloned.group = this.library.active().group || "自定义";
    this.library.put(cloned);
    this.library.select(cloned.id);
    this.workflow = cloned;
    this.log(`已复制流程: ${cloned.name}`);
    return this.wf();
  }

  deleteWorkflow() {
    if (this.busy()) return err("运行中不能删除流程");
    if (this.library.workflows.length <= 1) return err("至少保留一套流程");
    const name = this.library.active().name;
    this.library.remove(this.library.active().id);
    this.workflow = this.library.active();
    this.log(`已删除流程: ${name}`);
    return this.wf();
  }

  saveWorkflow() {
    if (this.busy()) return err("运行中不能保存流程");
    this.settings.workflowFile = "config/workflows.json";
    const file = resolvePath(this.settings.workflowFile);
    saveLibrary(this.library, file);
    saveSettings(this.settings);
    const errors = validateWorkflow(this.workflow);
    this.log(`流程库已保存: ${file}（当前 ${this.workflow.name}）`);
    if (errors.length) {
      return { ...this.wf(), warning: `配置已保存，但开始前还需修正：\n${errors.map((x) => `• ${x}`).join("\n")}`, path: file };
    }
    return { ...this.wf(), message: `已保存 ${this.library.workflows.length} 套流程\n${file}` };
  }

  updateWorkflowFields(fields: Record<string, unknown>) {
    if (this.busy()) return err("运行中不能改流程");
    if ("name" in fields) this.workflow.name = String(fields.name || "").trim() || "多步骤通货流程";
    if ("description" in fields) this.workflow.description = String(fields.description || "").trim();
    if ("group" in fields) this.workflow.group = String(fields.group || "").trim();
    if ("start_step_id" in fields) {
      const sid = String(fields.start_step_id || "");
      if (this.workflow.getStep(sid)) this.workflow.startStepId = sid;
    }
    this.library.put(this.workflow);
    return this.wf();
  }

  updateStep(stepId: string, fields: Record<string, unknown>) {
    if (this.busy()) return err("运行中不能改步骤");
    const step = this.workflow.getStep(stepId);
    if (!step) return err("步骤不存在");
    if ("name" in fields) step.name = String(fields.name || "").trim() || "未命名步骤";
    if ("enabled" in fields) step.enabled = Boolean(fields.enabled);
    if ("currency_template" in fields) step.currencyTemplate = String(fields.currency_template || "").trim();
    if ("expected_rarity" in fields) step.expectedRarity = String(fields.expected_rarity || "").trim();
    if ("on_success" in fields) step.onSuccess = String(fields.on_success || TRANSITION_STOP);
    if ("on_failure" in fields) step.onFailure = String(fields.on_failure || TRANSITION_STOP);
    this.library.put(this.workflow);
    return this.wf();
  }

  addStep() {
    if (this.busy()) return err("运行中不能加步骤");
    const step = new CraftStep({
      name: `新步骤 ${this.workflow.steps.length + 1}`,
      currencyTemplate: "currency_alteration",
      ruleset: new RuleSet({ groups: [new RuleGroup({ name: "本步条件" })] }),
    });
    this.workflow.steps.push(step);
    if (!this.workflow.startStepId) this.workflow.startStepId = step.id;
    this.library.put(this.workflow);
    return { ...this.wf(), step_id: step.id };
  }

  removeStep(stepId: string) {
    if (this.busy()) return err("运行中不能删步骤");
    if (!this.workflow.getStep(stepId)) return err("步骤不存在");
    this.workflow.steps = this.workflow.steps.filter((s) => s.id !== stepId);
    const target = `${TRANSITION_GOTO_PREFIX}${stepId}`;
    for (const other of this.workflow.steps) {
      if (other.onSuccess === target) other.onSuccess = TRANSITION_STOP;
      if (other.onFailure === target) other.onFailure = TRANSITION_STOP;
    }
    if (this.workflow.startStepId === stepId) {
      this.workflow.startStepId = this.workflow.enabledSteps()[0]?.id ?? "";
    }
    this.library.put(this.workflow);
    return this.wf();
  }

  moveStep(stepId: string, direction: number) {
    if (this.busy()) return err("运行中不能调整步骤");
    const index = this.workflow.steps.findIndex((s) => s.id === stepId);
    if (index < 0) return err("步骤不存在");
    const dest = index + (direction > 0 ? 1 : -1);
    if (dest < 0 || dest >= this.workflow.steps.length) return this.wf();
    [this.workflow.steps[index], this.workflow.steps[dest]] = [this.workflow.steps[dest], this.workflow.steps[index]];
    this.library.put(this.workflow);
    return this.wf();
  }

  updateRules(ruleset: Record<string, unknown>, stepId: string | null) {
    if (this.busy()) return err("运行中不能改规则");
    const rs = normalizeRuleset(ruleset);
    if (stepId) {
      const step = this.workflow.getStep(stepId);
      if (!step) return err("步骤不存在");
      step.ruleset = rs;
      this.library.put(this.workflow);
      return this.wf();
    }
    this.ruleset = rs;
    this.settings.matchMode = rs.groupCombine;
    return { ok: true, ruleset: this.ruleset.toDict() };
  }

  updateSettings(patch: Record<string, unknown>) {
    const s = this.settings;
    if ("max_attempts" in patch) {
      const n = parseInt(String(patch.max_attempts), 10);
      if (Number.isFinite(n)) s.maxAttempts = Math.max(1, n);
    }
    if ("action_delay_ms" in patch) {
      const n = parseInt(String(patch.action_delay_ms), 10);
      if (Number.isFinite(n)) s.actionDelayMs = Math.max(0, n);
    }
    if ("craft_wait_ms" in patch) {
      const n = parseInt(String(patch.craft_wait_ms), 10);
      if (Number.isFinite(n)) s.craftWaitMs = Math.max(0, n);
    }
    if ("template_threshold" in patch) {
      const n = Number(patch.template_threshold);
      if (Number.isFinite(n)) s.templateThreshold = n;
    }
    const hotkeyChanged = "hotkey_start" in patch || "hotkey_stop" in patch;
    if ("hotkey_start" in patch) s.hotkeyStart = String(patch.hotkey_start || "f7").trim().toLowerCase();
    if ("hotkey_stop" in patch) s.hotkeyStop = String(patch.hotkey_stop || "f8").trim().toLowerCase();
    if ("craft_mode" in patch) {
      const mode = String(patch.craft_mode || CraftMode.GENERIC);
      if (mode === CraftMode.WORKFLOW) s.craftMode = mode;
      else s.craftMode = CraftMode.GENERIC;
    }
    s.matchMode = this.ruleset.groupCombine;
    if (hotkeyChanged) this.hotkeyStart?.();
    return { ok: true, settings: s.toDict(), meta: this.meta() };
  }

  saveSettingsNow() {
    saveSettings(this.settings);
    this.hotkeyStart?.();
    this.log("设置已保存");
    return { ok: true, message: "设置已写入 config/settings.json", settings: this.settings.toDict(), meta: this.meta() };
  }

  saveRulesNow() {
    saveRuleset(this.ruleset, resolvePath(this.settings.rulesFile));
    this.log("规则已保存（多组）");
    return { ok: true, message: "规则已写入 config/rules.json", ruleset: this.ruleset.toDict() };
  }

  setUiPage(page: string) {
    let next = (page || "").trim() || UI_HELP;
    if (!UI_PAGES.includes(next)) next = UI_HELP;
    this.uiPage = next;
    if (next === UI_GARDEN || next === UI_NORMAL) {
      this.lastCraftPage = next;
      this.applyKind(next);
    }
    return { ok: true, page: next, settings: this.settings.toDict() };
  }

  private resolveKind(kind: string): string {
    const k = (kind || "").trim();
    if (k === UI_GARDEN || k === UI_NORMAL) return k;
    if (this.uiPage === UI_GARDEN || this.uiPage === UI_NORMAL) return this.uiPage;
    if (this.lastCraftPage === UI_GARDEN || this.lastCraftPage === UI_NORMAL) return this.lastCraftPage;
    return this.settings.craftMode === CraftMode.WORKFLOW ? UI_NORMAL : UI_GARDEN;
  }

  private applyKind(kind: string): string {
    const resolved = this.resolveKind(kind);
    if (resolved === UI_GARDEN) this.settings.craftMode = CraftMode.GENERIC;
    else this.settings.craftMode = CraftMode.WORKFLOW;
    return resolved;
  }

  prepareStart(kind = "") {
    this.applyKind(kind);
    const [errors, tips] = this.startCheck();
    if (errors.length) return err(errors.join("\n"));
    return { ok: true, tips };
  }

  start(kind = "") {
    try {
      if (this.busy()) return err("已在运行");
      const resolved = this.applyKind(kind);
      const [errors] = this.startCheck();
      if (errors.length) return err(errors.join("\n"));
      this.log(`启动${resolved === UI_GARDEN ? "花园工艺" : "普通工艺"}`);
      this.launchQueued = true;
      setImmediate(() => this.beginLaunch());
      return ok();
    } catch (e) {
      this.launchQueued = false;
      return err(startErrorText(e));
    }
  }

  private beginLaunch(): void {
    try {
      const result = this.launch();
      if (result && result.ok === false) this.notifyError("启动失败", String(result.error || "启动失败"));
    } catch (e) {
      this.notifyError("启动失败", startErrorText(e));
    } finally {
      this.launchQueued = false;
    }
  }

  stop() {
    this.automation.requestStop(StopReason.USER_STOP);
    this.log("已请求停止…");
    return ok();
  }

  private startCheck(): [string[], string] {
    const s = this.settings;
    const workflow = this.library.active();
    this.workflow = workflow;
    if (s.craftMode === CraftMode.WORKFLOW) {
      const errors = validateWorkflow(workflow);
      if (errors.length) return [errors, ""];
      const start = workflow.steps.find((st) => st.id === workflow.startStepId) || workflow.enabledSteps()[0];
      const currencies = [...new Set(workflow.enabledSteps().map((st) => currencyLabel(st.currencyTemplate)))].join("、");
      return [
        [],
        [
          "请确认：",
          "1. 游戏为窗口/无边框模式，仓库打开「非绑定 / 通用」通货页",
          "2. 目标装备在画面中，流程通货在仓库固定格子里",
          "3. item_slot.png 截取的是目标装备本身",
          `4. 流程使用通货: ${currencies}（按仓库格坐标悬停后 Ctrl+C 核名）`,
          `5. 当前流程: ${workflow.name}  起始步骤: ${start.name}`,
          `6. 紧急停止热键: ${s.hotkeyStop.toUpperCase()}`,
          "\n第三方自动化可能违反游戏条款，风险自负。是否开始？",
        ].join("\n"),
      ];
    }
    const enabled = this.ruleset.groups
      .filter((g) => g.enabled)
      .flatMap((g) => g.rules.filter((r) => r.enabled && r.pattern.trim()));
    if (!enabled.length) return [["请至少添加并启用一条非空目标条件"], ""];
    return [
      [],
      [
        "请确认：",
        "1. 游戏为窗口/无边框模式，园艺台已打开",
        "2. 物品已放入工艺槽",
        "3. 已准备 craft_button.png 与 item_slot.png 模板",
        "4. 请先在游戏里选好花园工艺再开始（开始后只点执行按钮）",
        `5. 紧急停止热键: ${s.hotkeyStop.toUpperCase()}`,
        "\n第三方自动化可能违反游戏条款，风险自负。是否开始？",
      ].join("\n"),
    ];
  }

  private launch() {
    try {
      console.log("[craft] launch began");
      const s = this.settings;
      const workflow = s.craftMode === CraftMode.WORKFLOW ? this.library.active() : null;
      saveSettings(s);
      saveRuleset(this.ruleset, resolvePath(s.rulesFile));
      if (workflow) {
        s.workflowFile = "config/workflows.json";
        saveLibrary(this.library, resolvePath(s.workflowFile));
      }
      this.log("正在切换到游戏窗口…");
      let win = null;
      let focused = false;
      try {
        [win, focused] = focusGameWindow(s.windowTitleKeywords, 8);
      } catch (e) {
        return err(startErrorText(e));
      }
      if (!win) {
        this.log("未找到流放之路窗口，已取消启动");
        return err("未找到流放之路窗口");
      }
      let focusNote = "";
      if (focused) this.log(`已切换到游戏: ${win.title}`);
      else {
        this.log(`已找到窗口但未能置前: ${win.title}，将继续启动并重试`);
        try {
          const retry = focusGameWindow(s.windowTitleKeywords, 6);
          if (retry[0]) win = retry[0];
          if (retry[1]) this.log("重试后已切换到游戏窗口");
          else {
            this.log("仍可能未置前，点击/复制可能失败");
            focusNote = "未能自动置前，请手动点一下游戏窗口。";
          }
        } catch (e) {
          this.log(`重试置前失败: ${startErrorText(e)}`);
          focusNote = "未能自动置前，请手动点一下游戏窗口。";
        }
      }
      const cfg: AutomationConfig = {
        settings: s,
        ruleset: this.ruleset,
        craftMode: s.craftMode,
        craftPreset: s.craftPreset,
        workflow,
      };
      this.wasRunning = true;
      this.automation.start(cfg);
      const { x, y } = {
        x: win.left + Math.floor((win.right - win.left) / 2),
        y: win.top + Math.floor((win.bottom - win.top) / 2),
      };
      try {
        this.overlay?.resetRun();
        this.overlay?.show({ x, y });
        this.overlay?.addLine("▶ 开始匹配…", false);
      } catch (e) {
        console.error("[overlay] 显示失败，继续工艺:", e);
      }
      console.log("[craft] launch queued");
      return ok({ focus_warning: focusNote });
    } catch (e) {
      this.wasRunning = false;
      try {
        this.overlay?.hide();
      } catch {
        /* ignore */
      }
      return err(startErrorText(e));
    }
  }

  async refreshItem() {
    try {
      const item = await this.automation.readItemOnce(this.settings);
      const result = matchRuleset(item, this.ruleset);
      this.itemPreview = formatItem(item, result);
      this.log("读取成功");
      return { ok: true, item_preview: this.itemPreview };
    } catch (e) {
      this.log(`读取失败: ${e}`);
      return err(`读取失败: ${e}`);
    }
  }

  parseClipboard() {
    try {
      const item = parseItemText(getClipboard());
      const result = matchRuleset(item, this.ruleset);
      this.itemPreview = formatItem(item, result);
      this.log("已从剪贴板解析物品");
      return { ok: true, item_preview: this.itemPreview };
    } catch (e) {
      this.log(`解析失败: ${e}`);
      return err(String(e));
    }
  }

  private slotPath(key: string): string {
    return path.join(resolvePath(this.settings.templatesDir), `${key}.png`);
  }

  private templateCacheKey(): string {
    return TEMPLATE_SLOTS.map(([key]) => {
      try {
        const st = fs.statSync(this.slotPath(key));
        return `${key}:${st.mtimeMs}:${st.size}`;
      } catch {
        return `${key}:0`;
      }
    }).join("|");
  }

  private buildTemplateRows() {
    return TEMPLATE_SLOTS.map(([key, title, required]) => {
      const file = this.slotPath(key);
      const exists = fs.existsSync(file);
      const row = {
        key,
        title,
        required,
        exists,
        thumb: "",
        info: `${key}.png · 未配置 · ${required ? "必需" : "可选"}`,
      };
      if (exists) {
        const img = nativeImage.createFromPath(file);
        const { width, height } = img.getSize();
        row.thumb = imageUrl(img.toPNG(), 72, 48);
        row.info = `${key}.png · ${width}×${height} · ${required ? "必需" : "可选"}`;
      }
      return row;
    });
  }

  private templateRows() {
    const key = this.templateCacheKey();
    if (this.templateRowCache?.key === key) return this.templateRowCache.rows;
    const rows = this.buildTemplateRows();
    this.templateRowCache = { key, rows };
    return rows;
  }

  private setPendingPng(png: Buffer): void {
    this.pendingPng = png;
    this.pendingPreviewUrl = imageUrl(png, 280, 150);
  }

  listTemplates() {
    return { ok: true, templates: this.templateRows(), runtime: this.runtime() };
  }

  pasteTemplate() {
    const img = clipboard.readImage();
    if (img.isEmpty()) {
      const msg = "剪贴板中没有图片。请先用 Win+Shift+S / 截图工具截取并复制，或复制一张图片文件。";
      this.log(msg);
      return err(msg);
    }
    this.setPendingPng(img.toPNG());
    const { width, height } = img.getSize();
    this.log(`已从剪贴板粘贴图片 ${width}×${height}`);
    return { ok: true, runtime: this.runtime() };
  }

  saveTemplate(key: string, overwrite = false) {
    let png = this.pendingPng;
    if (!png) {
      const img = clipboard.readImage();
      if (img.isEmpty()) return err("请先 Ctrl+V 或点「从剪贴板粘贴」");
      png = img.toPNG();
      this.setPendingPng(png);
    }
    const file = this.slotPath(key);
    if (fs.existsSync(file) && !overwrite) {
      return { ok: false, need_overwrite: true, error: `已存在 ${path.basename(file)}，是否覆盖？` };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, png);
    this.log(`已保存模板: ${file}`);
    return { ok: true, message: `已写入\n${file}`, templates: this.templateRows() };
  }

  openTemplatesDir() {
    const dir = resolvePath(this.settings.templatesDir);
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return ok();
  }

  refreshTemplates() {
    this.log("已刷新模板预览");
    return { ok: true, templates: this.templateRows() };
  }

  testTemplates() {
    if (this.templateTest.testing) return ok({ testing: true });
    const names = ["craft_button", "item_slot"];
    const vision = new VisionService(this.settings.templatesDir, this.settings.templateThreshold);
    for (const fname of vision.listTemplates()) {
      const stem = path.parse(fname).name;
      if (stem in CURRENCY_BY_TEMPLATE) continue;
      if (!names.includes(stem)) names.push(stem);
    }
    this.templateTest = { status: "正在测试（请保持游戏窗口可见）…", color: "#f4a261", testing: true };
    this.log("测试模板匹配…");
    this.push();
    const thr = this.settings.templateThreshold;
    const keywords = [...this.settings.windowTitleKeywords];
    void (async () => {
      try {
        await initVision();
        const results = vision.testMatchReport(keywords, names, thr);
        this.onTemplateTest(results, null, thr);
      } catch (e) {
        this.onTemplateTest([], String(e), thr);
      } finally {
        vision.close();
      }
    })();
    return ok({ testing: true });
  }

  private onTemplateTest(results: Record<string, unknown>[], errText: string | null, thr: number): void {
    if (errText) {
      this.templateTest = { status: `测试失败: ${errText}`, color: "#e5383b", testing: false };
      this.log(`测试模板匹配失败: ${errText}`);
      this.setAlert("测试模板匹配", errText);
      this.push();
      return;
    }
    const lines = [`阈值: ${thr.toFixed(2)}`, ""];
    let okN = 0;
    for (const row of results) {
      const name = String(row.template || "?");
      const label = currencyLabel(name);
      const display = label !== name ? `${label}（内置通货）` : name;
      let line: string;
      if (row.ok) {
        okN += 1;
        line = `✓ ${display}  score=${row.score}  屏幕坐标=${JSON.stringify(row.screen_xy)}`;
      } else {
        line = `✗ ${display}  ${row.error}${row.score != null ? `  score=${row.score}` : ""}`;
      }
      this.log(`  ${line}`);
      lines.push(line);
    }
    this.templateTest = { status: `完成：${okN}/${results.length} 命中`, color: okN ? "#6a994e" : "#e5383b", testing: false };
    this.setAlert("测试模板匹配", lines.join("\n"));
    this.push();
  }
}
