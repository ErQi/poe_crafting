import { randomUUID } from "crypto";

export const CraftMode = {
  GENERIC: "generic",
  PRESET: "preset",
  WORKFLOW: "workflow",
} as const;

export const MatchMode = {
  ALL: "all",
  ANY: "any",
} as const;

export const CompareOp = {
  NONE: "",
  GE: ">=",
  GT: ">",
  LE: "<=",
  LT: "<",
  EQ: "=",
} as const;

export const StopReason = {
  SUCCESS: "success",
  USER_STOP: "user_stop",
  MAX_ATTEMPTS: "max_attempts",
  PARSE_FAILURES: "parse_failures",
  TEMPLATE_NOT_FOUND: "template_not_found",
  CURRENCY_UNAVAILABLE: "currency_unavailable",
  LIFEFORCE_INSUFFICIENT: "lifeforce_insufficient",
  UNCHANGED: "unchanged",
  WINDOW_NOT_FOUND: "window_not_found",
  WORKFLOW_STOP: "workflow_stop",
  ERROR: "error",
  NOT_STARTED: "not_started",
} as const;

export type StopReasonValue = (typeof StopReason)[keyof typeof StopReason];

export const CRAFT_PRESETS: Record<string, string> = {
  reforge: "reforge",
  augment: "augment",
  remove: "remove",
  randomise: "randomise",
  sacrifice: "sacrifice",
};

export const CRAFT_PRESET_LABELS: Record<string, string> = {
  reforge: "重铸 (Reforge)",
  augment: "增幅 (Augment)",
  remove: "移除 (Remove)",
  randomise: "随机 (Randomise)",
  sacrifice: "献祭 (Sacrifice)",
};

function optionalFloat(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function optionalInt(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) ? n : null;
}

export class Affix {
  text: string;
  values: number[];
  constructor(text: string, values: number[] = []) {
    this.text = text;
    this.values = values;
  }
  get firstValue(): number | null {
    return this.values[0] ?? null;
  }
  get secondValue(): number | null {
    return this.values.length > 1 ? this.values[1] : null;
  }
}

export class Item {
  rarity = "";
  name = "";
  baseType = "";
  itemLevel: number | null = null;
  affixes: Affix[] = [];
  explicitModCount: number | null = null;
  corrupted = false;
  rawText = "";
  flags: string[] = [];

  affixTexts(): string[] {
    return this.affixes.map((a) => a.text);
  }

  get craftAffixCount(): number {
    return this.explicitModCount ?? this.affixes.length;
  }
}

export class MatchRule {
  pattern: string;
  operator: string;
  threshold: number | null;
  threshold2: number | null;
  enabled: boolean;
  note: string;
  id: string;

  constructor(init: Partial<MatchRule> & { pattern: string }) {
    this.pattern = init.pattern;
    this.operator = init.operator ?? CompareOp.NONE;
    this.threshold = init.threshold ?? null;
    this.threshold2 = init.threshold2 ?? null;
    this.enabled = init.enabled ?? true;
    this.note = init.note ?? "";
    this.id = init.id || randomUUID();
  }

  toDict() {
    return {
      id: this.id,
      pattern: this.pattern,
      operator: this.operator,
      threshold: this.threshold,
      threshold2: this.threshold2,
      enabled: this.enabled,
      note: this.note,
    };
  }

  static fromDict(data: Record<string, unknown>): MatchRule {
    return new MatchRule({
      id: String(data.id || randomUUID()),
      pattern: String(data.pattern || ""),
      operator: String(data.operator || ""),
      threshold: optionalFloat(data.threshold),
      threshold2: optionalFloat(data.threshold2),
      enabled: Boolean(data.enabled ?? true),
      note: String(data.note || ""),
    });
  }
}

export class RuleGroup {
  name: string;
  combine: string;
  enabled: boolean;
  rules: MatchRule[];
  minMatches: number | null;
  id: string;

