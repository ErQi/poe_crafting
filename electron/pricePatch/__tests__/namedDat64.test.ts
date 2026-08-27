import { describe, expect, it } from "vitest";
import {
  cleanLocalizedNamedDat,
  isPriceSuffixOnlyNamedDatVariant,
  parseNamedDatRows,
  patchLocalizedNamedDat,
  referencedRowIndexes,
} from "../namedDat64";
import type { PriceQuote } from "../types";

const RECORD_SIZE = 24;
const NAME_OFFSET = 8;

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

function names(values: string[]): Buffer {
  return dat(values.length, RECORD_SIZE, (fixed, add) => {
    values.forEach((value, index) => {
      fixed.writeBigInt64LE(BigInt(add(value)), 4 + index * RECORD_SIZE + NAME_OFFSET);
    });
  });
}

function references(values: number[]): Buffer {
  return dat(values.length, 16, (fixed) => {
    values.forEach((value, index) => fixed.writeBigInt64LE(BigInt(value), 4 + index * 16));
  });
}

function quote(
  englishName: string,
  display: string,
  itemName = "",
  source: PriceQuote["source"] = "poe-ninja",
): PriceQuote {
  return {
    englishName,
    itemName,
    category: "poe.ninja Beast",
    value: 10,
    unit: "c",
    display,
    sourceTime: "2026-08-23T04:00:00.000Z",
    source,
  };
}

describe("扩展名称 DAT 标价", () => {
  it("按英文行名匹配并修改对应的国服名称", () => {
    const english = names(["Unused", "Craicic Chimeral"]);
    const localized = names(["未使用", "巨型深海奇美拉"]);
    const patched = patchLocalizedNamedDat(
      english,
      localized,
      [quote("Craicic Chimeral", "3d")],
      { namePointerOffset: NAME_OFFSET },
      "efarm",
    );
    expect(patched.matchedRows).toEqual([1]);
    expect(parseNamedDatRows(patched.buffer, { namePointerOffset: NAME_OFFSET }).map((row) => row.name)).toEqual([
      "未使用",
      "巨型深海奇美拉[3d]",
    ]);
  });

  it("外键限定行不会清理或修改其他怪物名", () => {
    const english = names(["Ordinary Monster", "Fenumal Plagued Arachnid"]);
    const localized = names(["普通怪物 · 10c", "芬姆疫病蜘蛛[20c]"]);
    const rows = referencedRowIndexes(references([1, 1, 1, 1]), 2);
    expect(rows).toEqual([1]);
    const cleaned = cleanLocalizedNamedDat(localized, { namePointerOffset: NAME_OFFSET, rowIndexes: rows });
    expect(cleaned.changedCount).toBe(1);
    expect(parseNamedDatRows(cleaned.buffer, { namePointerOffset: NAME_OFFSET }).map((row) => row.name)).toEqual([
      "普通怪物 · 10c",
      "芬姆疫病蜘蛛",
    ]);

    const patched = patchLocalizedNamedDat(english, cleaned.buffer, [quote("Ordinary Monster", "1c")], {
      namePointerOffset: NAME_OFFSET,
      rowIndexes: rows,
    });
    expect(patched.matchedCount).toBe(0);
  });

  it("扩展 DAT 可按易刷中文名匹配，并优先于 poe.ninja 英文价", () => {
    const english = names(["Unused", "Craicic Chimeral"]);
    const localized = names(["未使用", "巨型深海奇美拉"]);
    const patched = patchLocalizedNamedDat(english, localized, [
      quote("Craicic Chimeral", "3d"),
      quote("", "80c", "巨型深海奇美拉", "efarm"),
    ], { namePointerOffset: NAME_OFFSET });

    expect(parseNamedDatRows(patched.buffer, { namePointerOffset: NAME_OFFSET })[1].name)
      .toBe("巨型深海奇美拉 · 80c");
  });

  it("只接受已选名称行的价格后缀变化", () => {
    const english = names(["Unused", "Locus of Corruption"]);
    const baseline = names(["未使用", "腐化之室"]);
    const options = { namePointerOffset: NAME_OFFSET, rowIndexes: [1] };
    const candidate = patchLocalizedNamedDat(english, baseline, [quote("Locus of Corruption", "2d")], options).buffer;
    expect(isPriceSuffixOnlyNamedDatVariant(baseline, candidate, options)).toBe(true);

    const changedOtherRow = Buffer.from(candidate);
    changedOtherRow[4] = 1;
    expect(isPriceSuffixOnlyNamedDatVariant(baseline, changedOtherRow, options)).toBe(false);
  });
});
