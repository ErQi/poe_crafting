import { beforeEach, describe, expect, it } from "vitest";
import { parseItemText } from "../itemParser";
import { CraftStep, CraftWorkflow, MatchMode, MatchRule, RuleGroup, RuleSet } from "../models";
import {
  beltRecombinatorWorkflows,
  defaultLibrary,
  defaultWorkflow,
  evaluateStep,
  evaluateStepPrecondition,
  firstEnabledStep,
  hasStepPreconditions,
  resolveTransition,
  ROUTE_FINISH,
  ROUTE_STEP,
  ROUTE_STOP,
  TRANSITION_FINISH,
  TRANSITION_GOTO_PREFIX,
  TRANSITION_NEXT,
  TRANSITION_REPEAT,
  TRANSITION_STOP,
  validateWorkflow,
} from "../workflow";
import { itemText } from "./helpers";

function step(init: Partial<CraftStep> = {}): CraftStep {
  return new CraftStep({
    currencyTemplate: "currency_alteration",
    expectedRarity: "魔法",
    onSuccess: TRANSITION_FINISH,
    onFailure: TRANSITION_REPEAT,
    ...init,
  });
}

describe("validateWorkflow", () => {
  it("内置流程全部合法", () => {
    expect(validateWorkflow(defaultWorkflow())).toEqual([]);
    for (const wf of beltRecombinatorWorkflows()) expect(validateWorkflow(wf)).toEqual([]);
    for (const wf of defaultLibrary().workflows) expect(validateWorkflow(wf)).toEqual([]);
  });

  it("没有启用步骤时报错", () => {
    const wf = new CraftWorkflow({ steps: [step({ id: "a", enabled: false })] });
    expect(validateWorkflow(wf)).toContain("至少需要一个启用步骤");
  });

  it("步骤 ID 重复时报错", () => {
    const wf = new CraftWorkflow({ steps: [step({ id: "dup" }), step({ id: "dup" })] });
    expect(validateWorkflow(wf)).toContain("步骤 ID 重复");
  });

  it("起始步骤不存在或未启用时报错", () => {
    const missing = new CraftWorkflow({ steps: [step({ id: "a" })], startStepId: "ghost" });
    expect(validateWorkflow(missing)).toContain("起始步骤不存在或未启用");

    const disabled = new CraftWorkflow({
      steps: [step({ id: "a", enabled: false }), step({ id: "b" })],
      startStepId: "a",
    });
    expect(validateWorkflow(disabled)).toContain("起始步骤不存在或未启用");
  });

  it("未选通货 / 未内置的通货都报错", () => {
    const empty = new CraftWorkflow({ steps: [step({ id: "a", name: "一", currencyTemplate: "" })] });
    expect(validateWorkflow(empty).join()).toMatch(/未选择使用通货/);

    const unknown = new CraftWorkflow({ steps: [step({ id: "a", name: "一", currencyTemplate: "currency_nope" })] });
    expect(validateWorkflow(unknown).join()).toMatch(/选择了未内置的通货/);
  });

  it("没有仓库格的内置通货报错", () => {
    for (const currency of ["currency_divine", "currency_vaal", "currency_mirror"]) {
      const wf = new CraftWorkflow({ steps: [step({ id: "a", name: "一", currencyTemplate: currency })] });
      expect(validateWorkflow(wf).join()).toMatch(/选择了没有仓库格的通货/);
    }
  });

  it("禁用的步骤不检查通货", () => {
    const wf = new CraftWorkflow({
      steps: [step({ id: "a", currencyTemplate: "currency_nope", enabled: false }), step({ id: "b" })],
    });
    expect(validateWorkflow(wf).join()).not.toMatch(/通货/);
  });

  it("期望稀有度只能是空 / 普通 / 魔法 / 稀有", () => {
    for (const rarity of ["", "普通", "魔法", "稀有"]) {
      const wf = new CraftWorkflow({ steps: [step({ id: "a", expectedRarity: rarity })] });
      expect(validateWorkflow(wf).join()).not.toMatch(/期望稀有度无效/);
    }
    const bad = new CraftWorkflow({ steps: [step({ id: "a", name: "一", expectedRarity: "传奇" })] });
    expect(validateWorkflow(bad).join()).toMatch(/期望稀有度无效: 传奇/);

    const badBefore = new CraftWorkflow({ steps: [step({ id: "a", name: "一", beforeRarity: "传奇" })] });
    expect(validateWorkflow(badBefore).join()).toMatch(/动作前稀有度无效: 传奇/);
  });

  it("动作前后显式词缀数只能是不校验或 0–6 的整数", () => {
    for (const count of [null, 0, 1, 2, 3, 4, 5, 6]) {
      const before = new CraftWorkflow({ steps: [step({ id: "a", beforeAffixCount: count })] });
      const after = new CraftWorkflow({ steps: [step({ id: "a", expectedAffixCount: count })] });
      expect(validateWorkflow(before).join()).not.toMatch(/动作前显式词缀数无效/);
      expect(validateWorkflow(after).join()).not.toMatch(/动作后显式词缀数无效/);
    }
    for (const count of [-1, 1.5, 7]) {
      const before = new CraftWorkflow({ steps: [step({ id: "a", name: "一", beforeAffixCount: count })] });
      const after = new CraftWorkflow({ steps: [step({ id: "a", name: "一", expectedAffixCount: count })] });
      expect(validateWorkflow(before).join()).toMatch(/动作前显式词缀数无效/);
      expect(validateWorkflow(after).join()).toMatch(/动作后显式词缀数无效/);
    }
  });

  it("分支去向必须是内置动作或指向已启用步骤", () => {
    const unknown = new CraftWorkflow({ steps: [step({ id: "a", name: "一", onSuccess: "teleport" })] });
    expect(validateWorkflow(unknown).join()).toMatch(/命中去向无效: teleport/);

    const blank = new CraftWorkflow({ steps: [step({ id: "a", name: "一", onFailure: "  " })] });
    expect(validateWorkflow(blank).join()).toMatch(/未命中去向无效: \(空\)/);

    const dangling = new CraftWorkflow({
      steps: [step({ id: "a", name: "一", onSuccess: `${TRANSITION_GOTO_PREFIX}ghost` })],
    });
    expect(validateWorkflow(dangling).join()).toMatch(/命中去向无效/);

    const toDisabled = new CraftWorkflow({
      steps: [step({ id: "a", name: "一", onSuccess: `${TRANSITION_GOTO_PREFIX}b` }), step({ id: "b", enabled: false })],
    });
    expect(validateWorkflow(toDisabled).join()).toMatch(/命中去向无效/);

    const ok = new CraftWorkflow({
      steps: [step({ id: "a", onSuccess: `${TRANSITION_GOTO_PREFIX}b` }), step({ id: "b" })],
    });
    expect(validateWorkflow(ok)).toEqual([]);
  });

  it("所有内置去向动作都合法", () => {
    for (const t of [TRANSITION_NEXT, TRANSITION_REPEAT, TRANSITION_FINISH, TRANSITION_STOP]) {
      const wf = new CraftWorkflow({ steps: [step({ id: "a", onSuccess: t, onFailure: t })] });
      expect(validateWorkflow(wf)).toEqual([]);
    }
  });
});