  constructor(init: Partial<RuleGroup> = {}) {
    this.name = init.name ?? "规则组";
    this.combine = init.combine ?? MatchMode.ALL;
    this.enabled = init.enabled ?? true;
    this.rules = init.rules ?? [];
    this.minMatches = init.minMatches ?? null;
    this.id = init.id || randomUUID();
  }

  toDict() {
    return {
      id: this.id,
      name: this.name,
      combine: this.combine,
      enabled: this.enabled,
      min_matches: this.minMatches,
      rules: this.rules.map((r) => r.toDict()),
    };
  }

  static fromDict(data: Record<string, unknown>): RuleGroup {
    const rawRules = Array.isArray(data.rules) ? data.rules : [];
    const rules = rawRules
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => MatchRule.fromDict(item));
    let combine = String(data.combine || data.match_mode || MatchMode.ALL);
    if (combine !== MatchMode.ALL && combine !== MatchMode.ANY) combine = MatchMode.ALL;
    let minMatches = optionalInt(data.min_matches);
    if (minMatches != null && minMatches < 1) minMatches = null;
    return new RuleGroup({
      id: String(data.id || randomUUID()),
      name: String(data.name || "规则组"),
      combine,
      enabled: Boolean(data.enabled ?? true),
      rules,
      minMatches,
    });
  }
}

export class RuleSet {
  groupCombine: string;
  groups: RuleGroup[];

  constructor(init: Partial<RuleSet> = {}) {
    this.groupCombine = init.groupCombine ?? MatchMode.ALL;
    this.groups = init.groups ?? [];
  }

  toDict() {
    return {
      version: 2,
      group_combine: this.groupCombine,
      groups: this.groups.map((g) => g.toDict()),
    };
  }

  static fromDict(data: unknown): RuleSet {
    if (!data || typeof data !== "object") return new RuleSet();
    const raw = data as Record<string, unknown>;
    if (Array.isArray(raw.groups)) {
      const groups = raw.groups
        .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
        .map((g) => RuleGroup.fromDict(g));
      let combine = String(raw.group_combine || MatchMode.ALL);
      if (combine !== MatchMode.ALL && combine !== MatchMode.ANY) combine = MatchMode.ALL;
      if (!groups.length) groups.push(new RuleGroup({ name: "规则组 1" }));
      return new RuleSet({ groupCombine: combine, groups });
    }
    let mode = String(raw.match_mode || MatchMode.ALL);
    if (mode !== MatchMode.ALL && mode !== MatchMode.ANY) mode = MatchMode.ALL;
    const rawRules = Array.isArray(raw.rules) ? raw.rules : [];
    const rules = rawRules
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => MatchRule.fromDict(item));
    return new RuleSet({
      groupCombine: MatchMode.ALL,
      groups: [new RuleGroup({ name: "规则组 1", combine: mode, enabled: true, rules })],
    });
  }

  enabledGroups(): RuleGroup[] {
    return this.groups.filter((g) => g.enabled);
  }

  allRulesFlat(): MatchRule[] {
    return this.groups.flatMap((g) => g.rules);
  }
}

export class CraftStep {
  name: string;
  currencyTemplate: string;
  expectedRarity: string;
  ruleset: RuleSet;
  onSuccess: string;
  onFailure: string;
  enabled: boolean;
  id: string;

  constructor(init: Partial<CraftStep> = {}) {
    this.name = init.name ?? "新步骤";
    this.currencyTemplate = init.currencyTemplate ?? "";
    this.expectedRarity = init.expectedRarity ?? "";
    this.ruleset = init.ruleset ?? new RuleSet({ groups: [new RuleGroup({ name: "本步条件" })] });
    this.onSuccess = init.onSuccess ?? "next";
    this.onFailure = init.onFailure ?? "repeat";
    this.enabled = init.enabled ?? true;
    this.id = init.id || randomUUID();
  }

