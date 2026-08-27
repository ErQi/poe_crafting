import { describe, expect, it } from "vitest";
import {
  Affix,
  AppSettings,
  applyNumericSettings,
  clampSetting,
  CraftStep,
  CraftWorkflow,
  Item,
  MatchMode,
  MatchRule,
  RuleGroup,
  RuleSet,
  WorkflowLibrary,
} from "../models";

describe("clampSetting", () => {
  it("整型字段解析失败时返回 null，由调用方保留默认值", () => {
    expect(clampSetting("maxAttempts", "abc")).toBeNull();
    expect(clampSetting("actionDelayMs", "abc")).toBeNull();
    expect(clampSetting("maxAttempts", undefined)).toBeNull();
  });

  it("浮点字段解析失败时也返回 null", () => {
    // Number("abc") 是 NaN，绝不能落进配置
    expect(clampSetting("templateThreshold", "abc")).toBeNull();
    expect(clampSetting("templateThreshold", NaN)).toBeNull();
  });

  it("空字符串与 null 不能被当成 0", () => {
    // Number("") 和 Number(null) 都是 0，templateThreshold=0 意味着「什么都匹配」
    expect(clampSetting("templateThreshold", "")).toBeNull();
    expect(clampSetting("templateThreshold", null)).toBeNull();
    expect(clampSetting("maxAttempts", "")).toBeNull();
    expect(clampSetting("maxAttempts", null)).toBeNull();
  });

  it("templateThreshold clamp 到 [0, 1]", () => {
    expect(clampSetting("templateThreshold", 0.82)).toBe(0.82);
    expect(clampSetting("templateThreshold", "0.9")).toBe(0.9);
    expect(clampSetting("templateThreshold", 5)).toBe(1);
    expect(clampSetting("templateThreshold", -3)).toBe(0);
    expect(clampSetting("templateThreshold", 0)).toBe(0);
    expect(clampSetting("templateThreshold", 1)).toBe(1);
  });

  it("其余数值字段按各自区间 clamp", () => {
    expect(clampSetting("maxAttempts", 0)).toBe(1);
    expect(clampSetting("maxAttempts", 999999)).toBe(100000);
    expect(clampSetting("actionDelayMs", -10)).toBe(0);
    expect(clampSetting("actionDelayMs", 999999)).toBe(60000);
    expect(clampSetting("clipboardTimeoutMs", 10)).toBe(100);
    expect(clampSetting("clipboardPollMs", 0)).toBe(1);
    expect(clampSetting("maxUnchanged", 8)).toBe(8);
  });

  it("整型字段截断小数", () => {
    expect(clampSetting("actionDelayMs", "350.7")).toBe(350);
    expect(clampSetting("maxAttempts", 12.9)).toBe(12);
  });
});

describe("applyNumericSettings", () => {
  it("不可解析的值不会覆盖默认值", () => {
    const s = new AppSettings();
    applyNumericSettings(s, { max_attempts: "abc", template_threshold: "" });
    expect(s.maxAttempts).toBe(200);
    expect(s.templateThreshold).toBe(0.82);
  });

  it("越界的值写入 clamp 后的结果", () => {
    const s = new AppSettings();
    applyNumericSettings(s, { max_attempts: 999999, template_threshold: 3 });
    expect(s.maxAttempts).toBe(100000);
    expect(s.templateThreshold).toBe(1);
  });

  it("data 里没出现的字段保持原值", () => {
    const s = new AppSettings();
    s.maxAttempts = 42;
    applyNumericSettings(s, { action_delay_ms: 10 });
    expect(s.maxAttempts).toBe(42);
    expect(s.actionDelayMs).toBe(10);
  });
});

describe("AppSettings 序列化", () => {
  it("toDict / fromDict 往返一致", () => {
    const s = new AppSettings();
    s.maxAttempts = 50;
    s.templateThreshold = 0.9;
    s.hotkeyStart = "f9";
    expect(AppSettings.fromDict(s.toDict()).toDict()).toEqual(s.toDict());
  });

  it("fromDict 忽略未知字段并保留默认值", () => {
    const s = AppSettings.fromDict({ unknown_key: 1 });
    expect(s.maxAttempts).toBe(200);
    expect(s.windowTitleKeywords).toEqual(["Path of Exile", "流放之路"]);
  });

  it("window_title_keywords 必须是数组才生效", () => {
    expect(AppSettings.fromDict({ window_title_keywords: "PoE" }).windowTitleKeywords).toEqual([
      "Path of Exile",
      "流放之路",
    ]);
    expect(AppSettings.fromDict({ window_title_keywords: ["PoE", 1] }).windowTitleKeywords).toEqual(["PoE", "1"]);
  });
});

