import { describe, expect, it } from "vitest";
import { CURRENCY_BY_LABEL, currencyLabel } from "../currencies";
import { currencyCellHit, currencySlotCandidates } from "../stashGrid";
import type { MatchHit } from "../vision";
import { makeWindow } from "./helpers";

const win4k = makeWindow(3840, 2160);

/**
 * 4K 全屏客户区的标定值（对照 assets/templates/PixPin_2026-08-19_01-43-08.jpg）：
 * 主格网第 1 行中心 y=548、第 1 列中心 x=108，列距 112、行距 132。
 * 这里用 1 基行列书写，和「改造石在第 1 行第 2 列」这种说法对齐。
 */
function cellCenter4K(mainRow: number, col: number): { clientX: number; clientY: number } {
  return { clientX: 108 + (col - 1) * 112, clientY: 548 + (mainRow - 1) * 132 };
}

function slotOf(label: string): MatchHit {
  const definition = CURRENCY_BY_LABEL[label];
  expect(definition, `${label} 应是内置通货`).toBeTruthy();
  const candidates = currencySlotCandidates(win4k, definition.templateName);
  expect(candidates.length, `${label} 应有仓库格候选`).toBeGreaterThan(0);
  // 首个候选就是该通货自己的格子，其余是相邻格
  return candidates[0];
}

// 曾经把「改造石」和「工匠石」标反过，所以这里按中文名反查模板名再断言坐标：
// 无论是 CURRENCY_CELLS 里的行列写错，还是 currencies.ts 里的中文名标错，都会挂。
describe("通货仓库格标定", () => {
  it("改造石在主格网第 1 行第 2 列", () => {
    expect(slotOf("改造石")).toMatchObject(cellCenter4K(1, 2));
  });

  it("工匠石在主格网第 3 行第 2 列", () => {
    expect(slotOf("工匠石")).toMatchObject(cellCenter4K(3, 2));
  });

  it("工匠石与制图石是两个不同的格子", () => {
    expect(currencyLabel("currency_jewellers")).toBe("工匠石");
    expect(currencyLabel("currency_chisel")).toBe("制图石");
    expect(slotOf("制图石")).toMatchObject(cellCenter4K(2, 2));
    expect(slotOf("工匠石").clientY).not.toBe(slotOf("制图石").clientY);
  });

  it("4K 全屏时改造石中心是 (220, 548)", () => {
    const hit = slotOf("改造石");
    expect([hit.clientX, hit.clientY]).toEqual([220, 548]);
    expect([hit.screenX, hit.screenY]).toEqual([220, 548]);
    expect(hit.width).toBe(112);
    expect(hit.height).toBe(112);
  });

  it("流程会用到的通货坐标全部锁定", () => {
    const expected: [string, number, number][] = [
      ["蜕变石", 108, 548],
      ["改造石", 220, 548],
      ["增幅石", 444, 680],
      ["富豪石", 892, 548],
      ["重铸石", 892, 812],
    ];
    for (const [label, x, y] of expected) {
      const hit = slotOf(label);
      expect([label, hit.clientX, hit.clientY]).toEqual([label, x, y]);
    }
  });

  it("所有内置格子互不重叠", () => {
    const seen = new Map<string, string>();
    for (const label of Object.keys(CURRENCY_BY_LABEL)) {
      const candidates = currencySlotCandidates(win4k, CURRENCY_BY_LABEL[label].templateName);
      if (!candidates.length) continue;
      const key = `${candidates[0].clientX},${candidates[0].clientY}`;
      expect(seen.has(key), `${label} 与 ${seen.get(key)} 落在同一格 ${key}`).toBe(false);
      seen.set(key, label);
    }
  });
});

