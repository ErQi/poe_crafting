import { beforeEach, describe, expect, it } from "vitest";
import { parseItemText } from "../itemParser";
import {
  formatThresholdText,
  matchRuleset,
  normalizeOperator,
  parseThresholdText,
  splitPatternKeywords,
} from "../matcher";
import { Affix, Item, MatchMode, MatchRule, RuleGroup, RuleSet } from "../models";
import { matchItem, readSample } from "./helpers";

function rule(pattern: string, operator = "", threshold: number | null = null, threshold2: number | null = null) {
  return new MatchRule({ pattern, operator, threshold, threshold2 });
}

describe("阈值比较", () => {
  let item: Item;
  let itemLow: Item;

  beforeEach(() => {
    item = parseItemText(readSample("item_rare_cn.txt"));
    itemLow = parseItemText(readSample("item_magic_cn.txt"));
  });

  it("生命 >= 80：96 命中，70 未命中", () => {
    const rules = [rule("最大生命", ">=", 80)];
    expect(matchItem(item, rules).success).toBe(true);
    expect(matchItem(itemLow, rules).success).toBe(false);
  });

  it("ANY：一条达标即成功", () => {
    const r = matchItem(item, [rule("最大生命", ">=", 200), rule("闪电抗性", ">=", 20)], MatchMode.ANY);
    expect(r.success).toBe(true);
  });

  it("ALL：缺一条即失败", () => {
    const r = matchItem(item, [rule("最大生命", ">=", 80), rule("混沌抗性")], MatchMode.ALL);
    expect(r.success).toBe(false);
  });

  it("只有文本没有算子时按包含判定", () => {
    expect(matchItem(item, [rule("全属性")]).success).toBe(true);
    expect(matchItem(item, [rule("混沌抗性")]).success).toBe(false);
  });

  it("找不到关键字时给出可读原因", () => {
    const r = matchItem(item, [rule("混沌抗性")]);
    expect(r.hits[0].matched).toBe(false);
    expect(r.hits[0].reason).toBe("未找到同时包含这些关键字的词缀");
    expect(r.hits[0].matchedAffix).toBeNull();
  });

  it("空 pattern 视为空规则而不是通过", () => {
    const r = matchRuleset(
      item,
      new RuleSet({ groups: [new RuleGroup({ rules: [new MatchRule({ pattern: "   " })] })] }),
    );
    // 空 pattern 的规则会被规则组过滤掉 → 组内没有任何 hit → 整体不成功
    expect(r.success).toBe(false);
    expect(r.hits).toEqual([]);
  });

  it("禁用的规则记为 disabled 且不影响成败", () => {
    const disabled = new MatchRule({ pattern: "混沌抗性", enabled: false });
    const r = matchRuleset(
      item,
      new RuleSet({ groups: [new RuleGroup({ rules: [rule("最大生命", ">=", 80), disabled] })] }),
    );
    expect(r.success).toBe(true);
    expect(r.hits.length).toBe(1);
  });
});

describe("同名词缀取最优值", () => {
  const belt = new Item();
  belt.affixes = [new Affix("+35 最大生命", [35]), new Affix("+130 最大生命", [130])];

  it(">= 报告最高值", () => {
    const hit = matchItem(belt, [rule("最大生命", ">=", 100)]).hits[0];
    expect(hit.matched).toBe(true);
    expect(hit.actualValue).toBe(130);
  });

  it("全部未达标时仍报告最高值作为证据", () => {
    const hit = matchItem(belt, [rule("最大生命", ">=", 200)]).hits[0];
    expect(hit.matched).toBe(false);
    expect(hit.actualValue).toBe(130);
  });

  it("<= 报告最低值", () => {
    const hit = matchItem(belt, [rule("最大生命", "<=", 20)]).hits[0];
    expect(hit.matched).toBe(false);
    expect(hit.actualValue).toBe(35);
  });
});

describe("词缀名称匹配", () => {
  const flask = parseItemText(readSample("item_magic_flask_cn.txt"));

  it("支持只按高级词缀名称匹配", () => {
    const hit = matchItem(flask, [rule("炼金的")]).hits[0];
    expect(hit.matched).toBe(true);
    expect(hit.matchedAffix).toContain("“炼金的”");
  });

  it("名称和效果关键字必须属于同一条词缀，数值取对应效果行", () => {
    const prefix = matchItem(flask, [rule("炼金的 效果提高", ">=", 25)]).hits[0];
    expect(prefix.matched).toBe(true);
    expect(prefix.actualValue).toBe(25);
    expect(prefix.matchedAffix).toBe("“炼金的” 效果提高 25%");

    const suffix = matchItem(flask, [rule("泥藓之 感电", ">=", 52)]).hits[0];
    expect(suffix.matched).toBe(true);
    expect(suffix.actualValue).toBe(52);
    expect(matchItem(flask, [rule("炼金的 感电")]).success).toBe(false);
  });
});