describe("resolveTransition", () => {
  const wf = new CraftWorkflow({
    steps: [step({ id: "s1" }), step({ id: "s2", enabled: false }), step({ id: "s3" })],
  });

  it("finish / stop / repeat", () => {
    expect(resolveTransition(wf, "s1", TRANSITION_FINISH)).toEqual({ kind: ROUTE_FINISH, nextStepId: "" });
    expect(resolveTransition(wf, "s1", TRANSITION_STOP)).toEqual({ kind: ROUTE_STOP, nextStepId: "" });
    expect(resolveTransition(wf, "s1", TRANSITION_REPEAT)).toEqual({ kind: ROUTE_STEP, nextStepId: "s1" });
  });

  it("空去向按 stop 处理", () => {
    expect(resolveTransition(wf, "s1", "").kind).toBe(ROUTE_STOP);
  });

  it("next 跳过被禁用的步骤", () => {
    expect(resolveTransition(wf, "s1", TRANSITION_NEXT)).toEqual({ kind: ROUTE_STEP, nextStepId: "s3" });
  });

  it("next 走到末尾等于完成", () => {
    expect(resolveTransition(wf, "s3", TRANSITION_NEXT).kind).toBe(ROUTE_FINISH);
  });

  it("goto 指向已启用步骤", () => {
    expect(resolveTransition(wf, "s1", `${TRANSITION_GOTO_PREFIX}s3`)).toEqual({
      kind: ROUTE_STEP,
      nextStepId: "s3",
    });
  });

  it("goto 指向不存在或已禁用的步骤时抛错", () => {
    expect(() => resolveTransition(wf, "s1", `${TRANSITION_GOTO_PREFIX}ghost`)).toThrow(/无效或不可用的步骤去向/);
    expect(() => resolveTransition(wf, "s1", `${TRANSITION_GOTO_PREFIX}s2`)).toThrow(/无效或不可用的步骤去向/);
  });

  it("未知去向抛错", () => {
    expect(() => resolveTransition(wf, "s1", "teleport")).toThrow(/无效或不可用的步骤去向/);
  });
});