describe("按窗口高度等比换算", () => {
  it("1080p 是 4K 的一半", () => {
    const win = makeWindow(1920, 1080);
    const hit = currencySlotCandidates(win, "currency_alteration")[0];
    expect([hit.clientX, hit.clientY]).toEqual([110, 274]);
    expect(hit.width).toBe(56);
  });

  it("1440p 按 2/3 换算", () => {
    const win = makeWindow(2560, 1440);
    const hit = currencySlotCandidates(win, "currency_alteration")[0];
    expect([hit.clientX, hit.clientY]).toEqual([147, 365]);
    expect(hit.width).toBe(75);
  });

  it("只吃高度：同高不同宽（超宽屏）得到相同的客户区坐标", () => {
    const wide = currencySlotCandidates(makeWindow(3440, 1440), "currency_alteration")[0];
    const normal = currencySlotCandidates(makeWindow(2560, 1440), "currency_alteration")[0];
    expect([wide.clientX, wide.clientY]).toEqual([normal.clientX, normal.clientY]);
  });

  it("各分辨率下 中心/高度 的比值保持一致", () => {
    for (const height of [1080, 1440, 1600, 2160]) {
      const hit = currencySlotCandidates(makeWindow(Math.round(height * 1.78), height), "currency_alteration")[0];
      expect(hit.clientX / height).toBeCloseTo(220 / 2160, 3);
      expect(hit.clientY / height).toBeCloseTo(548 / 2160, 3);
    }
  });

  it("窗口模式下客户区坐标不变，屏幕坐标加上窗口原点", () => {
    const hit = currencySlotCandidates(makeWindow(1920, 1080, 100, 50), "currency_alteration")[0];
    expect([hit.clientX, hit.clientY]).toEqual([110, 274]);
    expect([hit.screenX, hit.screenY]).toEqual([210, 324]);
  });
});

describe("越界保护", () => {
  it("窗口尺寸无效时不给坐标", () => {
    expect(currencyCellHit(makeWindow(0, 0), "x", 0, 1)).toBeNull();
    expect(currencySlotCandidates(makeWindow(0, 0), "currency_alteration")).toEqual([]);
  });

  it("超出仓库格网的行不给坐标", () => {
    expect(currencyCellHit(win4k, "x", -2, 1)).toBeNull();
    expect(currencyCellHit(win4k, "x", 4, 1)).toBeNull();
    expect(currencyCellHit(win4k, "x", -1, 1)).not.toBeNull();
    expect(currencyCellHit(win4k, "x", 3, 1)).not.toBeNull();
  });

  it("窗口太窄导致格心落在窗口外时不给坐标", () => {
    const narrow = makeWindow(600, 2160);
    expect(currencyCellHit(narrow, "x", 0, 0)).not.toBeNull();
    expect(currencyCellHit(narrow, "x", 0, 9)).toBeNull();
    expect(currencySlotCandidates(makeWindow(1000, 2160), "currency_chaos")).toEqual([]);
  });

  it("未收录的模板名没有候选格", () => {
    expect(currencySlotCandidates(win4k, "item_slot")).toEqual([]);
    expect(currencySlotCandidates(win4k, "currency_unknown")).toEqual([]);
  });
});

describe("候选格包含相邻格", () => {
  it("四邻都在格网内时给 5 个候选，首个是自己", () => {
    const hits = currencySlotCandidates(win4k, "currency_alteration");
    expect(hits.length).toBe(5);
    expect([hits[0].clientX, hits[0].clientY]).toEqual([220, 548]);
  });

  it("贴边的格子只给存在的邻居", () => {
    // [0,0]：左边没有列
    expect(currencySlotCandidates(win4k, "currency_transmutation").length).toBe(4);
    // [3,7]：下面没有行
    expect(currencySlotCandidates(win4k, "currency_regret").length).toBe(4);
    // [-1,1]：上面没有行
    expect(currencySlotCandidates(win4k, "currency_wisdom").length).toBe(4);
  });

  it("候选格坐标互不重复", () => {
    for (const name of ["currency_alteration", "currency_transmutation", "currency_regal", "currency_scouring"]) {
      const hits = currencySlotCandidates(win4k, name);
      const keys = hits.map((h) => `${h.clientX},${h.clientY}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("候选格都带上模板名与满分，便于走通用的 MatchHit 流程", () => {
    for (const hit of currencySlotCandidates(win4k, "currency_alteration")) {
      expect(hit.name).toBe("currency_alteration");
      expect(hit.score).toBe(1);
    }
  });
});
