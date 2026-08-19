import { CURRENCY_BY_TEMPLATE } from "./currencies";
import { matchRuleset } from "./matcher";
import { hasCurrencyCell } from "./stashGrid";
import {
  CraftStep,
  CraftWorkflow,
  Item,
  MatchMode,
  MatchResult,
  MatchRule,
  RuleGroup,
  RuleSet,
  WorkflowLibrary,
} from "./models";

export const TRANSITION_NEXT = "next";
export const TRANSITION_REPEAT = "repeat";
export const TRANSITION_FINISH = "finish";
export const TRANSITION_STOP = "stop";
export const TRANSITION_GOTO_PREFIX = "goto:";
export const ROUTE_STEP = "step";
export const ROUTE_FINISH = "finish";
export const ROUTE_STOP = "stop";
export const RARITY_VALUES = ["", "普通", "魔法", "稀有"];

export interface StepEvaluation {
  success: boolean;
  rarityMatched: boolean;
  rulesMatched: boolean;
  match: MatchResult;
  summary: string;
}

export interface RouteDecision {
  kind: string;
  nextStepId: string;
}

function hasEnabledRules(ruleset: RuleSet): boolean {
  return ruleset.groups.some(
    (g) => g.enabled && g.rules.some((r) => r.enabled && Boolean(r.pattern.trim())),
  );
}

export function evaluateStep(item: Item, step: CraftStep): StepEvaluation {
  let match: MatchResult;
  let rulesMatched: boolean;
  if (hasEnabledRules(step.ruleset)) {
    match = matchRuleset(item, step.ruleset);
    rulesMatched = match.success;
  } else {
    rulesMatched = true;
    match = new MatchResult({ success: true, mode: step.ruleset.groupCombine || MatchMode.ALL });
  }
  const expected = step.expectedRarity.trim();
  const rarityMatched = !expected || item.rarity.trim() === expected;
  const success = rarityMatched && rulesMatched;
  match.success = success;
  const parts: string[] = [];
  if (expected) parts.push(`${rarityMatched ? "✓" : "✗"}稀有度=${expected}（实际=${item.rarity || "-"}）`);
  if (hasEnabledRules(step.ruleset)) parts.push(match.summary);
  else if (!expected) parts.push("无条件");
  return { success, rarityMatched, rulesMatched, match, summary: parts.join(" | ") };
}

export function firstEnabledStep(workflow: CraftWorkflow): CraftStep | undefined {
  if (workflow.startStepId) {
    const configured = workflow.getStep(workflow.startStepId);
    if (configured?.enabled) return configured;
  }
  return workflow.steps.find((s) => s.enabled);
}

export function resolveTransition(
  workflow: CraftWorkflow,
  currentStepId: string,
  transition: string,
): RouteDecision {
  const value = (transition || TRANSITION_STOP).trim();
  if (value === TRANSITION_FINISH) return { kind: ROUTE_FINISH, nextStepId: "" };
  if (value === TRANSITION_STOP) return { kind: ROUTE_STOP, nextStepId: "" };
  if (value === TRANSITION_REPEAT) return { kind: ROUTE_STEP, nextStepId: currentStepId };
  if (value === TRANSITION_NEXT) {
    const currentIndex = workflow.steps.findIndex((s) => s.id === currentStepId);
    for (const step of workflow.steps.slice(currentIndex + 1)) {
      if (step.enabled) return { kind: ROUTE_STEP, nextStepId: step.id };
    }
    return { kind: ROUTE_FINISH, nextStepId: "" };
  }
  if (value.startsWith(TRANSITION_GOTO_PREFIX)) {
    const target = workflow.getStep(value.slice(TRANSITION_GOTO_PREFIX.length));
    if (target?.enabled) return { kind: ROUTE_STEP, nextStepId: target.id };
  }
  throw new Error(`无效或不可用的步骤去向: ${value}`);
}

