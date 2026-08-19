import {
  CompareOp,
  GroupMatchResult,
  Item,
  MatchMode,
  MatchResult,
  MatchRule,
  RuleGroup,
  RuleHit,
  RuleSet,
} from "./models";

export function parseThresholdText(text: string): [number | null, number | null] {
  const raw = (text || "").trim();
  if (!raw) return [null, null];
  const parts = raw.split(/\s*(?:-|—|–|到|至)\s*/).filter((p) => p !== "");
  if (parts.length >= 2) {
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return [null, null];
    return [a, b];
  }
  const n = Number(raw);
  return Number.isFinite(n) ? [n, null] : [null, null];
}

export function formatThresholdText(threshold: number | null, threshold2: number | null = null): string {
  if (threshold == null && threshold2 == null) return "";
  if (threshold == null) return `${threshold2}`;
  if (threshold2 == null) return `${threshold}`;
  return `${threshold}-${threshold2}`;
}

export function splitPatternKeywords(pattern: string): string[] {
  const raw = (pattern || "").trim();
  if (!raw) return [];
  const parts = raw.split(/[,，;；|]+/).map((p) => p.trim()).filter(Boolean);
  const keywords: string[] = [];
  for (const part of parts) keywords.push(...part.split(/\s+/).filter(Boolean));
  return keywords;
}

function affixHasKeywords(text: string, keywords: string[]): boolean {
  if (!keywords.every((k) => text.includes(k))) return false;
  // 「元素伤害提高」是「攻击技能的元素伤害提高」的子串，泛匹配时排除后者。
  if (keywords.length === 1 && keywords[0] === "元素伤害提高" && text.includes("攻击技能")) return false;
  return true;
}

function compare(actual: number, op: string, threshold: number): boolean {
  if (op === CompareOp.GE || op === "≥") return actual >= threshold;
  if (op === CompareOp.GT || op === ">") return actual > threshold;
  if (op === CompareOp.LE || op === "≤") return actual <= threshold;
  if (op === CompareOp.LT || op === "<") return actual < threshold;
  if (op === CompareOp.EQ || op === "==" || op === "＝") return Math.abs(actual - threshold) < 1e-9;
  return false;
}

export function matchRule(item: Item, rule: MatchRule): RuleHit {
  if (!rule.enabled) return new RuleHit({ rule, matched: true, reason: "disabled" });
  const keywords = splitPatternKeywords((rule.pattern || "").trim());
  if (!keywords.length) return new RuleHit({ rule, matched: false, reason: "空规则" });

  let op = (rule.operator || "").trim();
  op = ({ "≥": ">=", "≤": "<=", "＝": "=", "＞": ">", "＜": "<" } as Record<string, string>)[op] || op;
  const needValue = Boolean(op && (rule.threshold != null || rule.threshold2 != null));
  const candidates: RuleHit[] = [];

  for (const affix of item.affixes) {
    if (!affixHasKeywords(affix.text, keywords)) continue;
    if (!needValue) {
      return new RuleHit({
        rule,
        matched: true,
        matchedAffix: affix.text,
        actualValue: affix.firstValue,
        actualValues: [...affix.values],
        reason: "文本匹配",
      });
    }
    if (!affix.values.length) continue;
    let firstOk = true;
    if (rule.threshold != null) {
      if (affix.firstValue == null) continue;
      firstOk = compare(affix.firstValue, op, rule.threshold);
    }
    let secondOk = true;
    if (rule.threshold2 != null) {
      if (affix.secondValue == null) continue;
      secondOk = compare(affix.secondValue, op, rule.threshold2);
    }
    const ok = firstOk && secondOk;
    candidates.push(
      new RuleHit({
        rule,
        matched: ok,
        matchedAffix: affix.text,
        actualValue: affix.firstValue,
        actualValues: [...affix.values],
        reason: ok ? "数值匹配" : "数值未达标",
      }),
    );
  }

  if (!candidates.length) {
    return new RuleHit({ rule, matched: false, reason: "未找到同时包含这些关键字的词缀" });
  }
  const successes = candidates.filter((h) => h.matched);
  const pool = successes.length ? successes : candidates;
  const reverse = op === ">=" || op === ">" || op === CompareOp.GE || op === CompareOp.GT;
  return pool.reduce((best, hit) => {
    const bestHas = best.actualValue != null;
    const hitHas = hit.actualValue != null;
    if (hitHas !== bestHas) return hitHas ? hit : best;
    const bv = best.actualValue ?? 0;
    const hv = hit.actualValue ?? 0;
    return (reverse ? hv > bv : hv < bv) ? hit : best;
  });
}

export function matchGroup(item: Item, group: RuleGroup): GroupMatchResult {
  const enabled = group.rules.filter((r) => r.enabled && (r.pattern || "").trim());
  const hits: RuleHit[] = [];
  for (const r of enabled) {
    const h = matchRule(item, r);
    h.groupId = group.id;
    h.groupName = group.name;
    hits.push(h);
  }
  if (!enabled.length) return new GroupMatchResult(group, false, hits);
  const matchedN = hits.filter((h) => h.matched).length;
  let success: boolean;
  if (group.minMatches) success = matchedN >= group.minMatches;
  else if (group.combine === MatchMode.ANY) success = matchedN >= 1;
  else success = matchedN === hits.length;
  return new GroupMatchResult(group, success, hits);
}

export function matchRuleset(item: Item, ruleset: RuleSet): MatchResult {
  const groups = ruleset.groups.filter((g) => g.enabled);
  if (!groups.length) {
    return new MatchResult({ success: false, mode: ruleset.groupCombine, hits: [], groupResults: [] });
  }
  const groupResults = groups.map((g) => matchGroup(item, g));
  const active = groupResults.filter((gr) => gr.hits.length);
  if (!active.length) {
    return new MatchResult({ success: false, mode: ruleset.groupCombine, hits: [], groupResults });
  }
  const success =
    ruleset.groupCombine === MatchMode.ANY
      ? active.some((gr) => gr.success)
      : active.every((gr) => gr.success);
  return new MatchResult({
    success,
    mode: ruleset.groupCombine,
    hits: groupResults.flatMap((gr) => gr.hits),
    groupResults,
  });
}

export function normalizeOperator(op: string): string {
  const mapping: Record<string, string> = {
    "": "",
    ">=": ">=",
    "≥": ">=",
    ">": ">",
    "＞": ">",
    "<=": "<=",
    "≤": "<=",
    "<": "<",
    "＜": "<",
    "=": "=",
    "==": "=",
    "＝": "=",
    无: "",
    none: "",
  };
  const key = (op || "").trim();
  return key in mapping ? mapping[key] : key;
}
