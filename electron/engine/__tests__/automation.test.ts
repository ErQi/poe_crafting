import { describe, expect, it } from "vitest";
import {
  clampMs,
  currencyHitConflict,
  hitCenterInRegion,
  hitClientRegion,
  hitInWindow,
  hitsClose,
  isCurrencyClipboardText,
  pointInHit,
  shouldSkipAugmentation,
  workflowAssetLabel,
} from "../automation";
import { parseItemText } from "../itemParser";
import { CraftStep } from "../models";
import type { MatchHit } from "../vision";
import { itemText, makeWindow, readSample } from "./helpers";

/**
 * automation.ts 的循环主体依赖真实窗口、截屏、剪贴板和光标状态，替身要跟着私有方法签名走，
 * 一改接口就烂；这里只覆盖不依赖外部状态的纯判定：「该不该点」「点的是不是同一个东西」
 * 这类护栏，以及跳过增幅的条件。
 */

function makeHit(x: number, y: number, size: number, name = "hit"): MatchHit {
  return { name, score: 1, screenX: x, screenY: y, clientX: x, clientY: y, width: size, height: size };
}

describe("shouldSkipAugmentation", () => {
  const augment = new CraftStep({ currencyTemplate: "currency_augmentation" });
  const alteration = new CraftStep({ currencyTemplate: "currency_alteration" });

  it("只有恰好 1 条显式词缀时才使用增幅石", () => {
    const oneMod = parseItemText(itemText("魔法", "元素伤害提高 19%"));
    const twoMods = parseItemText(itemText("魔法", "元素伤害提高 19%", "+25% 冰霜抗性"));
    expect(shouldSkipAugmentation(augment, oneMod)).toBe(false);
    expect(shouldSkipAugmentation(augment, twoMods)).toBe(true);
  });

  it("没有显式词缀时也跳过（增幅对普通装备无意义）", () => {
    expect(shouldSkipAugmentation(augment, parseItemText(itemText("普通")))).toBe(true);
  });

  it("其他通货步骤永不跳过", () => {
    const twoMods = parseItemText(itemText("魔法", "元素伤害提高 19%", "+25% 冰霜抗性"));
    expect(shouldSkipAugmentation(alteration, twoMods)).toBe(false);
  });

  it("按显式词缀数判断，不受固有词缀行数影响", () => {
    // 固有 +20 生命 + 1 条显式：affixes 有 2 行，但显式只有 1 条 → 应该用增幅
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
    expect(shouldSkipAugmentation(augment, withImplicit)).toBe(false);
  });
});

describe("hitClientRegion / hitCenterInRegion", () => {
  it("按中心与宽高推出客户区矩形", () => {
    expect(hitClientRegion(makeHit(400, 500, 120))).toEqual([340, 440, 460, 560]);
    // 奇数尺寸向下取整半宽
    expect(hitClientRegion(makeHit(100, 100, 49))).toEqual([76, 76, 125, 125]);
  });

  it("判断格心是否落在区域内（右/下开区间）", () => {
    const region: [number, number, number, number] = [340, 440, 460, 560];
    expect(hitCenterInRegion(makeHit(400, 500, 48), region)).toBe(true);
    expect(hitCenterInRegion(makeHit(340, 440, 48), region)).toBe(true);
    expect(hitCenterInRegion(makeHit(460, 500, 48), region)).toBe(false);
    expect(hitCenterInRegion(makeHit(400, 560, 48), region)).toBe(false);
    expect(hitCenterInRegion(makeHit(339, 500, 48), region)).toBe(false);
  });

  it("通货格心落进装备区域时能被识别出来——这是拒绝左键的依据", () => {
    const itemHit = makeHit(400, 500, 120, "item_slot");
    const falseCurrency = makeHit(400, 500, 48, "currency_alteration");
    expect(hitCenterInRegion(falseCurrency, hitClientRegion(itemHit))).toBe(true);

    const realCurrency = makeHit(100, 200, 48, "currency_alteration");
    expect(hitCenterInRegion(realCurrency, hitClientRegion(itemHit))).toBe(false);
  });
});

describe("pointInHit", () => {
  const hit = makeHit(400, 500, 120);

  it("命中范围是 [中心-半宽, 中心-半宽+宽)", () => {
    expect(pointInHit(400, 500, hit)).toBe(true);
    expect(pointInHit(340, 440, hit)).toBe(true);
    expect(pointInHit(459, 559, hit)).toBe(true);
    expect(pointInHit(339, 500, hit)).toBe(false);
    expect(pointInHit(460, 500, hit)).toBe(false);
    expect(pointInHit(400, 560, hit)).toBe(false);
  });

  it("零宽高的 hit 至少覆盖 1 像素，不会永远判否", () => {
    const degenerate = makeHit(10, 10, 0);
    expect(pointInHit(10, 10, degenerate)).toBe(true);
    expect(pointInHit(11, 10, degenerate)).toBe(false);
  });
});