describe("规则组的 ANY / ALL 与 min_matches", () => {
  let item: Item;
  beforeEach(() => {
    item = parseItemText(readSample("item_rare_cn.txt"));
  });

  function ruleset(groupCombine: string, ...groups: RuleGroup[]) {
    return new RuleSet({ groupCombine, groups });
  }

  it("组间 ANY：一组成功即整体成功", () => {
    const rs = ruleset(
      MatchMode.ANY,
      new RuleGroup({ name: "A", combine: MatchMode.ALL, rules: [rule("混沌抗性")] }),
      new RuleGroup({ name: "B", combine: MatchMode.ALL, rules: [rule("最大生命", ">=", 80)] }),
    );
    expect(matchRuleset(item, rs).success).toBe(true);
  });

  it("组间 ALL：一组失败即整体失败", () => {
    const rs = ruleset(
      MatchMode.ALL,
      new RuleGroup({ name: "A", combine: MatchMode.ALL, rules: [rule("最大生命", ">=", 80)] }),
      new RuleGroup({ name: "B", combine: MatchMode.ALL, rules: [rule("混沌抗性")] }),
    );
    expect(matchRuleset(item, rs).success).toBe(false);
  });

  it("组内 ANY：任一条命中即该组成功", () => {
    const rs = ruleset(
      MatchMode.ALL,
      new RuleGroup({
        name: "抗性",
        combine: MatchMode.ANY,
        rules: [rule("混沌抗性"), rule("闪电抗性", ">=", 20)],
      }),
    );
    expect(matchRuleset(item, rs).success).toBe(true);
  });

  it("min_matches=2 命中两条即成功，=3 则失败", () => {
    const group = new RuleGroup({
      name: "抗性",
      combine: MatchMode.ALL,
      minMatches: 2,
      rules: [rule("最大生命", ">=", 80), rule("闪电抗性", ">=", 20), rule("混沌抗性")],
    });
    const rs = ruleset(MatchMode.ALL, group);
    expect(matchRuleset(item, rs).success).toBe(true);
    group.minMatches = 3;
    expect(matchRuleset(item, rs).success).toBe(false);
  });

  it("min_matches 优先于 combine：ALL 组也只要求达到下限", () => {
    const group = new RuleGroup({
      name: "抗性",
      combine: MatchMode.ALL,
      minMatches: 1,
      rules: [rule("最大生命", ">=", 80), rule("混沌抗性"), rule("冰霜抗性")],
    });
    expect(matchRuleset(item, ruleset(MatchMode.ALL, group)).success).toBe(true);
  });

  it("没有启用规则组时不成功", () => {
    expect(matchRuleset(item, new RuleSet({ groups: [] })).success).toBe(false);
    const off = new RuleGroup({ enabled: false, rules: [rule("最大生命", ">=", 80)] });
    expect(matchRuleset(item, ruleset(MatchMode.ALL, off)).success).toBe(false);
  });

  it("整组规则为空时不拖累其他组", () => {
    const rs = ruleset(
      MatchMode.ALL,
      new RuleGroup({ name: "空组", rules: [] }),
      new RuleGroup({ name: "生命", rules: [rule("最大生命", ">=", 80)] }),
    );
    expect(matchRuleset(item, rs).success).toBe(true);
  });
});

describe("parseThresholdText", () => {
  it("单值与区间", () => {
    expect(parseThresholdText("80")).toEqual([80, null]);
    expect(parseThresholdText("6-12")).toEqual([6, 12]);
    expect(parseThresholdText("6 - 12")).toEqual([6, 12]);
    expect(parseThresholdText("6到12")).toEqual([6, 12]);
    expect(parseThresholdText("6至12")).toEqual([6, 12]);
    expect(parseThresholdText("6—12")).toEqual([6, 12]);
    expect(parseThresholdText("0.5")).toEqual([0.5, null]);
    expect(parseThresholdText("-5")).toEqual([-5, null]);
  });

  it("空白与非数字返回 [null, null]", () => {
    expect(parseThresholdText("")).toEqual([null, null]);
    expect(parseThresholdText("   ")).toEqual([null, null]);
    expect(parseThresholdText("abc")).toEqual([null, null]);
    expect(parseThresholdText("12,345")).toEqual([null, null]);
  });

  it("inf / nan 不能变成阈值，否则规则会永真或永假", () => {
    expect(parseThresholdText("inf")).toEqual([null, null]);
    expect(parseThresholdText("nan")).toEqual([null, null]);
  });

  it("formatThresholdText 与 parseThresholdText 对称", () => {
    expect(formatThresholdText(80, null)).toBe("80");
    expect(formatThresholdText(6, 12)).toBe("6-12");
    expect(formatThresholdText(null, null)).toBe("");
    expect(parseThresholdText(formatThresholdText(6, 12))).toEqual([6, 12]);
  });
});

