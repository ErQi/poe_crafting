import { describe, expect, it } from "vitest";
import {
  extractNumbers,
  isEquipmentClipboardText,
  ItemParseError,
  parseItemText,
} from "../itemParser";
import { readSample } from "./helpers";

const CURRENCY_TOOLTIP = "物品类别: 可堆叠通货\n稀有度: 通货\n改造石\n--------\n堆叠数量: 27/40";

describe("parseItemText 基本字段", () => {
  it("解析稀有装备的稀有度/名称/基底/物品等级/词缀", () => {
    const item = parseItemText(readSample("item_rare_cn.txt"));
    expect(item.rarity).toBe("稀有");
    expect(item.name).toBe("苦闷轻语");
    expect(item.baseType).toBe("编织法衣");
    expect(item.itemLevel).toBe(78);

    const texts = item.affixTexts();
    expect(texts.some((t) => t.includes("最大生命"))).toBe(true);
    // 能量护盾是基底属性行，不能当成词缀
    expect(texts.some((t) => t.startsWith("能量护盾"))).toBe(false);

    const life = item.affixes.find((a) => a.text.includes("最大生命"))!;
    expect(life.firstValue).toBe(96);
    expect(item.craftAffixCount).toBe(5);
  });

  it("解析魔法装备", () => {
    const item = parseItemText(readSample("item_magic_cn.txt"));
    expect(item.rarity).toBe("魔法");
    expect(item.affixTexts()).toEqual(["+70 最大生命", "+15% 火焰抗性"]);
    expect(item.craftAffixCount).toBe(2);
  });

  it("没有稀有度但有物品等级时按普通处理", () => {
    const item = parseItemText("威武皮盔\n--------\n闪避值: 669\n--------\n物品等级: 100\n--------\n已鉴定");
    expect(item.rarity).toBe("普通");
    expect(item.craftAffixCount).toBe(0);
  });

  it("兼容国服「稀 有 度: 魔法」这种带空格的元数据行", () => {
    const item = parseItemText(
      [
        "物品类别: 头部",
        "稀 有 度: 魔法",
        "督军的雪人之威武皮盔",
        "--------",
        "品质: +27% (augmented)",
        "闪避值: 747 (augmented)",
        "--------",
        "需求:",
        "等级: 84",
        "敏捷: 224 (unmet)",
        "--------",
        "插槽: G",
        "--------",
        "物品等级: 84",
        "--------",
        '{ ▲ 前缀词缀 "督军的" (等阶：1)— 伤害, 元素 }',
        "元素伤害提高 19(19-22)%",
        '{ ▽ 后缀词缀 "雪人之" (等阶：5)— 元素, 冰霜, 抗性 }',
        "+25(24-29)% 冰霜抗性",
        "--------",
        "圣战者物品",
        "督军物品",
        "--------",
        "出售获得通货:非绑定",
      ].join("\n"),
    );
    expect(item.rarity).toBe("魔法");
    expect(item.itemLevel).toBe(84);
    expect(item.affixTexts()).toEqual(["元素伤害提高 19(19-22)%", "+25(24-29)% 冰霜抗性"]);
    expect(item.affixes[0].values).toEqual([19]);
    expect(item.affixes[1].values).toEqual([25]);
    expect(item.craftAffixCount).toBe(2);
  });

  it("读取高级词缀说明中的前后缀名称，并关联同一词缀的所有效果行", () => {
    const item = parseItemText(readSample("item_magic_flask_cn.txt"));
    const alchemist = item.affixes.filter((a) => a.name === "炼金的");
    const moss = item.affixes.filter((a) => a.name === "泥藓之");

    expect(alchemist.map((a) => a.text)).toEqual(["生效时间缩短 25(27-23)%", "效果提高 25%"]);
    expect(moss.map((a) => a.text)).toEqual(["生效期间，有 52(51-55)% 几率避免被感电"]);
    expect(item.affixes.find((a) => a.text === "效果提高 70%")?.name).toBe("");
    expect(item.affixes.some((a) => a.text.includes("点击右键"))).toBe(false);
    expect(item.itemLevel).toBe(87);
    expect(item.craftAffixCount).toBe(2);
  });

  it("影响力标记与出售绑定信息不计入词缀", () => {
    const item = parseItemText(
      [
        "物品类别: 头部",
        "稀有度: 魔法",
        "丰饶的威武皮盔",
        "威武皮盔",
        "--------",
        "物品等级: 100",
        "--------",
        "+130 最大生命",
        "--------",
        "圣战者物品",
        "督军物品",
        "出售获得通货:非绑定",
        "--------",
        "已鉴定",
      ].join("\n"),
    );
    expect(item.name).toBe("丰饶的威武皮盔");
    expect(item.baseType).toBe("威武皮盔");
    expect(item.affixTexts()).toEqual(["+130 最大生命"]);
    expect(item.craftAffixCount).toBe(1);
  });

  it("未鉴定装备直接返回，不推断显式词缀数", () => {
    const item = parseItemText(
      "物品类别: 头部\n稀有度: 稀有\n未知之冠\n威武皮盔\n--------\n物品等级: 84\n--------\n未鉴定",
    );
    expect(item.flags).toContain("unidentified");
    expect(item.affixes).toEqual([]);
    expect(item.explicitModCount).toBeNull();
    expect(item.craftAffixCount).toBe(0);
  });

  it("已腐化会同时置 corrupted 与 flags", () => {
    const item = parseItemText(
      "物品类别: 头部\n稀有度: 稀有\n腐化之冠\n威武皮盔\n--------\n物品等级: 84\n--------\n+130 最大生命\n--------\n已腐化",
    );
    expect(item.corrupted).toBe(true);
    expect(item.flags).toContain("corrupted");
  });
});