export function validateWorkflow(workflow: CraftWorkflow): string[] {
  const errors: string[] = [];
  if (!workflow.enabledSteps().length) errors.push("至少需要一个启用步骤");
  const ids = workflow.steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) errors.push("步骤 ID 重复");
  if (workflow.startStepId) {
    const start = workflow.getStep(workflow.startStepId);
    if (!start || !start.enabled) errors.push("起始步骤不存在或未启用");
  }
  workflow.steps.forEach((step, index) => {
    const label = `第 ${index + 1} 步「${step.name || "未命名"}」`;
    if (!step.id) errors.push(`${label}缺少步骤 ID`);
    if (step.enabled && !step.currencyTemplate.trim()) errors.push(`${label}未选择使用通货`);
    else if (step.enabled && !(step.currencyTemplate in CURRENCY_BY_TEMPLATE)) {
      errors.push(`${label}选择了未内置的通货`);
    } else if (step.enabled && !hasCurrencyCell(step.currencyTemplate)) {
      errors.push(`${label}选择了没有仓库格的通货`);
    }
    if (!RARITY_VALUES.includes(step.expectedRarity)) {
      errors.push(`${label}的期望稀有度无效: ${step.expectedRarity}`);
    }
    for (const [branchName, transition] of [
      ["命中去向", step.onSuccess],
      ["未命中去向", step.onFailure],
    ] as const) {
      const value = (transition || "").trim();
      if ([TRANSITION_NEXT, TRANSITION_REPEAT, TRANSITION_FINISH, TRANSITION_STOP].includes(value)) continue;
      if (value.startsWith(TRANSITION_GOTO_PREFIX)) {
        const target = workflow.getStep(value.slice(TRANSITION_GOTO_PREFIX.length));
        if (target?.enabled) continue;
      }
      errors.push(`${label}的${branchName}无效: ${value || "(空)"}`);
    }
  });
  return errors;
}

const T1_LIFE = 130;
const T1_ELE_ATTACK = 43;
const T1_FIRE_DAMAGE = 26;
const T1_ELE_RES = 46;
const T1_GENERIC_ELE = 19;

function rule(pattern: string, threshold: number, note = ""): MatchRule {
  return new MatchRule({ pattern, operator: ">=", threshold, note });
}

function asGroup(target: MatchRule | RuleGroup, name: string): RuleGroup {
  if (target instanceof RuleGroup) return RuleGroup.fromDict(target.toDict());
  return new RuleGroup({ name, combine: MatchMode.ALL, rules: [target] });
}

function pairRuleset(combine: string, first: RuleGroup, second: RuleGroup): RuleSet {
  return new RuleSet({ groupCombine: combine, groups: [first, second] });
}

function either(name: string, ...rules: MatchRule[]): RuleSet {
  return new RuleSet({
    groupCombine: MatchMode.ALL,
    groups: [new RuleGroup({ name, combine: MatchMode.ANY, rules })],
  });
}

function both(name: string, ...rules: MatchRule[]): RuleSet {
  return new RuleSet({
    groupCombine: MatchMode.ALL,
    groups: [new RuleGroup({ name, combine: MatchMode.ALL, rules })],
  });
}

export function lifeRule(threshold = T1_LIFE): MatchRule {
  return rule("最大生命", threshold, `T1 ≥ ${threshold}`);
}
export function eleAttackRule(threshold = T1_ELE_ATTACK): MatchRule {
  return rule("攻击技能的元素伤害提高", threshold, `T1 ≥ ${threshold}`);
}
export function fireDamageRule(threshold = T1_FIRE_DAMAGE): MatchRule {
  return rule("火焰伤害提高", threshold, `T1 ≥ ${threshold}`);
}
export function fireResRule(threshold = T1_ELE_RES): MatchRule {
  return rule("火焰抗性", threshold, `T1 ≥ ${threshold}`);
}
export function coldResRule(threshold = T1_ELE_RES): MatchRule {
  return rule("冰霜抗性", threshold, `T1 ≥ ${threshold}`);
}
export function lightningResRule(threshold = T1_ELE_RES): MatchRule {
  return rule("闪电抗性", threshold, `T1 ≥ ${threshold}`);
}
export function anyT1ResGroup(threshold = T1_ELE_RES): RuleGroup {
  return new RuleGroup({
    name: "T1 元素抗性（可转换）",
    combine: MatchMode.ANY,
    rules: [fireResRule(threshold), coldResRule(threshold), lightningResRule(threshold)],
  });
}
export function genericEleRule(threshold = T1_GENERIC_ELE): MatchRule {
  return rule("元素伤害提高", threshold, `T1 ≥ ${threshold}`);
}