describe("双阈值（附加伤害区间）", () => {
  const item = new Item();
  item.affixes = [new Affix("攻击附加 6 - 12 基础冰霜伤害", [6, 12])];

  it("两端都达标才算命中", () => {
    const ok = matchItem(item, [rule("基础冰霜伤害", ">=", 6, 12)]);
    expect(ok.success).toBe(true);
    expect(ok.hits[0].actualValues).toEqual([6, 12]);

    expect(matchItem(item, [rule("基础冰霜伤害", ">=", 6, 13)]).success).toBe(false);
    expect(matchItem(item, [rule("基础冰霜伤害", ">=", 7, 12)]).success).toBe(false);
  });

  it("只给单阈值时只看第一个数字", () => {
    expect(matchItem(item, [rule("基础冰霜伤害", ">=", 6)]).success).toBe(true);
  });
});

describe("splitPatternKeywords", () => {
  it("按空白与常见分隔符拆成必须同时命中的关键字", () => {
    expect(splitPatternKeywords("最大生命")).toEqual(["最大生命"]);
    expect(splitPatternKeywords("攻击附加 冰霜伤害")).toEqual(["攻击附加", "冰霜伤害"]);
    expect(splitPatternKeywords("攻击附加,冰霜伤害")).toEqual(["攻击附加", "冰霜伤害"]);
    expect(splitPatternKeywords("攻击附加，冰霜伤害")).toEqual(["攻击附加", "冰霜伤害"]);
    expect(splitPatternKeywords("攻击附加;冰霜伤害")).toEqual(["攻击附加", "冰霜伤害"]);
    expect(splitPatternKeywords("攻击附加|冰霜伤害")).toEqual(["攻击附加", "冰霜伤害"]);
    expect(splitPatternKeywords("  最大生命  ")).toEqual(["最大生命"]);
  });

  it("空 pattern 与纯分隔符返回空数组", () => {
    expect(splitPatternKeywords("")).toEqual([]);
    expect(splitPatternKeywords("   ")).toEqual([]);
    expect(splitPatternKeywords(",,,")).toEqual([]);
  });

  it("多关键字必须落在同一条词缀上", () => {
    const item = new Item();
    item.affixes = [
      new Affix("攻击附加 6 - 12 基础冰霜伤害", [6, 12]),
      new Affix("攻击附加 4 - 8 基础火焰伤害", [4, 8]),
    ];
    const hit = matchItem(item, [rule("攻击附加 冰霜伤害", ">=", 6, 12)]);
    expect(hit.success).toBe(true);
    expect(hit.hits[0].matchedAffix).toBe("攻击附加 6 - 12 基础冰霜伤害");

    // 「攻击附加」和「闪电伤害」分别存在于不同词缀里也不算命中
    expect(matchItem(item, [rule("攻击附加 闪电伤害")]).success).toBe(false);
  });
});

describe("泛匹配「元素伤害提高」不吃攻击技能子串", () => {
  it("不命中攻击技能那条，仍命中无限定的元素伤害", () => {
    const attack = new Item();
    attack.affixes = [new Affix("攻击技能的元素伤害提高 19%", [19])];
    expect(matchItem(attack, [rule("元素伤害提高", ">=", 19)]).success).toBe(false);

    const generic = new Item();
    generic.affixes = [new Affix("元素伤害提高 19%", [19])];
    expect(matchItem(generic, [rule("元素伤害提高", ">=", 19)]).success).toBe(true);
  });

  it("完整关键字「攻击技能的元素伤害提高」仍命中攻击那条", () => {
    const attack = new Item();
    attack.affixes = [new Affix("攻击技能的元素伤害提高 43%", [43])];
    expect(matchItem(attack, [rule("攻击技能的元素伤害提高", ">=", 43)]).success).toBe(true);
    expect(matchItem(attack, [rule("元素伤害提高", ">=", 19)]).success).toBe(false);
  });
});

describe("normalizeOperator", () => {
  it("全角与别名归一到半角", () => {
    expect(normalizeOperator("≥")).toBe(">=");
    expect(normalizeOperator("≤")).toBe("<=");
    expect(normalizeOperator("＞")).toBe(">");
    expect(normalizeOperator("＜")).toBe("<");
    expect(normalizeOperator("==")).toBe("=");
    expect(normalizeOperator("＝")).toBe("=");
    expect(normalizeOperator("无")).toBe("");
    expect(normalizeOperator("none")).toBe("");
    expect(normalizeOperator("")).toBe("");
  });

  it("全角算子在实际匹配时也生效", () => {
    const item = new Item();
    item.affixes = [new Affix("+96 最大生命", [96])];
    expect(matchItem(item, [rule("最大生命", "≥", 80)]).success).toBe(true);
    expect(matchItem(item, [rule("最大生命", "≤", 80)]).success).toBe(false);
  });
});

describe("RuleSet.fromDict 兼容旧 rules.json", () => {
  it("旧的 match_mode + rules 结构折叠成单个规则组", () => {
    const rs = RuleSet.fromDict({
      match_mode: "any",
      rules: [{ pattern: "最大生命", operator: ">=", threshold: 80 }],
    });
    expect(rs.groups.length).toBe(1);
    expect(rs.groups[0].combine).toBe(MatchMode.ANY);
    expect(rs.groupCombine).toBe(MatchMode.ALL);

    const item = parseItemText(readSample("item_rare_cn.txt"));
    expect(matchRuleset(item, rs).success).toBe(true);
  });
});