describe("MatchRule.fromDict", () => {
  it("阈值的空值一律变成 null", () => {
    expect(MatchRule.fromDict({ pattern: "生命", threshold: "" }).threshold).toBeNull();
    expect(MatchRule.fromDict({ pattern: "生命", threshold: null }).threshold).toBeNull();
    expect(MatchRule.fromDict({ pattern: "生命", threshold: "abc" }).threshold).toBeNull();
    expect(MatchRule.fromDict({ pattern: "生命", threshold: "12" }).threshold).toBe(12);
    expect(MatchRule.fromDict({ pattern: "生命", threshold2: "12.5" }).threshold2).toBe(12.5);
  });

  it("缺 id 时自动补一个", () => {
    expect(MatchRule.fromDict({ pattern: "生命" }).id).toBeTruthy();
  });
});

describe("RuleGroup.fromDict 防御性", () => {
  it("rules 不是数组时退化成空数组", () => {
    expect(RuleGroup.fromDict({ rules: "nope" }).rules).toEqual([]);
    expect(RuleGroup.fromDict({}).rules).toEqual([]);
  });

  it("过滤掉非对象的规则项", () => {
    const g = RuleGroup.fromDict({ rules: [null, 1, "x", { pattern: "生命" }] });
    expect(g.rules.length).toBe(1);
    expect(g.rules[0].pattern).toBe("生命");
  });

  it("非法 combine 回落到 all", () => {
    expect(RuleGroup.fromDict({ combine: "xor" }).combine).toBe(MatchMode.ALL);
    expect(RuleGroup.fromDict({ combine: "any" }).combine).toBe(MatchMode.ANY);
    expect(RuleGroup.fromDict({ match_mode: "any" }).combine).toBe(MatchMode.ANY);
  });

  it("min_matches 小于 1 视为未设置", () => {
    expect(RuleGroup.fromDict({ min_matches: 0 }).minMatches).toBeNull();
    expect(RuleGroup.fromDict({ min_matches: -1 }).minMatches).toBeNull();
    expect(RuleGroup.fromDict({ min_matches: 2 }).minMatches).toBe(2);
  });
});

describe("RuleSet.fromDict 防御性", () => {
  it("非对象输入返回默认规则集", () => {
    expect(RuleSet.fromDict(null).groups).toEqual([]);
    expect(RuleSet.fromDict("x").groups).toEqual([]);
  });

  it("groups 为空数组时补一个空组，界面不至于无处下手", () => {
    const rs = RuleSet.fromDict({ groups: [] });
    expect(rs.groups.length).toBe(1);
  });

  it("非法 group_combine 回落到 all", () => {
    expect(RuleSet.fromDict({ groups: [{}], group_combine: "xor" }).groupCombine).toBe(MatchMode.ALL);
  });
});

