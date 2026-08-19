import { describe, expect, it } from "vitest";
import { CURRENCIES, CURRENCY_BY_TEMPLATE, currencyLabel, currencyStackCount } from "../currencies";

describe("currencyStackCount", () => {
  it("读取国服与英文客户端的堆叠数量写法", () => {
    expect(currencyStackCount("堆叠数量: 17/20")).toBe(17);
    expect(currencyStackCount("堆 叠 数 量： 1 / 20")).toBe(1);
    expect(currencyStackCount("堆叠数量: 1,808 / 20")).toBe(1808);
    expect(currencyStackCount("堆叠数量：12，345 / 20")).toBe(12345);
    expect(currencyStackCount("Stack Size: 9/40")).toBe(9);
  });

  it("没有堆叠数量时返回 null（不能当成 0 也不能当成有货）", () => {
    expect(currencyStackCount("改造石")).toBeNull();
    expect(currencyStackCount("")).toBeNull();
  });

  it("从完整通货 tooltip 中取斜杠前的剩余量", () => {
    const tooltip = "物品类别: 可堆叠通货\n稀有度: 通货\n改造石\n--------\n堆叠数量: 27/40";
    expect(currencyStackCount(tooltip)).toBe(27);
  });
});

describe("currencyLabel", () => {
  it("模板名映射到中文名；未内置时原样返回", () => {
    expect(currencyLabel("currency_alteration")).toBe("改造石");
    expect(currencyLabel("currency_transmutation")).toBe("蜕变石");
    expect(currencyLabel("item_slot")).toBe("item_slot");
  });

  it("模板名与中文名都不重复：重名会让悬停核名认错通货", () => {
    const templates = CURRENCIES.map((c) => c.templateName);
    const labels = CURRENCIES.map((c) => c.label);
    expect(new Set(templates).size).toBe(templates.length);
    expect(new Set(labels).size).toBe(labels.length);
    expect(Object.keys(CURRENCY_BY_TEMPLATE).length).toBe(CURRENCIES.length);
  });

  it("模板名统一 currency_ 前缀，且与 key 对应", () => {
    for (const c of CURRENCIES) expect(c.templateName).toBe(`currency_${c.key}`);
  });
});