// craftAffixCount 直接决定「是否使用增幅石」，历史上这里出过两类 bug
describe("显式词缀计数", () => {
  it("固有词缀（独立段落）不计入显式，但词缀文本仍保留供规则匹配", () => {
    const item = parseItemText(
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
        "+130 最大生命",
        "+25% 冰霜抗性",
        "--------",
        "已鉴定",
      ].join("\n"),
    );
    expect(item.affixTexts()).toEqual(["+20 最大生命", "+130 最大生命", "+25% 冰霜抗性"]);
    expect(item.affixes.length).toBe(3);
    expect(item.craftAffixCount).toBe(2);
  });

  it("固有词缀说明行即使带「词缀」字样也不计入显式", () => {
    const item = parseItemText(
      [
        "物品类别: 头部",
        "稀有度: 稀有",
        "测试头盔",
        "威武皮盔",
        "--------",
        "物品等级: 84",
        "--------",
        "{ 固有词缀 }",
        "+20 最大生命",
        '{ ▲ 前缀词缀 "残酷的" (等阶：1)— 伤害 }',
        "+130 最大生命",
        "--------",
        "已鉴定",
      ].join("\n"),
    );
    expect(item.affixes.length).toBe(2);
    expect(item.craftAffixCount).toBe(1);
  });

  it("附魔不计入显式", () => {
    const item = parseItemText(
      [
        "物品类别: 头部",
        "稀有度: 魔法",
        "附魔头盔",
        "威武皮盔",
        "--------",
        "物品等级: 84",
        "--------",
        "技能效果持续时间延长 10% （附魔）",
        "--------",
        "+130 最大生命",
        "--------",
        "已鉴定",
      ].join("\n"),
    );
    expect(item.affixes.length).toBe(2);
    expect(item.craftAffixCount).toBe(1);
  });

  it("一条复合词缀产生两行时按 mod 计 1，而不是按行计 2", () => {
    const item = parseItemText(
      [
        "物品类别: 头部",
        "稀有度: 魔法",
        "残酷的威武皮盔",
        "威武皮盔",
        "--------",
        "物品等级: 84",
        "--------",
        '{ ▲ 前缀词缀 "残酷的" (等阶：1)— 伤害 }',
        "物理伤害提高 20%",
        "+15 力量",
        "--------",
        "已鉴定",
      ].join("\n"),
    );
    expect(item.affixes.length).toBe(2);
    expect(item.craftAffixCount).toBe(1);
  });

  it("腰带固有生命与显式挤在同一段时按基底常见固有排除", () => {
    const item = parseItemText(
      [
        "物品类别: 腰带",
        "稀有度: 魔法",
        "督军的重皮腰带",
        "重皮腰带",
        "--------",
        "物品等级: 86",
        "--------",
        "+35 最大生命",
        "+130 最大生命",
        "--------",
        "已鉴定",
      ].join("\n"),
    );
    expect(item.affixes.length).toBe(2);
    expect(item.craftAffixCount).toBe(1);
  });

  it("普通稀有度的腰带整段都算固有，显式为 0", () => {
    const item = parseItemText(
      "物品类别: 腰带\n稀有度: 普通\n重皮腰带\n--------\n物品等级: 86\n--------\n+35 最大生命\n--------\n已鉴定",
    );
    expect(item.affixes.length).toBe(1);
    expect(item.craftAffixCount).toBe(0);
  });
});