describe("firstEnabledStep", () => {
  it("优先用 startStepId", () => {
    const wf = new CraftWorkflow({ steps: [step({ id: "a" }), step({ id: "b" })], startStepId: "b" });
    expect(firstEnabledStep(wf)?.id).toBe("b");
  });

  it("startStepId 指向禁用步骤时退回第一个启用步骤", () => {
    const wf = new CraftWorkflow({
      steps: [step({ id: "a", enabled: false }), step({ id: "b" })],
      startStepId: "a",
    });
    expect(firstEnabledStep(wf)?.id).toBe("b");
  });

  it("全禁用时返回 undefined", () => {
    const wf = new CraftWorkflow({ steps: [step({ id: "a", enabled: false })] });
    expect(firstEnabledStep(wf)).toBeUndefined();
  });
});

describe("evaluateStep", () => {
  it("稀有度与词缀都满足才算命中", () => {
    const s = step({
      expectedRarity: "稀有",
      ruleset: new RuleSet({
        groups: [new RuleGroup({ rules: [new MatchRule({ pattern: "最大生命", operator: ">=", threshold: 130 })] })],
      }),
    });
    const ok = evaluateStep(parseItemText(itemText("稀有", "+130 最大生命")), s);
    expect(ok).toMatchObject({ success: true, rarityMatched: true, rulesMatched: true });
  });

  it("词缀达标但稀有度不符时单独暴露原因", () => {
    const s = step({
      expectedRarity: "稀有",
      ruleset: new RuleSet({
        groups: [new RuleGroup({ rules: [new MatchRule({ pattern: "最大生命", operator: ">=", threshold: 130 })] })],
      }),
    });
    const r = evaluateStep(parseItemText(itemText("魔法", "+130 最大生命")), s);
    expect(r.success).toBe(false);
    expect(r.rarityMatched).toBe(false);
    expect(r.rulesMatched).toBe(true);
    expect(r.summary).toMatch(/稀有度=稀有/);
  });

  it("没有期望稀有度时任何稀有度都放行", () => {
    const s = step({ expectedRarity: "", ruleset: new RuleSet({ groups: [] }) });
    expect(evaluateStep(parseItemText(itemText("普通")), s).rarityMatched).toBe(true);
  });

  it("显式词缀数量与稀有度、词缀规则同时参与命中判定", () => {
    const s = step({
      expectedAffixCount: 1,
      ruleset: new RuleSet({
        groups: [new RuleGroup({ rules: [new MatchRule({ pattern: "最大生命", operator: ">=", threshold: 100 })] })],
      }),
    });
    const one = evaluateStep(parseItemText(itemText("魔法", "+110 最大生命")), s);
    const two = evaluateStep(parseItemText(itemText("魔法", "+110 最大生命", "+52 智慧")), s);
    expect(one).toMatchObject({ success: true, affixCountMatched: true, rulesMatched: true });
    expect(two).toMatchObject({ success: false, affixCountMatched: false, rulesMatched: true });
    expect(two.summary).toMatch(/✗显式词缀数=1（实际=2）/);
  });

  it("只配置显式词缀数量时不显示无条件", () => {
    const s = step({ expectedRarity: "", expectedAffixCount: 0, ruleset: new RuleSet({ groups: [] }) });
    const result = evaluateStep(parseItemText(itemText("普通")), s);
    expect(result.success).toBe(true);
    expect(result.summary).toBe("✓显式词缀数=0（实际=0）");
  });

  it("没有启用规则时只看稀有度，摘要写「无条件」", () => {
    const s = step({ expectedRarity: "", ruleset: new RuleSet({ groups: [] }) });
    const r = evaluateStep(parseItemText(itemText("普通")), s);
    expect(r).toMatchObject({ success: true, rulesMatched: true });
    expect(r.summary).toBe("无条件");
  });

  it("match.success 会被稀有度结果改写，界面不会显示自相矛盾的结论", () => {
    const s = step({
      expectedRarity: "稀有",
      ruleset: new RuleSet({
        groups: [new RuleGroup({ rules: [new MatchRule({ pattern: "最大生命", operator: ">=", threshold: 130 })] })],
      }),
    });
    const r = evaluateStep(parseItemText(itemText("魔法", "+130 最大生命")), s);
    expect(r.match.success).toBe(false);
  });
});