  toDict() {
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      currency_template: this.currencyTemplate,
      expected_rarity: this.expectedRarity,
      ruleset: this.ruleset.toDict(),
      on_success: this.onSuccess,
      on_failure: this.onFailure,
    };
  }

  static fromDict(data: Record<string, unknown>): CraftStep {
    let rawRuleset = data.ruleset;
    if (!rawRuleset || typeof rawRuleset !== "object") {
      rawRuleset = {
        match_mode: String(data.match_mode || MatchMode.ALL),
        rules: Array.isArray(data.rules) ? data.rules : [],
      };
    }
    return new CraftStep({
      id: String(data.id || randomUUID()),
      name: String(data.name || "新步骤"),
      enabled: Boolean(data.enabled ?? true),
      currencyTemplate: String(data.currency_template || "").trim(),
      expectedRarity: String(data.expected_rarity || "").trim(),
      ruleset: RuleSet.fromDict(rawRuleset),
      onSuccess: String(data.on_success || "next"),
      onFailure: String(data.on_failure || "repeat"),
    });
  }
}

export class CraftWorkflow {
  name: string;
  steps: CraftStep[];
  startStepId: string;
  id: string;
  description: string;
  group: string;

  constructor(init: Partial<CraftWorkflow> = {}) {
    this.name = init.name ?? "多步骤通货流程";
    this.steps = init.steps ?? [];
    this.startStepId = init.startStepId ?? "";
    this.id = init.id || randomUUID();
    this.description = init.description ?? "";
    this.group = init.group ?? "";
  }

  toDict() {
    return {
      version: 1,
      id: this.id,
      name: this.name,
      description: this.description,
      group: this.group,
      start_step_id: this.startStepId,
      steps: this.steps.map((s) => s.toDict()),
    };
  }

  static fromDict(data: unknown): CraftWorkflow {
    if (!data || typeof data !== "object") return new CraftWorkflow();
    const raw = data as Record<string, unknown>;
    const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
    const steps = rawSteps
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => CraftStep.fromDict(x));
    let startStepId = String(raw.start_step_id || "");
    if (startStepId && !steps.some((s) => s.id === startStepId)) startStepId = "";
    return new CraftWorkflow({
      id: String(raw.id || randomUUID()),
      name: String(raw.name || "多步骤通货流程"),
      description: String(raw.description || ""),
      group: String(raw.group || ""),
      steps,
      startStepId,
    });
  }

  enabledSteps(): CraftStep[] {
    return this.steps.filter((s) => s.enabled);
  }

  getStep(stepId: string): CraftStep | undefined {
    return this.steps.find((s) => s.id === stepId);
  }
}

export class WorkflowLibrary {
  activeId: string;
  workflows: CraftWorkflow[];

  constructor(init: Partial<WorkflowLibrary> = {}) {
    this.activeId = init.activeId ?? "";
    this.workflows = init.workflows ?? [];
  }

  toDict() {
    return {
      version: 2,
      active_id: this.activeId,
      workflows: this.workflows.map((w) => w.toDict()),
    };
  }

  static fromDict(data: unknown): WorkflowLibrary {
    if (!data || typeof data !== "object") return new WorkflowLibrary();
    const raw = data as Record<string, unknown>;
    const list = Array.isArray(raw.workflows) ? raw.workflows : [];
    const workflows: CraftWorkflow[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const wf = CraftWorkflow.fromDict(item);
      if (seen.has(wf.id)) wf.id = randomUUID();
      seen.add(wf.id);
      workflows.push(wf);
    }
    let activeId = String(raw.active_id || "");
    if (activeId && !workflows.some((w) => w.id === activeId)) activeId = "";
    if (!activeId && workflows.length) activeId = workflows[0].id;
    return new WorkflowLibrary({ activeId, workflows });
  }

  get(workflowId: string): CraftWorkflow | undefined {
    return this.workflows.find((w) => w.id === workflowId);
  }