export function magicTwoModWorkflow(
  workflowId: string,
  name: string,
  description: string,
  group: string,
  first: MatchRule | RuleGroup,
  second: MatchRule | RuleGroup,
): CraftWorkflow {
  const transmuteId = `${workflowId}__transmute`;
  const alterationId = `${workflowId}__alteration`;
  const augmentId = `${workflowId}__augment`;
  const eitherSet = pairRuleset(MatchMode.ANY, asGroup(first, "目标 A"), asGroup(second, "目标 B"));
  const bothSet = pairRuleset(MatchMode.ALL, asGroup(first, "目标 A"), asGroup(second, "目标 B"));
  return new CraftWorkflow({
    id: workflowId,
    name,
    description,
    group,
    startStepId: transmuteId,
    steps: [
      new CraftStep({
        id: transmuteId,
        name: "蜕变并检查任一目标",
        currencyTemplate: "currency_transmutation",
        expectedRarity: "魔法",
        ruleset: eitherSet,
        onSuccess: `${TRANSITION_GOTO_PREFIX}${augmentId}`,
        onFailure: TRANSITION_NEXT,
      }),
      new CraftStep({
        id: alterationId,
        name: "改造洗出任一目标",
        currencyTemplate: "currency_alteration",
        expectedRarity: "魔法",
        ruleset: eitherSet,
        onSuccess: TRANSITION_NEXT,
        onFailure: TRANSITION_REPEAT,
      }),
      new CraftStep({
        id: augmentId,
        name: "单词缀时增幅补另一目标",
        currencyTemplate: "currency_augmentation",
        expectedRarity: "魔法",
        ruleset: bothSet,
        onSuccess: TRANSITION_FINISH,
        onFailure: `${TRANSITION_GOTO_PREFIX}${alterationId}`,
      }),
    ],
  });
}

export function magicOneModWorkflow(
  workflowId: string,
  name: string,
  description: string,
  group: string,
  target: MatchRule,
): CraftWorkflow {
  const transmuteId = `${workflowId}__transmute`;
  const alterationId = `${workflowId}__alteration`;
  const hit = both("命中目标前缀", target);
  return new CraftWorkflow({
    id: workflowId,
    name,
    description,
    group,
    startStepId: transmuteId,
    steps: [
      new CraftStep({
        id: transmuteId,
        name: "蜕变并检查目标前缀",
        currencyTemplate: "currency_transmutation",
        expectedRarity: "魔法",
        ruleset: hit,
        onSuccess: TRANSITION_FINISH,
        onFailure: TRANSITION_NEXT,
      }),
      new CraftStep({
        id: alterationId,
        name: "改造洗出目标前缀",
        currencyTemplate: "currency_alteration",
        expectedRarity: "魔法",
        ruleset: hit,
        onSuccess: TRANSITION_FINISH,
        onFailure: TRANSITION_REPEAT,
      }),
    ],
  });
}