describe("evaluateStepPrecondition", () => {
  it("未配置动作前条件时不因通货种类自动跳过", () => {
    const augment = step({ currencyTemplate: "currency_augmentation", beforeAffixCount: null });
    const twoMods = parseItemText(itemText("魔法", "+110 最大生命", "+52 智慧"));
    expect(hasStepPreconditions(augment)).toBe(false);
    expect(evaluateStepPrecondition(twoMods, augment)).toMatchObject({ success: true, affixCountMatched: true });
  });

  it("配置为 1 时只放行恰好一条显式词缀", () => {
    const configured = step({ beforeAffixCount: 1 });
    const oneMod = evaluateStepPrecondition(parseItemText(itemText("魔法", "+110 最大生命")), configured);
    const twoMods = evaluateStepPrecondition(
      parseItemText(itemText("魔法", "+110 最大生命", "+52 智慧")),
      configured,
    );
    expect(oneMod.success).toBe(true);
    expect(twoMods.success).toBe(false);
    expect(twoMods.summary).toBe("✗动作前显式词缀数=1（实际=2）");
  });

  it("动作前条件按显式词缀计数，不把固有词缀算进去", () => {
    const configured = step({ beforeAffixCount: 1 });
    const withImplicit = parseItemText(
      [
        "物品类别: 头部",
        "稀有度: 魔法",
        "测试头盔",
        "威武皮盔",
        "--------",
        "物品等级: 84",
        "--------",
        "+20 最大生命 (implicit)",
        "--------",
        "元素伤害提高 19%",
        "--------",
        "已鉴定",
      ].join("\n"),
    );
    expect(withImplicit.affixes.length).toBe(2);
    expect(withImplicit.craftAffixCount).toBe(1);
    expect(evaluateStepPrecondition(withImplicit, configured).success).toBe(true);
  });

  it("前置稀有度、词缀数量和具体词缀数值必须同时满足", () => {
    const configured = step({
      beforeRarity: "魔法",
      beforeAffixCount: 1,
      beforeRuleset: new RuleSet({
        groups: [
          new RuleGroup({
            rules: [new MatchRule({ pattern: "最大生命", operator: ">=", threshold: 100 })],
          }),
        ],
      }),
    });
    expect(hasStepPreconditions(configured)).toBe(true);
    const matched = evaluateStepPrecondition(parseItemText(itemText("魔法", "+110 最大生命")), configured);
    const lowValue = evaluateStepPrecondition(parseItemText(itemText("魔法", "+99 最大生命")), configured);
    const wrongAffix = evaluateStepPrecondition(parseItemText(itemText("魔法", "+52 智慧")), configured);
    const wrongRarity = evaluateStepPrecondition(parseItemText(itemText("稀有", "+110 最大生命")), configured);

    expect(matched).toMatchObject({ success: true, rarityMatched: true, affixCountMatched: true, rulesMatched: true });
    expect(lowValue).toMatchObject({ success: false, rulesMatched: false });
    expect(wrongAffix).toMatchObject({ success: false, rulesMatched: false });
    expect(wrongRarity).toMatchObject({ success: false, rarityMatched: false, rulesMatched: true });
    expect(lowValue.summary).toMatch(/实际=99/);
  });

  it("增幅前置规则可按组间 OR 放行任一达标目标词", () => {
    const configured = step({
      beforeAffixCount: 1,
      beforeRuleset: new RuleSet({
        groupCombine: MatchMode.ANY,
        groups: [
          new RuleGroup({
            name: "目标前缀",
            combine: MatchMode.ANY,
            rules: [new MatchRule({ pattern: "最大生命", operator: ">=", threshold: 100 })],
          }),
          new RuleGroup({
            name: "目标后缀",
            combine: MatchMode.ANY,
            rules: [new MatchRule({ pattern: "智慧", operator: ">=", threshold: 51 })],
          }),
        ],
      }),
    });

    expect(evaluateStepPrecondition(parseItemText(itemText("魔法", "+110 最大生命")), configured).success).toBe(true);
    expect(evaluateStepPrecondition(parseItemText(itemText("魔法", "+52 智慧")), configured).success).toBe(true);
    expect(evaluateStepPrecondition(parseItemText(itemText("魔法", "+99 最大生命")), configured).success).toBe(false);
    expect(evaluateStepPrecondition(parseItemText(itemText("魔法", "+52 敏捷")), configured).success).toBe(false);
  });
});