  active(): CraftWorkflow {
    const current = this.get(this.activeId);
    if (current) return current;
    if (this.workflows.length) {
      this.activeId = this.workflows[0].id;
      return this.workflows[0];
    }
    const empty = new CraftWorkflow({ name: "空流程", group: "自定义" });
    this.workflows.push(empty);
    this.activeId = empty.id;
    return empty;
  }

  select(workflowId: string): CraftWorkflow {
    const target = this.get(workflowId);
    if (!target) return this.active();
    this.activeId = workflowId;
    return target;
  }

  put(workflow: CraftWorkflow): void {
    if (!workflow.id) workflow.id = randomUUID();
    const index = this.workflows.findIndex((w) => w.id === workflow.id);
    if (index >= 0) this.workflows[index] = workflow;
    else this.workflows.push(workflow);
  }

  remove(workflowId: string): boolean {
    if (this.workflows.length <= 1) return false;
    this.workflows = this.workflows.filter((w) => w.id !== workflowId);
    if (this.activeId === workflowId) {
      this.activeId = this.workflows[0]?.id ?? "";
    }
    return true;
  }
}

export class RuleHit {
  rule: MatchRule;
  matched: boolean;
  matchedAffix: string | null;
  actualValue: number | null;
  actualValues: number[];
  reason: string;
  groupId: string;
  groupName: string;

  constructor(init: {
    rule: MatchRule;
    matched: boolean;
    matchedAffix?: string | null;
    actualValue?: number | null;
    actualValues?: number[];
    reason?: string;
    groupId?: string;
    groupName?: string;
  }) {
    this.rule = init.rule;
    this.matched = init.matched;
    this.matchedAffix = init.matchedAffix ?? null;
    this.actualValue = init.actualValue ?? null;
    this.actualValues = init.actualValues ?? [];
    this.reason = init.reason ?? "";
    this.groupId = init.groupId ?? "";
    this.groupName = init.groupName ?? "";
  }
}

export class GroupMatchResult {
  group: RuleGroup;
  success: boolean;
  hits: RuleHit[];

  constructor(group: RuleGroup, success: boolean, hits: RuleHit[] = []) {
    this.group = group;
    this.success = success;
    this.hits = hits;
  }

  get summary(): string {
    let logic = this.group.combine === MatchMode.ALL ? "AND" : "OR";
    if (this.group.minMatches) logic = `至少${this.group.minMatches}`;
    const mark = this.success ? "✓" : "✗";
    const parts = this.hits.map((h) => {
      const m = h.matched ? "✓" : "✗";
      let thr = h.rule.threshold != null ? `${h.rule.threshold}` : "";
      if (h.rule.threshold2 != null) {
        thr = thr ? `${thr}-${h.rule.threshold2}` : `${h.rule.threshold2}`;
      }
      let actual = "";
      if (h.actualValues.length) actual = `（实际=${h.actualValues.join("-")}）`;
      else if (h.actualValue != null) actual = `（实际=${h.actualValue}）`;
      return `${m}${h.rule.pattern}${h.rule.operator || ""}${thr}${actual}`;
    });
    return `${mark}[${this.group.name}|${logic}] ${parts.join(" · ") || "(空组)"}`;
  }
}

export class MatchResult {
  success: boolean;
  mode: string;
  hits: RuleHit[];
  groupResults: GroupMatchResult[];

  constructor(init: {
    success: boolean;
    mode: string;
    hits?: RuleHit[];
    groupResults?: GroupMatchResult[];
  }) {
    this.success = init.success;
    this.mode = init.mode;
    this.hits = init.hits ?? [];
    this.groupResults = init.groupResults ?? [];
  }

