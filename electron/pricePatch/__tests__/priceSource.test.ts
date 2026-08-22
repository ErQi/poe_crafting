import { describe, expect, it } from "vitest";
import { formatPrice, parsePriceSummary, parseSourceTime } from "../priceSource";

const NOW = Date.parse("2026-08-20T12:30:00Z"); // 北京时间 20:30

function item(patch: Record<string, unknown> = {}) {
  return {
    item_name: "神圣石",
    engname: "Divine Orb",
    sell_avg: 123.4,
    latest_sell1: 125,
    latest_datetime: "2026-08-20 20:00:00",
    error: false,
    currency_unit: "c",
    ...patch,
  };
}

describe("poecurrency.top 行情解析", () => {
  it("使用文档约定的东八区时间并过滤超过 24 小时的数据", () => {
    expect(parseSourceTime("2026-08-20 20:00:00")).toBe(Date.parse("2026-08-20T20:00:00+08:00"));
    const snapshot = parsePriceSummary(
      [{ category_label: "通货", items: [item(), item({ item_name: "旧物品", latest_datetime: "2026-08-19 19:59:59" })] }],
      NOW,
    );
    expect(snapshot.quotes).toHaveLength(1);
    expect(snapshot.quotes[0]).toMatchObject({ itemName: "神圣石", display: "125c" });
  });

  it("异常数据被跳过，且只接受最新卖1", () => {
    const snapshot = parsePriceSummary(
      [
        {
          category_label: "通货",
          items: [
            item({ item_name: "异常", error: true }),
            item({ item_name: "仅有均价", latest_sell1: 0 }),
            item({ item_name: "崇高石", engname: "Exalted Orb", sell_avg: 999, latest_sell1: 6.66 }),
          ],
        },
      ],
      NOW,
    );
    expect(snapshot.quotes).toHaveLength(1);
    expect(snapshot.quotes[0].display).toBe("6.7c");
  });

  it("价格显示保持短小", () => {
    expect(formatPrice(0.91, "d")).toBe("0.9d");
    expect(formatPrice(1, "d")).toBe("1d");
    expect(formatPrice(18.7, "c")).toBe("19c");
  });

  it("可解析琪莎拉纪念币的最新卖1", () => {
    const snapshot = parsePriceSummary(
      [
        {
          category_label: "赛季通货",
          items: [item({ item_name: "琪莎拉纪念币", engname: "Kishara's Ducat", latest_sell1: 5 })],
        },
      ],
      NOW,
    );
    expect(snapshot.quotes[0]).toMatchObject({
      itemName: "琪莎拉纪念币",
      englishName: "Kishara's Ducat",
      display: "5c",
    });
  });
});