export function rareTwoPrefixWorkflow(
  workflowId: string,
  name: string,
  description: string,
  group: string,
  first: MatchRule,
  second: MatchRule,
  stepIds?: Record<string, string>,
): CraftWorkflow {
  const ids = {
    transmute: `${workflowId}__transmute`,
    alteration: `${workflowId}__alteration`,
    augment: `${workflowId}__augment`,
    regal: `${workflowId}__regal`,
    scour: `${workflowId}__scour`,
    ...stepIds,
  };
  const eitherSet = either("先保留任一 T1 目标", first, second);
  const bothSet = both("同时具备两个 T1 目标", first, second);
  return new CraftWorkflow({
    id: workflowId,
    name,
    description,
    group,
    startStepId: ids.transmute,
    steps: [
      new CraftStep({
        id: ids.transmute,
        name: "蜕变并检查任一目标",
        currencyTemplate: "currency_transmutation",
        expectedRarity: "魔法",
        ruleset: eitherSet,
        onSuccess: `${TRANSITION_GOTO_PREFIX}${ids.augment}`,
        onFailure: TRANSITION_NEXT,
      }),
      new CraftStep({
        id: ids.alteration,
        name: "改造洗出任一目标",
        currencyTemplate: "currency_alteration",
        expectedRarity: "魔法",
        ruleset: eitherSet,
        onSuccess: TRANSITION_NEXT,
        onFailure: TRANSITION_REPEAT,
      }),
      new CraftStep({
        id: ids.augment,
        name: "单词缀时增幅尝试补齐另一目标",
        currencyTemplate: "currency_augmentation",
        expectedRarity: "魔法",
        ruleset: bothSet,
        onSuccess: TRANSITION_NEXT,
        onFailure: TRANSITION_NEXT,
      }),
      new CraftStep({
        id: ids.regal,
        name: "富豪尝试补齐两条目标",
        currencyTemplate: "currency_regal",
        expectedRarity: "稀有",
        ruleset: bothSet,
        onSuccess: TRANSITION_FINISH,
        onFailure: TRANSITION_NEXT,
      }),
      new CraftStep({
        id: ids.scour,
        name: "富豪失败后重铸并重来",
        currencyTemplate: "currency_scouring",
        expectedRarity: "普通",
        onSuccess: `${TRANSITION_GOTO_PREFIX}${ids.transmute}`,
        onFailure: TRANSITION_REPEAT,
      }),
    ],
  });
}

export function defaultWorkflow(): CraftWorkflow {
  return rareTwoPrefixWorkflow(
    "helmet-ele-life",
    "头盔·元素+生命",
    "原示例。蜕变/改造/增幅/富豪做 T1 元素伤害 + T1 生命稀有底。",
    "其他",
    genericEleRule(),
    lifeRule(),
    {
      transmute: "transmute",
      alteration: "alteration_t1_elemental",
      augment: "augment_missing_target",
      regal: "regal_t1_life",
      scour: "scour_restart",
    },
  );
}

export function beltRecombinatorWorkflows(): CraftWorkflow[] {
  const group = "腰带重组";
  return [
    magicTwoModWorkflow(
      "belt-life-fireres",
      "蓝装·生命+抗性",
      "重组 A 料。86+ 腰带洗出 T1 生命 + 任意 T1 元素抗性（火/冰/闪可互转）。",
      group,
      lifeRule(),
      anyT1ResGroup(),
    ),
    magicTwoModWorkflow(
      "belt-ele-lightres",
      "蓝装·攻击元素+抗性",
      "重组 B 料。86+ 腰带洗出 T1 攻击元素伤害 + 任意 T1 元素抗性（火/冰/闪可互转）。",
      group,
      eleAttackRule(),
      anyT1ResGroup(),
    ),
    magicOneModWorkflow(
      "belt-life-prefix",
      "补前缀·生命",
      "缺生命时用。洗出带 T1 生命的蓝装，两边点神力后再重组，约 1/3 出 2前2后。",
      group,
      lifeRule(),
    ),
    magicOneModWorkflow(
      "belt-ele-prefix",
      "补前缀·攻击元素",
      "缺攻击元素时用。洗出带 T1 攻击元素伤害的蓝装，两边点神力后再重组。",
      group,
      eleAttackRule(),
    ),
    rareTwoPrefixWorkflow(
      "belt-warlord-life",
      "督军·火伤+生命",
      "2前2后之后。督军影响 86+ 腰带洗出 T1 火伤% + T1 生命，再重组第三前缀，约 1/2。",
      group,
      fireDamageRule(),
      lifeRule(),
    ),
    rareTwoPrefixWorkflow(
      "belt-warlord-ele",
      "督军·火伤+攻击元素",
      "2前2后之后。督军影响 86+ 腰带洗出 T1 火伤% + T1 攻击元素，再重组第三前缀。",
      group,
      fireDamageRule(),
      eleAttackRule(),
    ),
  ];
}

export function defaultLibrary(): WorkflowLibrary {
  const workflows = beltRecombinatorWorkflows();
  const helmet = defaultWorkflow();
  helmet.name = "头盔·元素+生命";
  helmet.description = "原示例。蜕变/改造/增幅/富豪做 T1 元素伤害 + T1 生命稀有底。";
  helmet.group = "其他";
  workflows.push(helmet);
  return new WorkflowLibrary({ activeId: workflows[0].id, workflows });
}
