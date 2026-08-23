import { describe, expect, it } from "vitest";
import {
  cleanLocalizedUniqueWords,
  isPriceSuffixOnlyUniqueWordsVariant,
  parseUniqueWordRows,
  patchLocalizedUniqueWords,
} from "../uniqueWordsDat64";
import type { PriceQuote } from "../types";

const WORD_RECORD_SIZE = 64;
const UNIQUE_RECORD_SIZE = 16;

function dat(rowCount: number, recordSize: number, build: (fixed: Buffer, add: (value: string) => number) => void): Buffer {
  const fixed = Buffer.alloc(4 + rowCount * recordSize + 8, 0);
  fixed.writeInt32LE(rowCount, 0);
  fixed.fill(0xbb, 4 + rowCount * recordSize);
  const chunks: Buffer[] = [fixed];
  let relative = 8;
  const add = (value: string) => {
    const offset = relative;
    const encoded = Buffer.concat([Buffer.from(value, "utf16le"), Buffer.alloc(4)]);
    chunks.push(encoded);
    relative += encoded.length;
    return offset;
  };
  build(fixed, add);
  return Buffer.concat(chunks);
}

function words(rows: Array<{ text: string; localized: string; wordlist?: number }>): Buffer {
  return dat(rows.length, WORD_RECORD_SIZE, (fixed, add) => {
    rows.forEach((row, index) => {
      const record = 4 + index * WORD_RECORD_SIZE;
      fixed.writeUInt32LE(row.wordlist || 0, record);
      fixed.writeBigInt64LE(BigInt(add(row.text)), record + 4);
      fixed.writeBigInt64LE(BigInt(add(row.localized)), record + 48);
    });
  });
}

function uniqueLayout(wordRows: number[]): Buffer {
  const padded = [...wordRows];
  while (padded.length < 4) padded.push(wordRows.at(-1) || 0);
  return dat(padded.length, UNIQUE_RECORD_SIZE, (fixed) => {
    padded.forEach((row, index) => fixed.writeBigInt64LE(BigInt(row), 4 + index * UNIQUE_RECORD_SIZE));
  });
}

function quote(englishName: string, display: string): PriceQuote {
  return {
    englishName,
    itemName: "",
    category: "poe.ninja UniqueAccessory",
    value: 90,
    unit: "c",
    display,
    sourceTime: "2026-08-23T04:00:00.000Z",
    source: "poe-ninja",
  };
}

describe("唯一装备 Words 标价", () => {
  it("沿 UniqueStashLayout 行引用匹配英文唯一名，并修改国服 Text2", () => {
    const english = words([
      { text: "Unused Word", localized: "Unused Word" },
      { text: "Uzaza's Mountain", localized: "Uzaza's Mountain" },
    ]);
    const localized = words([
      { text: "Unused Word", localized: "未使用" },
      { text: "Uzaza's Mountain", localized: "乌扎萨的高山" },
    ]);
    const layout = uniqueLayout([1]);
    expect(parseUniqueWordRows(english, localized, layout)).toEqual([
      { index: 1, englishName: "Uzaza's Mountain", localizedName: "乌扎萨的高山" },
    ]);

    const patched = patchLocalizedUniqueWords(english, localized, layout, [quote("Uzaza's Mountain", "90c")]);
    expect(patched.matchedRows).toEqual([1]);
    expect(parseUniqueWordRows(english, patched.buffer, layout)[0].localizedName).toBe("乌扎萨的高山 · 90c");
  });

  it("扩展到 Words 全部唯一物品词条，并以改名后的 Text2 匹配", () => {
    const english = words([
      { text: "Layout Unique", localized: "Layout Unique" },
      { text: "Lash of Retribution", localized: "Binds of Bloody Vengeance", wordlist: 6 },
      { text: "Ordinary Word", localized: "Ordinary Word" },
    ]);
    const localized = words([
      { text: "Layout Unique", localized: "仓库唯一" },
      { text: "Lash of Retribution", localized: "鲜血复仇之缚", wordlist: 6 },
      { text: "Ordinary Word", localized: "普通词条" },
    ]);
    const layout = uniqueLayout([0]);

    expect(parseUniqueWordRows(english, localized, layout)).toEqual([
      { index: 0, englishName: "Layout Unique", localizedName: "仓库唯一" },
      { index: 1, englishName: "Binds of Bloody Vengeance", localizedName: "鲜血复仇之缚" },
    ]);
    const patched = patchLocalizedUniqueWords(
      english,
      localized,
      layout,
      [quote("Binds of Bloody Vengeance", "12d")],
    );
    expect(patched.matchedRows).toEqual([1]);
    expect(parseUniqueWordRows(english, patched.buffer, layout)[1].localizedName).toBe("鲜血复仇之缚 · 12d");
  });

  it("当普通唯一名缺价时，可用 Foulborn API 前缀名回退匹配", () => {
    const english = words([
      { text: "Unused", localized: "Unused" },
      { text: "Al Dhih", localized: "Al Dhih", wordlist: 6 },
    ]);
    const localized = words([
      { text: "Unused", localized: "未使用" },
      { text: "Al Dhih", localized: "艾尔迪赫", wordlist: 6 },
    ]);
    const layout = uniqueLayout([0]);
    const patched = patchLocalizedUniqueWords(english, localized, layout, [quote("Foulborn Al Dhih", "30c")]);
    expect(patched.matchedRows).toEqual([1]);
    expect(parseUniqueWordRows(english, patched.buffer, layout)[1].localizedName).toBe("艾尔迪赫 · 30c");
  });

  it("清理历史价格后缀且不改非价格文本", () => {
    const localized = words([
      { text: "Uzaza's Mountain", localized: "乌扎萨的高山 · 90c" },
      { text: "Not a unique", localized: "保留文字 · 10c" },
    ]);
    const cleaned = cleanLocalizedUniqueWords(localized, uniqueLayout([0]));
    expect(cleaned.changedCount).toBe(1);
    const english = words([
      { text: "Uzaza's Mountain", localized: "Uzaza's Mountain" },
      { text: "Not a unique", localized: "Not a unique" },
    ]);
    const rows = parseUniqueWordRows(english, cleaned.buffer, uniqueLayout([0, 1]));
    expect(rows.map((row) => row.localizedName)).toEqual(["乌扎萨的高山", "保留文字 · 10c"]);
  });

  it("只接受同一 Words 基线中唯一名称的价格后缀变化", () => {
    const english = words([
      { text: "Unused Word", localized: "Unused Word" },
      { text: "Uzaza's Mountain", localized: "Uzaza's Mountain" },
    ]);
    const baseline = words([
      { text: "Unused Word", localized: "未使用" },
      { text: "Uzaza's Mountain", localized: "乌扎萨的高山" },
    ]);
    const layout = uniqueLayout([1]);
    const candidate = patchLocalizedUniqueWords(english, baseline, layout, [quote("Uzaza's Mountain", "90c")]).buffer;

    expect(isPriceSuffixOnlyUniqueWordsVariant(baseline, candidate, layout)).toBe(true);

    const otherWordChange = Buffer.from(candidate);
    otherWordChange[4 + 8] = 1;
    expect(isPriceSuffixOnlyUniqueWordsVariant(baseline, otherWordChange, layout)).toBe(false);
  });
});