describe("extractNumbers", () => {
  it("取词缀行里的数值，括号内的 roll 范围要忽略", () => {
    expect(extractNumbers("+96 最大生命")).toEqual([96]);
    expect(extractNumbers("攻击速度加快 12%")).toEqual([12]);
    expect(extractNumbers("增加 10-20% 物理伤害")).toEqual([10, 20]);
    expect(extractNumbers("附加 5-10 (5-10) 物理伤害")).toEqual([5, 10]);
    expect(extractNumbers("攻击附加 6 - 12 基础冰霜伤害")).toEqual([6, 12]);
    expect(extractNumbers("法杖攻击附加 2 到 48 点闪电伤害")).toEqual([2, 48]);
    expect(extractNumbers("元素伤害提高 19(19-22)%")).toEqual([19]);
    expect(extractNumbers("+25(24-29)% 冰霜抗性")).toEqual([25]);
  });

  it("支持小数与负号，没有数字时返回空数组", () => {
    expect(extractNumbers("暴击率: 5.50%")).toEqual([5.5]);
    expect(extractNumbers("-15% 火焰抗性")).toEqual([-15]);
    expect(extractNumbers("无数字词缀")).toEqual([]);
  });
});

// 这是「读到的东西到底是不是装备」的唯一闸门，放行通货 tooltip 会让后续逻辑误判
describe("isEquipmentClipboardText", () => {
  it("接受装备文本", () => {
    expect(isEquipmentClipboardText(readSample("item_rare_cn.txt"))).toBe(true);
    expect(isEquipmentClipboardText(readSample("item_magic_cn.txt"))).toBe(true);
  });

  it("拒绝空白文本", () => {
    expect(isEquipmentClipboardText("")).toBe(false);
    expect(isEquipmentClipboardText("   \n \t  ")).toBe(false);
  });

  it("拒绝通货 tooltip", () => {
    expect(isEquipmentClipboardText(CURRENCY_TOOLTIP)).toBe(false);
    expect(isEquipmentClipboardText("物品类别: 可堆叠通货\n改造石\n堆叠数量: 8/30")).toBe(false);
    expect(isEquipmentClipboardText("稀有度: 通货\n改造石")).toBe(false);
    expect(isEquipmentClipboardText("稀 有 度: 通货\n改造石")).toBe(false);
    expect(isEquipmentClipboardText("物 品 类 别: 可堆叠通货\n改造石")).toBe(false);
  });

  it("物品类别行里出现第二个冒号时仍能识别出通货", () => {
    // JS 的 split(":", n) 会截断数组而不是保留冒号之后的全部内容
    expect(isEquipmentClipboardText("物品类别: 可堆叠: 通货\n改造石")).toBe(false);
    expect(isEquipmentClipboardText("物品类别: 通货: 可堆叠\n改造石")).toBe(false);
  });

  it("拒绝网页与「未找到物品」", () => {
    expect(isEquipmentClipboardText("未找到物品")).toBe(false);
    expect(isEquipmentClipboardText("http://example.com/item")).toBe(false);
    expect(isEquipmentClipboardText("https://poe.ninja")).toBe(false);
  });
});

describe("parseItemText 错误路径", () => {
  it("空剪贴板与通货文本都抛 ItemParseError", () => {
    expect(() => parseItemText("")).toThrow(ItemParseError);
    expect(() => parseItemText("   ")).toThrow(/剪贴板为空/);
    expect(() => parseItemText(CURRENCY_TOOLTIP)).toThrow(/不是装备文本/);
  });
});
