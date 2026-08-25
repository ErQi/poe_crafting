import { describe, expect, it } from "vitest";
import { detectRarity, MapFilter, modsLineCount } from "../mapFilter";

describe("MapFilter 过滤语义（对照洗地图.ahk）", () => {
  it("默认区：关键字出现即满足", () => {
    const text = "物品数量: +120%\n地图等级: 83\n超越怪物";
    expect(MapFilter.matches(text, "比魔怪物")[0]).toBe(false);
    expect(MapFilter.matches(text, "超越怪物")[0]).toBe(true);
  });

  it("数值比较：取该行首个数字参与判断", () => {
    const text = "物品数量: +125%\n魔法怪物数量: +40%";
    expect(MapFilter.matches(text, "物品数量 > 100")[0]).toBe(true);
    expect(MapFilter.matches(text, "物品数量 >= 130")[0]).toBe(false);
    expect(MapFilter.matches(text, "魔法怪物数量 < 50")[0]).toBe(true);
  });

  it("! 开头 = 不想要的词缀", () => {
    const text = "物品数量: +120%\n元素之印";
    expect(MapFilter.matches(text, "!元素之印")[0]).toBe(false);
    expect(MapFilter.matches(text, "!额外怪物")[0]).toBe(true);
  });

  it("## 分区：任一判断区满足即整体成功，默认区必须全满足", () => {
    const text = "物品数量: +120%\n超越怪物";
    // 默认区满足 + 任一 ## 区满足 → 成功
    expect(MapFilter.matches(text, "物品数量 > 100\n##\n超越怪物")[0]).toBe(true);
    // 默认区不满足但判断区满足 → 仍需默认区
    expect(MapFilter.matches(text, "物品数量 > 500\n##\n超越怪物")[0]).toBe(false);
    // 无 ## 区满足 → 失败
    expect(MapFilter.matches(text, "##\n没有的词条")[0]).toBe(false);
  });

  it("// 注释与空行被忽略", () => {
    const text = "物品数量: +120%";
    const filter = ["// 注释行", "", "物品数量 > 100"].join("\n");
    expect(MapFilter.matches(text, filter)[0]).toBe(true);
  });
});

describe("modsLineCount / detectRarity", () => {
  it("统计显式词缀行，跳过元数据", () => {
    const text = [
      "物品类别: 地图",
      "稀 有 度: 稀有",
      "--------",
      "超越怪物",
      "物品数量: +120%",
      "--------",
      "物品等级: 83",
      "地图等级: 83",
    ].join("\n");
    expect(modsLineCount(text)).toBe(2);
  });

  it("识别稀有度", () => {
    expect(detectRarity("稀 有 度: 稀有")).toBe("稀有");
    expect(detectRarity("稀有度: 魔法")).toBe("魔法");
    expect(detectRarity("一堆无关文本")).toBe("普通");
  });
});