describe("内置示例流程「头盔·元素+生命」", () => {
  let wf: CraftWorkflow;
  beforeEach(() => {
    wf = defaultWorkflow();
  });

  it("步骤 ID 稳定，to/fromDict 往返一致", () => {
    expect(wf.steps.map((s) => s.id)).toEqual([
      "transmute",
      "alteration_t1_elemental",
      "augment_missing_target",
      "regal_t1_life",
      "scour_restart",
    ]);
    expect(CraftWorkflow.fromDict(wf.toDict()).toDict()).toEqual(wf.toDict());
  });

  it("改造步骤保留 T1 元素或 T1 生命任一条", () => {
    const s = wf.getStep("alteration_t1_elemental")!;
    expect(evaluateStep(parseItemText(itemText("魔法", "元素伤害提高 18%")), s).success).toBe(false);
    expect(evaluateStep(parseItemText(itemText("魔法", "元素伤害提高 19%")), s).success).toBe(true);
    expect(evaluateStep(parseItemText(itemText("魔法", "攻击技能的元素伤害提高 19%")), s).success).toBe(false);
    expect(evaluateStep(parseItemText(itemText("魔法", "+129 最大生命")), s).success).toBe(false);
    expect(evaluateStep(parseItemText(itemText("魔法", "+130 最大生命")), s).success).toBe(true);
  });

  it("蜕变先判 roll 再决定去向", () => {
    const s = wf.getStep("transmute")!;
    expect(evaluateStep(parseItemText(itemText("魔法", "元素伤害提高 18%")), s).success).toBe(false);
    expect(evaluateStep(parseItemText(itemText("魔法", "元素伤害提高 19%")), s).success).toBe(true);
    expect(resolveTransition(wf, s.id, s.onFailure).nextStepId).toBe("alteration_t1_elemental");
    expect(resolveTransition(wf, s.id, s.onSuccess).nextStepId).toBe("augment_missing_target");
  });

  it("增幅检查两个目标，命中与否都进富豪", () => {
    const s = wf.getStep("augment_missing_target")!;
    expect(evaluateStepPrecondition(parseItemText(itemText("魔法", "+130 最大生命")), s).success).toBe(true);
    expect(evaluateStepPrecondition(parseItemText(itemText("魔法", "+52 智慧")), s).success).toBe(false);
    expect(evaluateStep(parseItemText(itemText("魔法", "+130 最大生命")), s).success).toBe(false);
    expect(evaluateStep(parseItemText(itemText("魔法", "+130 最大生命", "元素伤害提高 19%")), s).success).toBe(true);
    expect(resolveTransition(wf, s.id, s.onFailure).nextStepId).toBe("regal_t1_life");
    expect(resolveTransition(wf, s.id, s.onSuccess).nextStepId).toBe("regal_t1_life");
  });

  it("富豪要求同时具备元素与 T1 生命", () => {
    const s = wf.getStep("regal_t1_life")!;
    expect(evaluateStep(parseItemText(itemText("稀有", "元素伤害提高 22%", "+48% 火焰抗性")), s).success).toBe(false);
    expect(evaluateStep(parseItemText(itemText("稀有", "元素伤害提高 19%", "+130 最大生命")), s).success).toBe(true);
  });

  it("富豪也要求稀有度为稀有", () => {
    const s = wf.getStep("regal_t1_life")!;
    const r = evaluateStep(parseItemText(itemText("魔法", "元素伤害提高 19%", "+130 最大生命")), s);
    expect(r.success).toBe(false);
    expect(r.rarityMatched).toBe(false);
    expect(r.rulesMatched).toBe(true);
  });

  it("富豪命中即完成，失败去重铸，重铸后回到蜕变", () => {
    const regal = wf.getStep("regal_t1_life")!;
    const scour = wf.getStep("scour_restart")!;
    expect(resolveTransition(wf, regal.id, regal.onSuccess).kind).toBe(ROUTE_FINISH);

    const failure = resolveTransition(wf, regal.id, regal.onFailure);
    expect(failure.kind).toBe(ROUTE_STEP);
    expect(failure.nextStepId).toBe(scour.id);

    const restart = resolveTransition(wf, scour.id, scour.onSuccess);
    expect(restart.kind).toBe(ROUTE_STEP);
    expect(restart.nextStepId).toBe("transmute");
  });

  it("禁用增幅后改造直接跳到富豪", () => {
    const alteration = wf.getStep("alteration_t1_elemental")!;
    wf.getStep("augment_missing_target")!.enabled = false;
    expect(resolveTransition(wf, alteration.id, alteration.onSuccess).nextStepId).toBe("regal_t1_life");
  });
});