describe("CraftWorkflow.fromDict 防御性", () => {
  it("steps 不是数组时退化成空数组", () => {
    expect(CraftWorkflow.fromDict({ steps: "nope" }).steps).toEqual([]);
    expect(CraftWorkflow.fromDict(null).steps).toEqual([]);
  });

  it("过滤掉非对象的步骤项", () => {
    const wf = CraftWorkflow.fromDict({ steps: [null, 3, { id: "a", name: "一" }] });
    expect(wf.steps.length).toBe(1);
    expect(wf.steps[0].id).toBe("a");
  });

  it("start_step_id 指向不存在的步骤时自动清空", () => {
    const wf = CraftWorkflow.fromDict({ steps: [{ id: "a" }], start_step_id: "ghost" });
    expect(wf.startStepId).toBe("");
  });

  it("start_step_id 有效时保留", () => {
    const wf = CraftWorkflow.fromDict({ steps: [{ id: "a" }], start_step_id: "a" });
    expect(wf.startStepId).toBe("a");
  });

  it("旧配置缺少前置判断时保持不校验，新配置可读取完整前置条件", () => {
    const oldStep = CraftWorkflow.fromDict({ steps: [{ id: "a" }] }).steps[0];
    expect(oldStep.beforeRarity).toBe("");
    expect(oldStep.beforeAffixCount).toBeNull();
    expect(oldStep.beforeRuleset.groups).toHaveLength(1);
    expect(oldStep.beforeRuleset.groups[0].rules).toEqual([]);
    expect(oldStep.expectedAffixCount).toBeNull();
    const configured = CraftWorkflow.fromDict({
      steps: [
        {
          id: "a",
          before_rarity: "魔法",
          before_affix_count: "1",
          before_ruleset: {
            groups: [{ rules: [{ pattern: "最大生命", operator: ">=", threshold: 100 }] }],
          },
          expected_affix_count: "2",
        },
      ],
    }).steps[0];
    expect(configured.beforeRarity).toBe("魔法");
    expect(configured.beforeAffixCount).toBe(1);
    expect(configured.beforeRuleset.groups[0].rules[0].threshold).toBe(100);
    expect(configured.expectedAffixCount).toBe(2);
  });

  it("toDict / fromDict 往返一致", () => {
    const wf = new CraftWorkflow({
      id: "wf",
      name: "流程",
      startStepId: "s1",
      steps: [
        new CraftStep({
          id: "s1",
          currencyTemplate: "currency_alteration",
          beforeRarity: "魔法",
          beforeAffixCount: 1,
          beforeRuleset: new RuleSet({
            groups: [new RuleGroup({ rules: [new MatchRule({ pattern: "最大生命", threshold: 100 })] })],
          }),
          expectedRarity: "魔法",
          expectedAffixCount: 1,
        }),
      ],
    });
    expect(CraftWorkflow.fromDict(wf.toDict()).toDict()).toEqual(wf.toDict());
  });
});

describe("WorkflowLibrary.fromDict 防御性", () => {
  it("workflows 不是数组时退化成空", () => {
    expect(WorkflowLibrary.fromDict({ workflows: "nope" }).workflows).toEqual([]);
  });

  it("重复 id 会被重新分配，避免 select/put 打到同一条", () => {
    const lib = WorkflowLibrary.fromDict({
      workflows: [
        { id: "same", name: "A" },
        { id: "same", name: "B" },
      ],
    });
    expect(lib.workflows.length).toBe(2);
    expect(lib.workflows[0].id).not.toBe(lib.workflows[1].id);
  });

  it("active_id 悬空时落到第一条", () => {
    const lib = WorkflowLibrary.fromDict({ workflows: [{ id: "a" }, { id: "b" }], active_id: "ghost" });
    expect(lib.activeId).toBe("a");
  });

  it("空库调用 active() 会补一条空流程", () => {
    const lib = new WorkflowLibrary();
    const wf = lib.active();
    expect(lib.workflows.length).toBe(1);
    expect(lib.activeId).toBe(wf.id);
  });

  it("只剩一条时拒绝删除", () => {
    const lib = WorkflowLibrary.fromDict({ workflows: [{ id: "a" }] });
    expect(lib.remove("a")).toBe(false);
    expect(lib.workflows.length).toBe(1);
  });

  it("删除当前激活项后 activeId 跟着挪", () => {
    const lib = WorkflowLibrary.fromDict({ workflows: [{ id: "a" }, { id: "b" }], active_id: "a" });
    expect(lib.remove("a")).toBe(true);
    expect(lib.activeId).toBe("b");
  });
});

describe("Item / Affix", () => {
  it("firstValue / secondValue", () => {
    expect(new Affix("x", []).firstValue).toBeNull();
    expect(new Affix("x", []).secondValue).toBeNull();
    expect(new Affix("x", [6]).secondValue).toBeNull();
    expect(new Affix("x", [6, 12]).secondValue).toBe(12);
  });

  it("词缀名称参与搜索、展示和变化签名，但不改变原效果文本", () => {
    const affix = new Affix("效果提高 25%", [25], "炼金的");
    const item = new Item();
    item.affixes = [affix];
    expect(affix.searchText).toContain("炼金的");
    expect(affix.displayText).toBe("“炼金的” 效果提高 25%");
    expect(item.affixTexts()).toEqual(["效果提高 25%"]);
    expect(item.affixSignatures()).toEqual(["炼金的\u0000效果提高 25%"]);
  });

  it("explicitModCount 为空时 craftAffixCount 退回词缀行数", () => {
    const item = new Item();
    item.affixes = [new Affix("a", []), new Affix("b", [])];
    expect(item.craftAffixCount).toBe(2);
    item.explicitModCount = 1;
    expect(item.craftAffixCount).toBe(1);
    item.explicitModCount = 0;
    expect(item.craftAffixCount).toBe(0);
  });
});
