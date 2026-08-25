/**
 * 洗地图「想要词条」过滤 —— 纯逻辑模块（不依赖 electron / koffi），可独立单测。
 * 语义完全对照 洗地图.ahk / map_washer.py：
 *  - 空行与 // 开头为注释，忽略
 *  - 最上方（到第一个 ## 之前）为「默认区」，必须全部满足
 *  - 每个 ## 之后为一个判断区；任一判断区内所有词条满足即整体成功
 *  - ! 开头 = 不想要的词缀（出现即该条不满足/重洗）
 *  - "词条名 > 数字" 等 = 数值比较（文本里该词条的具体数值参与比较）
 *  - 其余行 = 词条关键字，文本中出现即满足
 *
 * 说明：地图基底为 深渊平原 / 海底林地 / 海底山脊 之外的「非常规基底」时，
 * 按需在过滤文本里自行加条件处理；代码不内置自动通过逻辑（严格按 AHK）。
 */

export interface MapFilterRule {
  type: "banned" | "compare" | "has";
  name: string;
  op?: string;
  value?: number;
}

function extractNumber(s: string): number | "" {
  const cleaned = s.replace(/%/g, "").replace(/,/g, "");
  const m = cleaned.match(/[+-]?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : "";
}

export class MapFilter {
  private static parseRule(s: string): MapFilterRule {
    if (s.startsWith("!")) return { type: "banned", name: s.slice(1).trim() };
    const m = s.match(/^(.*?)\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) return { type: "compare", name: m[1], op: m[2], value: Number(m[3]) };
    return { type: "has", name: s };
  }

  private static parseSections(filter: string): MapFilterRule[][] {
    const sections: MapFilterRule[][] = [];
    let cur: MapFilterRule[] = [];
    for (const raw of String(filter || "").split("\n")) {
      const s = raw.trim();
      if (!s || s.startsWith("//")) continue;
      if (s.startsWith("##")) {
        sections.push(cur);
        cur = [];
        continue;
      }
      cur.push(this.parseRule(s));
    }
    sections.push(cur);
    return sections;
  }

  private static opCompare(a: number, op: string, b: number): boolean {
    switch (op) {
      case ">":
        return a > b;
      case "<":
        return a < b;
      case ">=":
        return a >= b;
      case "<=":
        return a <= b;
      case "==":
        return a === b;
      case "!=":
        return a !== b;
      default:
        return false;
    }
  }

  private static ruleOk(rule: MapFilterRule, text: string): boolean {
    if (rule.type === "banned") return !text.includes(rule.name);
    if (rule.type === "has") return text.includes(rule.name);
    for (const line of String(text || "").split("\n")) {
      if (line.includes(rule.name)) {
        const num = extractNumber(line);
        if (num !== "" && this.opCompare(num, rule.op ?? "", rule.value ?? 0)) return true;
      }
    }
    return false;
  }

  /** 返回 [是否成功, 说明] */
  static matches(text: string, filter: string): [boolean, string] {
    const sections = this.parseSections(filter);
    const defOK = sections[0].every((r) => this.ruleOk(r, text));
    if (sections.length === 1) return [defOK, defOK ? "默认✓" : "默认✗"];
    for (let zi = 1; zi < sections.length; zi++) {
      if (sections[zi].every((r) => this.ruleOk(r, text))) {
        return [defOK, `默认${defOK ? "✓" : "✗"} 区${zi}✓`];
      }
    }
    return [false, `默认${defOK ? "✓" : "✗"} 无区满足`];
  }
}

/** 词缀条数（用于崇高E满：显式词缀 <6 则补崇高）。统计方式与洗地图.ahk 的 ModsLineCount 一致。 */
export function modsLineCount(text: string): number {
  let n = 0;
  for (const raw of String(text || "").split("\n")) {
    const s = raw.trim();
    if (
      !s ||
      s.includes("--------") ||
      s.includes("稀 有 度") ||
      s.includes("需求") ||
      s.includes("物品等级") ||
      s.includes("地图等级") ||
      s.includes("物品类别") ||
      s.includes("堆叠数量")
    ) {
      continue;
    }
    n++;
  }
  return n;
}

export function detectRarity(text: string): string {
  const s = String(text || "");
  if (s.includes("稀 有 度: 稀有") || s.includes("稀有度: 稀有")) return "稀有";
  if (s.includes("稀 有 度: 魔法") || s.includes("稀有度: 魔法")) return "魔法";
  return "普通";
}