describe("currencyHitConflict", () => {
  it("两个正常间距的通货格不冲突", () => {
    expect(currencyHitConflict(makeHit(100, 200, 48), makeHit(400, 500, 48))).toBe(false);
    // 相邻仓库格（间距等于格距）不算冲突
    expect(currencyHitConflict(makeHit(220, 548, 112), makeHit(332, 548, 112))).toBe(false);
  });

  it("中心落进对方范围就算冲突（不论谁大谁小）", () => {
    const big = makeHit(400, 500, 120);
    const small = makeHit(400, 500, 48);
    expect(currencyHitConflict(small, big)).toBe(true);
    expect(currencyHitConflict(big, small)).toBe(true);
  });

  it("中心距离小于半格时算冲突", () => {
    expect(currencyHitConflict(makeHit(100, 200, 48), makeHit(120, 200, 48))).toBe(true);
    expect(currencyHitConflict(makeHit(100, 200, 48), makeHit(140, 200, 48))).toBe(false);
  });
});

describe("hitInWindow", () => {
  const win = makeWindow(1920, 1080, 100, 50);

  it("屏幕坐标必须落在窗口矩形内", () => {
    expect(hitInWindow(makeHit(200, 300, 48), win)).toBe(true);
    expect(hitInWindow(makeHit(100, 50, 48), win)).toBe(true);
    expect(hitInWindow(makeHit(2020, 300, 48), win)).toBe(false);
    expect(hitInWindow(makeHit(99, 300, 48), win)).toBe(false);
    expect(hitInWindow(makeHit(200, 1130, 48), win)).toBe(false);
  });

  it("非有限坐标一律拒绝", () => {
    expect(hitInWindow(makeHit(NaN, 300, 48), win)).toBe(false);
    expect(hitInWindow(makeHit(200, Infinity, 48), win)).toBe(false);
  });
});

describe("hitsClose", () => {
  it("8 像素内视为同一处，用来避免把光标停回原地", () => {
    expect(hitsClose(makeHit(100, 200, 48), makeHit(105, 203, 48))).toBe(true);
    expect(hitsClose(makeHit(100, 200, 48), makeHit(109, 200, 48))).toBe(false);
  });

  it("任一侧缺失时返回 false", () => {
    expect(hitsClose(null, makeHit(100, 200, 48))).toBe(false);
    expect(hitsClose(makeHit(100, 200, 48), undefined)).toBe(false);
  });
});

describe("clampMs", () => {
  it("非正数或无法解析时用兜底值", () => {
    expect(clampMs("abc", 50, 10000, 280)).toBe(280);
    expect(clampMs("", 50, 10000, 280)).toBe(280);
    expect(clampMs(null, 50, 10000, 280)).toBe(280);
    expect(clampMs(undefined, 50, 10000, 280)).toBe(280);
    expect(clampMs(0, 50, 10000, 280)).toBe(280);
    expect(clampMs(-5, 50, 10000, 280)).toBe(280);
  });

  it("越界时 clamp，小数取整", () => {
    expect(clampMs(10, 50, 10000, 280)).toBe(50);
    expect(clampMs(99999, 50, 10000, 280)).toBe(10000);
    expect(clampMs(300.6, 50, 10000, 280)).toBe(301);
    expect(clampMs("500", 50, 10000, 280)).toBe(500);
  });
});

describe("isCurrencyClipboardText", () => {
  it("有堆叠数量就算通货文本", () => {
    expect(isCurrencyClipboardText("改造石\n堆叠数量: 27/40")).toBe(true);
    expect(isCurrencyClipboardText("Orb of Alteration\nStack Size: 9/40")).toBe(true);
  });

  it("含「通货」/「Currency」字样也算", () => {
    expect(isCurrencyClipboardText("物品类别: 可堆叠通货\n改造石")).toBe(true);
    expect(isCurrencyClipboardText("Item Class: Stackable Currency\nOrb of Alteration")).toBe(true);
  });

  it("拒绝空白、网页与「未找到物品」", () => {
    expect(isCurrencyClipboardText("")).toBe(false);
    expect(isCurrencyClipboardText("   ")).toBe(false);
    expect(isCurrencyClipboardText("未找到物品")).toBe(false);
    expect(isCurrencyClipboardText("http://example.com")).toBe(false);
  });

  it("普通装备文本不算通货", () => {
    expect(isCurrencyClipboardText(readSample("item_rare_cn.txt"))).toBe(false);
  });

  it("装备带「出售获得通货」行时这里会误判为通货", () => {
    // 只按关键字判断，没有像 isEquipmentClipboardText 那样限定在元数据行上。
    // 真正拦住误点的是调用方随后的「复制文本里必须出现该通货中文名」检查。
    const equipmentWithSaleLine = [
      "物品类别: 头部",
      "稀有度: 魔法",
      "丰饶的威武皮盔",
      "威武皮盔",
      "--------",
      "物品等级: 100",
      "--------",
      "+130 最大生命",
      "--------",
      "出售获得通货:非绑定",
    ].join("\n");
    expect(isCurrencyClipboardText(equipmentWithSaleLine)).toBe(true);
    expect(equipmentWithSaleLine.includes("改造石")).toBe(false);
  });
});

describe("workflowAssetLabel", () => {
  it("装备格与通货分别给出可读名称", () => {
    expect(workflowAssetLabel("item_slot")).toBe("目标装备");
    expect(workflowAssetLabel("currency_alteration")).toBe("改造石图标");
    expect(workflowAssetLabel("craft_button")).toBe("craft_button");
  });
});
