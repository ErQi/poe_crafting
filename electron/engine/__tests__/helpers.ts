import fs from "fs";
import path from "path";
import { matchRuleset } from "../matcher";
import { Item, MatchMode, MatchResult, MatchRule, RuleGroup, RuleSet } from "../models";
import type { WindowInfo } from "../win32";

const SAMPLES = path.join(__dirname, "samples");

export function readSample(name: string): string {
  return fs.readFileSync(path.join(SAMPLES, name), "utf8");
}

/** 最小可解析的装备文本：只关心稀有度和词缀时用它，省得每次手写整段 tooltip。 */
export function itemText(rarity: string, ...affixes: string[]): string {
  return [
    `稀有度: ${rarity}`,
    "测试之冠",
    "威武皮盔",
    "--------",
    "物品等级: 100",
    "--------",
    affixes.join("\n"),
    "--------",
    "已鉴定",
  ].join("\n");
}

/** 引擎只暴露 matchRuleset；一组扁平规则要先包成单个规则组才能匹配。 */
export function matchItem(item: Item, rules: MatchRule[], mode: string = MatchMode.ALL): MatchResult {
  if (!rules.some((r) => r.enabled)) return new MatchResult({ success: false, mode, hits: [] });
  const group = new RuleGroup({ name: "默认", combine: mode, rules: [...rules] });
  return matchRuleset(item, new RuleSet({ groupCombine: MatchMode.ALL, groups: [group] }));
}

/** 客户区左上角在 (left, top)，宽高由 right/bottom 推出；仓库格坐标只吃高度。 */
export function makeWindow(width: number, height: number, left = 0, top = 0): WindowInfo {
  return {
    hwnd: 1n,
    title: "Path of Exile",
    left,
    top,
    right: left + width,
    bottom: top + height,
  };
}