describe("内置流程库", () => {
  it("流程 id 与名称都不重复", () => {
    const lib = defaultLibrary();
    const ids = lib.workflows.map((w) => w.id);
    const names = lib.workflows.map((w) => w.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    expect(lib.activeId).toBe(lib.workflows[0].id);
  });

  it("每条流程的步骤 id 在流程内唯一", () => {
    for (const wf of defaultLibrary().workflows) {
      const ids = wf.steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("腰带重组流程都以蜕变起手且起始步骤有效", () => {
    for (const wf of beltRecombinatorWorkflows()) {
      const start = firstEnabledStep(wf)!;
      expect(start.id).toBe(wf.startStepId);
      expect(start.currencyTemplate).toBe("currency_transmutation");
    }
  });

  it("「任意 T1 元素抗性」组是 ANY，火/冰/闪可互转", () => {
    const wf = beltRecombinatorWorkflows().find((w) => w.id === "belt-life-fireres")!;
    const s = wf.getStep("belt-life-fireres__alteration")!;
    // 目标 B = 抗性组，任一条抗性达 T1 都算
    for (const res of ["+46% 火焰抗性", "+46% 冰霜抗性", "+46% 闪电抗性"]) {
      expect(evaluateStep(parseItemText(itemText("魔法", res)), s).success).toBe(true);
    }
    expect(evaluateStep(parseItemText(itemText("魔法", "+45% 火焰抗性")), s).success).toBe(false);
  });

  it("蓝装两词缀流程的增幅步骤要求两个目标同时具备", () => {
    const wf = beltRecombinatorWorkflows().find((w) => w.id === "belt-life-fireres")!;
    const augment = wf.getStep("belt-life-fireres__augment")!;
    expect(augment.beforeAffixCount).toBe(1);
    expect(augment.expectedAffixCount).toBe(2);
    expect(evaluateStepPrecondition(parseItemText(itemText("魔法", "+130 最大生命")), augment).success).toBe(true);
    expect(evaluateStepPrecondition(parseItemText(itemText("魔法", "+52 智慧")), augment).success).toBe(false);
    expect(evaluateStep(parseItemText(itemText("魔法", "+130 最大生命")), augment).success).toBe(false);
    expect(
      evaluateStep(parseItemText(itemText("魔法", "+130 最大生命", "+46% 冰霜抗性")), augment).success,
    ).toBe(true);
    // 未命中时回到改造重洗
    expect(resolveTransition(wf, augment.id, augment.onFailure).nextStepId).toBe("belt-life-fireres__alteration");
    expect(resolveTransition(wf, augment.id, augment.onSuccess).kind).toBe(ROUTE_FINISH);
  });

  it("每条流程从起点出发都能走到 finish", () => {
    for (const wf of defaultLibrary().workflows) {
      const seen = new Set<string>();
      let current = firstEnabledStep(wf)!;
      let reachedFinish = false;
      // 沿「命中」分支走，内置流程都应在有限步内完成
      for (let i = 0; i < 20 && !seen.has(current.id); i++) {
        seen.add(current.id);
        const route = resolveTransition(wf, current.id, current.onSuccess);
        if (route.kind === ROUTE_FINISH) {
          reachedFinish = true;
          break;
        }
        expect(route.kind).toBe(ROUTE_STEP);
        current = wf.getStep(route.nextStepId)!;
      }
      expect(reachedFinish, `${wf.name} 的命中分支应能走到完成`).toBe(true);
    }
  });
});

describe("组合规则集在流程里的语义", () => {
  it("组间 ANY 的「任一目标」与组间 ALL 的「两个目标」互不混淆", () => {
    const wf = beltRecombinatorWorkflows().find((w) => w.id === "belt-ele-lightres")!;
    const alteration = wf.getStep("belt-ele-lightres__alteration")!;
    const augment = wf.getStep("belt-ele-lightres__augment")!;
    const oneTarget = parseItemText(itemText("魔法", "攻击技能的元素伤害提高 43%"));
    expect(evaluateStep(oneTarget, alteration).success).toBe(true);
    expect(evaluateStep(oneTarget, augment).success).toBe(false);
  });

  it("单词缀流程只有一个目标前缀", () => {
    const wf = beltRecombinatorWorkflows().find((w) => w.id === "belt-life-prefix")!;
    const s = wf.getStep("belt-life-prefix__alteration")!;
    expect(evaluateStep(parseItemText(itemText("魔法", "+130 最大生命")), s).success).toBe(true);
    expect(evaluateStep(parseItemText(itemText("魔法", "+129 最大生命")), s).success).toBe(false);
    expect(s.ruleset.groupCombine).toBe(MatchMode.ALL);
  });
});
