import { describe, expect, it, vi } from "vitest";
import {
  formatPrice,
  mergePriceSnapshots,
  parseNinjaExchangeOverview,
  parseNinjaItemOverview,
  parseNinjaLeague,
  parsePriceSummary,
  parseSourceTime,
  PoeCurrencyPriceSource,
  POE_CURRENCY_SUMMARY_URL,
  POE_NINJA_EXCHANGE_TYPES,
  POE_NINJA_ITEM_TYPES,
  POE_NINJA_LEAGUES_URL,
  POE_NINJA_STASH_ITEM_TYPES,
  POE_NINJA_UNIQUE_ITEM_TYPES,
} from "../priceSource";
import type { PriceSnapshot } from "../types";

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
    expect(snapshot.quotes[0]).toMatchObject({ itemName: "神圣石", display: "125c", source: "poecurrency" });
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

describe("poe.ninja 兜底行情", () => {
  const SOURCE_TIME = "2026-08-20T12:20:00.000Z";

  it("覆盖官方 POE1 的 18 个兑换类别和 28 个仓库类别", () => {
    expect(POE_NINJA_EXCHANGE_TYPES).toHaveLength(18);
    expect(new Set(POE_NINJA_ITEM_TYPES)).toEqual(new Set([
      "Wombgift",
      "Corpse",
      "Incubator",
      "UniqueWeapon",
      "UniqueArmour",
      "UniqueAccessory",
      "UniqueFlask",
      "UniqueJewel",
      "ForbiddenJewel",
      "ShrineBelt",
      "UniqueTincture",
      "UniqueRelic",
      "SkillGem",
      "ImbuedGem",
      "ClusterJewel",
      "Map",
      "BlightedMap",
      "BlightRavagedMap",
      "UniqueMap",
      "ValdoMap",
      "Invitation",
      "Memory",
      "IncursionTemple",
      "ScryingOrb",
      "BaseType",
      "Flask",
      "Beast",
      "Vial",
    ]));
    expect(POE_NINJA_ITEM_TYPES).toHaveLength(28);
    expect(new Set([...POE_NINJA_STASH_ITEM_TYPES, ...POE_NINJA_UNIQUE_ITEM_TYPES]).size).toBe(28);
  });

  it("使用联盟接口第一项作为当前赛季", () => {
    expect(parseNinjaLeague([{ id: "Allflame", name: "Allflame" }, { id: "Standard" }])).toBe("Allflame");
    expect(() => parseNinjaLeague([])).toThrow("当前赛季");
  });

  it("按元数据名称解析兑换行情，并在价格较高时改用神圣石显示", () => {
    const quotes = parseNinjaExchangeOverview(
      {
        core: { primary: "chaos", rates: { divine: 0.005 } },
        items: [
          { id: "divine", name: "Divine Orb" },
          { id: "missing-line", name: "Missing Line" },
        ],
        lines: [
          { id: "divine", primaryValue: 250 },
          { id: "missing-name", primaryValue: 5 },
        ],
      },
      "Currency",
      SOURCE_TIME,
    );
    expect(quotes).toEqual([
      expect.objectContaining({
        englishName: "Divine Orb",
        display: "1.3d",
        source: "poe-ninja",
        sourceTime: SOURCE_TIME,
      }),
    ]);
  });

  it("同名仓库行情只保留挂单量最高的代表价格", () => {
    const quotes = parseNinjaItemOverview(
      {
        lines: [
          { name: "Ancient Wombgift", chaosValue: 30, listingCount: 5, count: 5, detailsId: "rare" },
          { name: "Ancient Wombgift", chaosValue: 15, listingCount: 200, count: 100, detailsId: "common" },
          { name: "Broken", chaosValue: 0, listingCount: 999 },
        ],
      },
      "Wombgift",
      SOURCE_TIME,
    );
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ englishName: "Ancient Wombgift", display: "15c" });
  });

  it("把动态词缀、地图阶级和禁断珠宝折叠到客户端稳定名称", () => {
    const cluster = parseNinjaItemOverview(
      { lines: [
        { name: "12% increased Chaos Damage", baseType: "Large Cluster Jewel", chaosValue: 40, listingCount: 3 },
        { name: "12% increased Fire Damage", baseType: "Large Cluster Jewel", chaosValue: 8, listingCount: 50 },
      ] },
      "ClusterJewel",
      SOURCE_TIME,
    );
    expect(cluster).toEqual([expect.objectContaining({ englishName: "Large Cluster Jewel", display: "8c" })]);

    const map = parseNinjaItemOverview(
      { lines: [{ name: "Veritania Vaal Temple Map", baseType: "Vaal Temple Map", chaosValue: 84, listingCount: 26 }] },
      "Map",
      SOURCE_TIME,
    );
    expect(map[0]).toMatchObject({ englishName: "Vaal Temple Map", display: "84c" });

    const blighted = parseNinjaItemOverview(
      { lines: [{ name: "Blighted Map (Tier 16)", chaosValue: 23, listingCount: 561 }] },
      "BlightedMap",
      SOURCE_TIME,
    );
    expect(blighted[0]).toMatchObject({ englishName: "Blighted Map", display: "23c" });

    const forbidden = parseNinjaItemOverview(
      { lines: [{ name: "Vile Bastion", variant: "Forbidden Flesh", chaosValue: 100, listingCount: 8 }] },
      "ForbiddenJewel",
      SOURCE_TIME,
    );
    expect(forbidden[0]).toMatchObject({ englishName: "Forbidden Flesh", display: "100c" });
  });

  it("寺庙房间去掉 API 阶级后缀，占星球折叠到物品基底", () => {
    const temple = parseNinjaItemOverview(
      { lines: [{ name: "Locus of Corruption (Tier 3)", baseType: "Chronicle of Atzoatl", chaosValue: 379 }] },
      "IncursionTemple",
      SOURCE_TIME,
    );
    expect(temple[0]).toMatchObject({ englishName: "Locus of Corruption", display: "379c" });

    const scrying = parseNinjaItemOverview(
      { lines: [{ name: "Vaal Pyramid", baseType: "Scrying Orb", chaosValue: 840 }] },
      "ScryingOrb",
      SOURCE_TIME,
    );
    expect(scrying[0]).toMatchObject({ englishName: "Scrying Orb", display: "840c" });
  });

  it("瓦尔异化宝石的组合行名回退到可显示的宝石基底", () => {
    const quotes = parseNinjaItemOverview(
      { lines: [{
        name: "Vaal Cyclone (Cyclone of Tumult)",
        baseType: "Vaal Cyclone",
        chaosValue: 20,
        listingCount: 187,
      }] },
      "SkillGem",
      SOURCE_TIME,
    );
    expect(quotes[0]).toMatchObject({ englishName: "Vaal Cyclone", display: "20c" });
  });

  it("唯一饰品进入抓取类别，并解析乌扎萨的高山代表价", () => {
    expect(POE_NINJA_UNIQUE_ITEM_TYPES).toContain("UniqueAccessory");
    const quotes = parseNinjaItemOverview(
      {
        lines: [
          {
            name: "Uzaza's Mountain",
            baseType: "Sapphire Ring",
            chaosValue: 90,
            divineValue: 0.45,
            listingCount: 400,
            count: 314,
            detailsId: "uzazas-mountain-sapphire-ring",
          },
        ],
      },
      "UniqueAccessory",
      SOURCE_TIME,
    );
    expect(quotes).toEqual([
      expect.objectContaining({
        englishName: "Uzaza's Mountain",
        category: "poe.ninja UniqueAccessory",
        display: "90c",
        source: "poe-ninja",
      }),
    ]);
  });

  it("合并时逐物品保留国服价，只为缺失物品加入忍者网价", () => {
    const primary = parsePriceSummary([{ category_label: "通货", items: [item()] }], NOW);
    const fallbackQuotes = parseNinjaExchangeOverview(
      {
        core: { primary: "chaos", rates: { divine: 0.005 } },
        items: [
          { id: "divine", name: "Divine Orb" },
          { id: "chaos", name: "Chaos Orb" },
        ],
        lines: [
          { id: "divine", primaryValue: 200 },
          { id: "chaos", primaryValue: 1 },
        ],
      },
      "Currency",
      SOURCE_TIME,
    );
    const fallback: PriceSnapshot = {
      fetchedAt: SOURCE_TIME,
      sourceUpdatedAt: SOURCE_TIME,
      digest: "fallback",
      quotes: fallbackQuotes,
    };
    const merged = mergePriceSnapshots(primary, fallback, NOW);
    expect(merged.quotes.map((quote) => [quote.englishName, quote.display, quote.source])).toEqual([
      ["Divine Orb", "125c", "poecurrency"],
      ["Chaos Orb", "1c", "poe-ninja"],
    ]);
  });

  it("实际抓取链路动态使用当前赛季，并在入口完成优先级合并", async () => {
    const response = (payload: unknown) => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === "date" ? "Thu, 20 Aug 2026 12:20:00 GMT" : null) },
      json: async () => payload,
    });
    const request = vi.fn(async (url: string) => {
      if (url === POE_CURRENCY_SUMMARY_URL) return response([{ category_label: "通货", items: [item()] }]);
      if (url === POE_NINJA_LEAGUES_URL) return response([{ id: "Allflame", name: "Allflame" }]);
      if (url.includes("/exchange/") && url.includes("type=Currency")) {
        return response({
          core: { primary: "chaos", rates: { divine: 0.005 } },
          items: [
            { id: "divine", name: "Divine Orb" },
            { id: "chaos", name: "Chaos Orb" },
          ],
          lines: [
            { id: "divine", primaryValue: 200 },
            { id: "chaos", primaryValue: 1 },
          ],
        });
      }
      if (url.includes("/exchange/")) {
        return response({ core: { primary: "chaos", rates: { divine: 0.005 } }, items: [], lines: [] });
      }
      return response({ lines: [] });
    });

    const snapshot = await new PoeCurrencyPriceSource(request).fetch(NOW);
    expect(request.mock.calls.some(([url]) => String(url).includes("league=Allflame"))).toBe(true);
    expect(request.mock.calls.some(([url]) => String(url).includes("type=UniqueAccessory"))).toBe(true);
    expect(snapshot.quotes.map((quote) => [quote.englishName, quote.display, quote.source])).toEqual([
      ["Divine Orb", "125c", "poecurrency"],
      ["Chaos Orb", "1c", "poe-ninja"],
    ]);
  });
});