  get summary(): string {
    if (this.groupResults.length) {
      const logic = this.mode === MatchMode.ALL ? "AND" : "OR";
      return `组间${logic}: ${this.groupResults.map((g) => g.summary).join(" || ")}`;
    }
    const parts = this.hits.map((h) => {
      const mark = h.matched ? "✓" : "✗";
      return `${mark} ${h.rule.pattern}${h.rule.operator || ""}${h.rule.threshold ?? ""}`;
    });
    return parts.join(" | ") || "(无启用规则)";
  }
}

export class AppSettings {
  windowTitleKeywords = ["Path of Exile", "流放之路"];
  hotkeyStop = "f8";
  hotkeyStart = "f7";
  maxAttempts = 200;
  maxParseFailures = 5;
  maxUnchanged = 8;
  actionDelayMs = 350;
  craftWaitMs = 600;
  clipboardTimeoutMs = 1500;
  clipboardPollMs = 50;
  templateThreshold = 0.82;
  matchMode: string = MatchMode.ALL;
  craftMode: string = CraftMode.GENERIC;
  craftPreset = "reforge";
  templatesDir = "assets/templates";
  rulesFile = "config/rules.json";
  workflowFile = "config/workflows.json";

  toDict() {
    return {
      window_title_keywords: this.windowTitleKeywords,
      hotkey_stop: this.hotkeyStop,
      hotkey_start: this.hotkeyStart,
      max_attempts: this.maxAttempts,
      max_parse_failures: this.maxParseFailures,
      max_unchanged: this.maxUnchanged,
      action_delay_ms: this.actionDelayMs,
      craft_wait_ms: this.craftWaitMs,
      clipboard_timeout_ms: this.clipboardTimeoutMs,
      clipboard_poll_ms: this.clipboardPollMs,
      template_threshold: this.templateThreshold,
      match_mode: this.matchMode,
      craft_mode: this.craftMode,
      craft_preset: this.craftPreset,
      templates_dir: this.templatesDir,
      rules_file: this.rulesFile,
      workflow_file: this.workflowFile,
    };
  }

  static fromDict(data: Record<string, unknown>): AppSettings {
    const s = new AppSettings();
    const map: [keyof AppSettings, string, (v: unknown) => unknown][] = [
      ["windowTitleKeywords", "window_title_keywords", (v) => (Array.isArray(v) ? v.map(String) : s.windowTitleKeywords)],
      ["hotkeyStop", "hotkey_stop", String],
      ["hotkeyStart", "hotkey_start", String],
      ["maxAttempts", "max_attempts", (v) => Number(v)],
      ["maxParseFailures", "max_parse_failures", (v) => Number(v)],
      ["maxUnchanged", "max_unchanged", (v) => Number(v)],
      ["actionDelayMs", "action_delay_ms", (v) => Number(v)],
      ["craftWaitMs", "craft_wait_ms", (v) => Number(v)],
      ["clipboardTimeoutMs", "clipboard_timeout_ms", (v) => Number(v)],
      ["clipboardPollMs", "clipboard_poll_ms", (v) => Number(v)],
      ["templateThreshold", "template_threshold", (v) => Number(v)],
      ["matchMode", "match_mode", String],
      ["craftMode", "craft_mode", String],
      ["craftPreset", "craft_preset", String],
      ["templatesDir", "templates_dir", String],
      ["rulesFile", "rules_file", String],
      ["workflowFile", "workflow_file", String],
    ];
    for (const [key, jsonKey, conv] of map) {
      if (jsonKey in data) (s as unknown as Record<string, unknown>)[key] = conv(data[jsonKey]);
    }
    return s;
  }
}

export class RunStatus {
  running = false;
  attempt = 0;
  parseFailures = 0;
  unchangedStreak = 0;
  lastItem: Item | null = null;
  lastMatch: MatchResult | null = null;
  stopReason: StopReasonValue = StopReason.NOT_STARTED;
  message = "";
  workflowStepName = "";
  workflowStepIndex = 0;
  workflowName = "";

  clone(): RunStatus {
    const s = new RunStatus();
    Object.assign(s, this);
    return s;
  }
}
