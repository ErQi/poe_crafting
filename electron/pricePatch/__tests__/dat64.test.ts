import { describe, expect, it } from "vitest";
import {
  cleanLocalizedBaseItems,
  isPriceSuffixOnlyBaseItemVariant,
  parseBaseItemTypes,
  patchLocalizedBaseItems,
} from "../dat64";
import type { PriceQuote } from "../types";

const RECORD_SIZE = 40;

function dat(rows: Array<{ id: string; name: string }>): Buffer {
  const fixed = Buffer.alloc(4 + rows.length * RECORD_SIZE + 8, 0);
  fixed.writeInt32LE(rows.length, 0);
  fixed.fill(0xbb, 4 + rows.length * RECORD_SIZE);
  const chunks: Buffer[] = [fixed];
  const section = fixed.length - 8;
  let relative = 8;
  const offsets = new Map<string, number>();
  function add(value: string): number {
    const existing = offsets.get(value);
    if (existing !== undefined) return existing;
    const offset = relative;
    const encoded = Buffer.concat([Buffer.from(value, "utf16le"), Buffer.alloc(4)]);
    chunks.push(encoded);
    relative += encoded.length;
    offsets.set(value, offset);
    return offset;
  }
  rows.forEach((row, index) => {
    const record = 4 + index * RECORD_SIZE;
    fixed.writeBigInt64LE(BigInt(add(row.id)), record);
    fixed.writeBigInt64LE(BigInt(add(row.name)), record + 32);
  });
  const result = Buffer.concat(chunks);
  expect(section).toBe(4 + rows.length * RECORD_SIZE);
  return result;
}

function quote(
  englishName: string,
  itemName: string,
  display: string,
  source: PriceQuote["source"] = "poecurrency",
): PriceQuote {
  return {
    englishName,
    itemName,
    display,
    category: "通货",
    value: 1,
    unit: display.endsWith("d") ? "d" : "c",
    sourceTime: "2026-08-20 20:00:00",
    source,
  };
}

describe("BaseItemTypes 基线重建", () => {
  it("优先按英文名与内部 Id 匹配，并保留国服名称前缀", () => {
    const english = dat([
      { id: "Metadata/Chaos", name: "Chaos Orb" },
      { id: "Metadata/Divine", name: "Divine Orb" },
    ]);
    const localized = dat([
      { id: "Metadata/Chaos", name: "◆混沌石" },
      { id: "Metadata/Divine", name: "神圣石" },
    ]);
    const patched = patchLocalizedBaseItems(english, localized, [
      quote("Chaos Orb", "混沌石", "1c"),
      quote("Divine Orb", "神圣石", "0.9d"),
    ]);
    expect(patched.matchedIds).toEqual(["Metadata/Chaos", "Metadata/Divine"]);
    expect(parseBaseItemTypes(patched.buffer).rows.map((row) => row.name)).toEqual([
      "◆混沌石 · 1c",
      "神圣石 · 0.9d",
    ]);
  });

  it("即使输入含历史格式价格，也从无价格名称重新生成，不会叠加", () => {
    const english = dat([{ id: "Metadata/Divine", name: "Divine Orb" }]);
    const localized = dat([{ id: "Metadata/Divine", name: "神圣石【1d】⌈0.9d⌋ · 401c" }]);
    const patched = patchLocalizedBaseItems(english, localized, [quote("Divine Orb", "神圣石", "1.1d")]);
    expect(parseBaseItemTypes(patched.buffer).rows[0].name).toBe("神圣石 · 1.1d");
  });

  it("可按国服当前内部 Id 和中英文名标记琪莎拉纪念币", () => {
    const id = "Metadata/Items/Deepwater/DeepwaterItemSplit";
    const english = dat([{ id, name: "Kishara's Ducat" }]);
    const localized = dat([{ id, name: "琪莎拉纪念币" }]);
    const patched = patchLocalizedBaseItems(english, localized, [quote("Kishara's Ducat", "琪莎拉纪念币", "5c")]);
    expect(patched.matchedIds).toEqual([id]);
    expect(parseBaseItemTypes(patched.buffer).rows[0].name).toBe("琪莎拉纪念币 · 5c");
  });

  it("中英文命中来自不同数据源时严格按易刷、国服旧源、poe.ninja 排序", () => {
    const english = dat([{ id: "Metadata/Divine", name: "Divine Orb" }]);
    const localized = dat([{ id: "Metadata/Divine", name: "神圣石[※ ※]" }]);
    const patched = patchLocalizedBaseItems(english, localized, [
      quote("Divine Orb", "", "1d", "poe-ninja"),
      quote("", "神圣石", "125c", "poecurrency"),
      quote("", "神圣石", "120c", "efarm"),
    ]);
    expect(parseBaseItemTypes(patched.buffer).rows[0].name).toBe("神圣石[※ ※] · 120c");
  });

  it("poe.ninja 兜底价使用 ⁙ 标识非国服来源", () => {
    const english = dat([{ id: "Metadata/Divine", name: "Divine Orb" }]);
    const localized = dat([{ id: "Metadata/Divine", name: "神圣石" }]);
    const patched = patchLocalizedBaseItems(english, localized, [
      quote("Divine Orb", "", "1d", "poe-ninja"),
    ]);

    expect(parseBaseItemTypes(patched.buffer).rows[0].name).toBe("神圣石 ⁙ 1d");
  });

  it("易刷模式使用查价器可识别的方括号价格后缀", () => {
    const english = dat([{ id: "Metadata/Divine", name: "Divine Orb" }]);
    const localized = dat([{ id: "Metadata/Divine", name: "神圣石" }]);
    const patched = patchLocalizedBaseItems(
      english,
      localized,
      [quote("Divine Orb", "神圣石", "1.2d", "efarm")],
      "efarm",
    );

    expect(parseBaseItemTypes(patched.buffer).rows[0].name).toBe("神圣石[1.2d]");
  });

  it("建立新版本基线时可清理本功能留下的价格后缀", () => {
    const localized = dat([
      { id: "a", name: "神圣石【1d】" },
      { id: "b", name: "崇高石⌈6.6c⌋" },
      { id: "c", name: "混沌石 · 1c" },
      { id: "d", name: "机会石 ⁙ 2c" },
      { id: "e", name: "点金石[.5c]" },
      { id: "f", name: "普通物品" },
    ]);
    const cleaned = cleanLocalizedBaseItems(localized);
    expect(cleaned.changedCount).toBe(5);
    expect(parseBaseItemTypes(cleaned.buffer).rows.map((row) => row.name)).toEqual([
      "神圣石",
      "崇高石",
      "混沌石",
      "机会石",
      "点金石",
      "普通物品",
    ]);
  });

  it("可严格识别从同一基线生成的易刷格式价格版本", () => {
    const baseline = dat([
      { id: "Metadata/Chaos", name: "混沌石" },
      { id: "Metadata/Divine", name: "神圣石" },
    ]);
    const candidate = patchLocalizedBaseItems(baseline, baseline, [
      quote("混沌石", "混沌石", "1c"),
      quote("神圣石", "神圣石", "125c"),
    ], "efarm").buffer;

    expect(isPriceSuffixOnlyBaseItemVariant(baseline, candidate)).toBe(true);

    const otherBinaryChange = Buffer.from(candidate);
    otherBinaryChange[4 + 16] = 1;
    expect(isPriceSuffixOnlyBaseItemVariant(baseline, otherBinaryChange)).toBe(false);
  });
});
