import { Affix, Item } from "./models";

export class ItemParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItemParseError";
  }
}

const SECTION_SEP = /^-{3,}\s*$/;
const NUMBER_RE =
  /(?:(?<=^)|(?<=\s)|(?<=\+)|(?<=，)|(?<=,)|(?<=:)|(?<=：))[+-]?(?:\d+(?:\.\d+)?|\.\d+)|(?:\d+(?:\.\d+)?|\.\d+)/g;
const RANGE_IN_PARENS_RE = /\([^)]*\)/g;

const HEADER_KEYS = ["物品类别:", "稀有度:", "物品等级:", "品质:", "插槽:", "需求:"];
const SKIP_LINE_PREFIXES = [
  "物品类别:",
  "需求:",
  "等级:",
  "力量:",
  "敏捷:",
  "智慧:",
  "品质:",
  "插槽:",
  "物品等级:",
  "堆叠数量:",
  "地图等级:",
  "怪物包大小:",
  "物品数量:",
  "物品稀有度:",
  "等级需求:",
  "出售获得通货:",
  "点击右键以喝下药剂",
  "Right click to drink",
];
const SKIP_EXACT = new Set([
  "已鉴定",
  "未鉴定",
  "已腐化",
  "已分裂",
  "已复制",
  "镜像",
  "Mirrored",
  "Corrupted",
  "Unidentified",
  "塑界者物品",
  "裂界者物品",
  "圣战者物品",
  "救赎者物品",
  "狩猎者物品",
  "督军物品",
  "焚界者物品",
  "灭界者物品",
]);
const IMPLICIT_MARKERS = ["(implicit)", "（固有）", "(固有)"];
const ENCHANT_MARKERS = ["(enchant)", "（附魔）", "(附魔)"];
const FRACTURED_MARKERS = ["(fractured)", "（破裂）", "(破裂)"];
const CRAFTED_MARKERS = ["(crafted)", "（工艺）", "(工艺)"];
const RUNE_MARKERS = ["(rune)", "（符文）", "(符文)"];
const BASE_STAT_LINE_RE =
  /^(?:护甲|闪避|闪避值|能量护盾|能量盾|物理伤害|元素伤害|暴击率|每秒攻击次数|武器范围|格挡几率|法术格挡|品质|有机物|无机物|Armour|Evasion|Energy Shield|Physical Damage|Critical Strike Chance|Attacks per Second|Weapon Range)\s*:/;

function normalizeMetadataLine(line: string): string {
  const s = line.trim().replace(/^#+\s*/, "").replace(/：/g, ":");
  if (!s.includes(":")) return s;
  const [label, ...rest] = s.split(":");
  return `${label.replace(/\s+/g, "")}:${rest.join(":").replace(/^\s+/, "")}`;
}

function isModifierDescriptorLine(line: string): boolean {
  const s = line.trim();
  return s.startsWith("{") && s.endsWith("}");
}

function isImplicitOrEnchantDescriptor(line: string): boolean {
  if (!isModifierDescriptorLine(line)) return false;
  return ["固有", "Implicit", "implicit", "附魔", "Enchant", "enchant", "符文", "Rune", "rune"].some((m) =>
    line.includes(m),
  );
}

function isExplicitModifierDescriptor(line: string): boolean {
  if (!isModifierDescriptorLine(line) || isImplicitOrEnchantDescriptor(line)) return false;
  return ["前缀词缀", "后缀词缀", "前缀属性", "后缀属性", "Prefix Modifier", "Suffix Modifier"].some((m) =>
    line.includes(m),
  );
}

function explicitModifierName(line: string): string {
  if (!isExplicitModifierDescriptor(line)) return "";
  return line.match(/[“"]([^“”"]+)[”"]/)?.[1]?.trim() ?? "";
}

function taggedModKind(line: string): "implicit" | "enchant" | null {
  if (IMPLICIT_MARKERS.some((m) => line.includes(m))) return "implicit";
  if ([...ENCHANT_MARKERS, ...RUNE_MARKERS].some((m) => line.includes(m))) return "enchant";
  return null;
}

/** 冒号后的全部内容；JS 的 split(":", n) 会截断数组而不是保留剩余段，不能用。 */
function metadataValue(normalized: string): string {
  return normalized.slice(normalized.indexOf(":") + 1);
}

export function isEquipmentClipboardText(text: string): boolean {
  const raw = (text || "").trim();
  if (!raw || raw.includes("未找到物品") || raw.startsWith("http")) return false;
  for (const line of raw.split(/\r?\n/)) {
    const normalized = normalizeMetadataLine(line);
    if (normalized.startsWith("物品类别:") && metadataValue(normalized).includes("通货")) return false;
    if (normalized.startsWith("稀有度:") && ["通货", "Currency"].includes(metadataValue(normalized).trim())) {
      return false;
    }
  }
  return true;
}

export function extractNumbers(text: string): number[] {
  const cleaned = text.replace(RANGE_IN_PARENS_RE, " ");
  const values: number[] = [];
  for (const m of cleaned.matchAll(NUMBER_RE)) {
    const n = Number(m[0]);
    if (Number.isFinite(n)) values.push(n);
  }
  return values;
}

function looksLikeBaseImplicit(raw: string, line: string): boolean {
  const text = stripAffixTags(line);
  const values = extractNumbers(text);
  if (!raw.includes("腰带") && !raw.includes("Belt")) return false;
  if (text.includes("深渊") || text.includes("Abyss")) return true;
  if ((text.includes("最大生命") || text.includes("maximum Life")) && values.length) return values[0] <= 40;
  if ((text.includes("力量") || text.includes("Strength")) && values.length && !text.includes("全")) return values[0] <= 35;
  if ((text.includes("能量护盾") || text.includes("Energy Shield")) && values.length) return values[0] <= 25;
  if ((text.includes("物理伤害") || text.includes("Physical Damage")) && values.length) return values[0] <= 24;
  return false;
}

function countExplicitMods(rarity: string, affixBySection: string[][], rawText: string): number {
  if (!affixBySection.length) return 0;
  let explicitIdx = 0;
  if (affixBySection.length >= 2) explicitIdx = affixBySection.length - 1;
  else if (rarity.trim() === "普通") explicitIdx = -1;
  const skipFirst =
    affixBySection.length === 1 &&
    explicitIdx === 0 &&
    affixBySection[0].length >= 2 &&
    looksLikeBaseImplicit(rawText, affixBySection[0][0]);
  let count = 0;
  affixBySection.forEach((lines, idx) => {
    lines.forEach((line, lineI) => {
      if (taggedModKind(line) === "implicit" || taggedModKind(line) === "enchant") return;
      if (skipFirst && idx === 0 && lineI === 0) return;
      if (idx === explicitIdx) count += 1;
    });
  });
  return count;
}

function countCraftExplicits(
  rarity: string,
  allLines: string[],
  affixBySection: string[][],
  rawText: string,
): number {
  let pending = "";
  let sawExplicitDesc = false;
  let count = 0;
  for (const line of allLines) {
    if (isModifierDescriptorLine(line)) {
      if (isExplicitModifierDescriptor(line)) {
        pending = "explicit";
        sawExplicitDesc = true;
      } else pending = "skip";
      continue;
    }
    if (!isAffixLine(line)) continue;
    if (taggedModKind(line) === "implicit" || taggedModKind(line) === "enchant") {
      pending = "";
      continue;
    }
    if (pending === "explicit") count += 1;
    pending = "";
  }
  return sawExplicitDesc ? count : countExplicitMods(rarity, affixBySection, rawText);
}

function splitSections(text: string): string[][] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").map((ln) => ln.replace(/\s+$/, ""));
  const sections: string[][] = [];
  let current: string[] = [];
  for (const ln of lines) {
    if (SECTION_SEP.test(ln.trim())) {
      if (current.length) {
        sections.push(current);
        current = [];
      }
      continue;
    }
    if (ln.trim() === "" && !current.length) continue;
    current.push(ln);
  }
  if (current.length) sections.push(current);
  return sections;
}

function isAffixLine(line: string): boolean {
  const s = line.trim();
  const normalized = normalizeMetadataLine(s);
  if (!s || isModifierDescriptorLine(s) || SKIP_EXACT.has(s) || normalized.startsWith("稀有度:")) return false;
  if (SKIP_LINE_PREFIXES.some((p) => normalized.startsWith(p))) return false;
  if (BASE_STAT_LINE_RE.test(s)) return false;
  if (["攻击", "法术", "武器", "防具", "饰品"].includes(s)) return false;
  return true;
}

function stripAffixTags(text: string): string {
  let s = text.trim();
  for (const markers of [IMPLICIT_MARKERS, ENCHANT_MARKERS, FRACTURED_MARKERS, CRAFTED_MARKERS, RUNE_MARKERS]) {
    for (const m of markers) s = s.replaceAll(m, "");
  }
  return s.trim();
}

export function parseItemText(text: string): Item {
  const raw = (text || "").trim();
  if (!raw) throw new ItemParseError("剪贴板为空");
  if (!isEquipmentClipboardText(raw)) throw new ItemParseError("剪贴板内容不是装备文本");
  const sections = splitSections(raw);
  if (!sections.length) throw new ItemParseError("无法分割物品文本段落");

  const item = new Item();
  item.rawText = raw;
  const header = sections[0];
  for (const ln of header) {
    const s = ln.trim();
    const normalized = normalizeMetadataLine(s);
    if (normalized.startsWith("稀有度:")) item.rarity = normalized.split(":").slice(1).join(":").trim();
    else if (HEADER_KEYS.some((key) => normalized.startsWith(key))) continue;
    else if (!item.name && s) item.name = s;
    else if (item.name && !item.baseType && s && s !== item.name) item.baseType = s;
  }
  if (!item.name && header.length) item.name = header[0].trim();

  const allLines = sections.flatMap((sec) => sec.map((ln) => ln.trim()));
  for (const s of allLines) {
    const normalized = normalizeMetadataLine(s);
    if (normalized.startsWith("物品等级:")) {
      const m = s.match(/(\d+)/);
      if (m) item.itemLevel = parseInt(m[1], 10);
    }
    if (s === "已腐化" || s === "Corrupted") {
      item.corrupted = true;
      item.flags.push("corrupted");
    }
    if (s === "已分裂" || s === "Split") item.flags.push("split");
    if (s === "镜像" || s === "Mirrored") item.flags.push("mirrored");
    if (s === "未鉴定" || s === "Unidentified") item.flags.push("unidentified");
  }
  if (item.flags.includes("unidentified")) return item;

  const affixBySection: string[][] = [];
  const affixEntries: { line: string; name: string }[] = [];
  sections.forEach((sec, idx) => {
    if (idx === 0) return;
    const first = sec.map((x) => x.trim()).find(Boolean) || "";
    const normalizedFirst = normalizeMetadataLine(first);
    if (["需求:", "插槽:", "品质:", "堆叠数量:", "地图等级:"].some((p) => normalizedFirst.startsWith(p))) return;
    const secAffixes: string[] = [];
    let currentModifierName = "";
    for (const ln of sec) {
      const s = ln.trim();
      if (isModifierDescriptorLine(s)) {
        currentModifierName = explicitModifierName(s);
        continue;
      }
      if (!isAffixLine(s)) continue;
      if (s.length > 80 && !extractNumbers(s).length && !s.includes("+") && !s.includes("%")) continue;
      if (SKIP_EXACT.has(s)) {
        if (s === "已腐化" || s === "Corrupted") item.corrupted = true;
        continue;
      }
      secAffixes.push(s);
      const name = taggedModKind(s) == null ? currentModifierName : "";
      affixEntries.push({ line: s, name });
    }
    if (secAffixes.length) affixBySection.push(secAffixes);
  });

  const seen = new Set<string>();
  for (const { line, name } of affixEntries) {
    const key = `${name}\u0000${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const clean = stripAffixTags(line);
    item.affixes.push(new Affix(clean, extractNumbers(clean), name));
  }
  if (!item.rarity && item.itemLevel != null) item.rarity = "普通";
  if (item.explicitModCount == null) {
    item.explicitModCount = countCraftExplicits(item.rarity, allLines, affixBySection, raw);
  }
  if (!item.rarity && !item.name) throw new ItemParseError("未识别到物品稀有度或名称");
  return item;
}

export function formatItemPreview(item: Item): string {
  const lines = [
    `稀有度: ${item.rarity || "-"}`,
    `名称: ${item.name || "-"}`,
    `基底: ${item.baseType || "-"}`,
    `物品等级: ${item.itemLevel ?? "-"}`,
    `显式词缀数: ${item.craftAffixCount}`,
  ];
  if (item.corrupted) lines.push("状态: 已腐化");
  if (item.flags.length) lines.push(`标记: ${item.flags.join(", ")}`);
  lines.push("词缀:");
  if (!item.affixes.length) lines.push("  (无)");
  else {
    for (const a of item.affixes) {
      const val = a.values.length ? `  [values=${JSON.stringify(a.values)}]` : "";
      lines.push(`  • ${a.displayText}${val}`);
    }
  }
  return lines.join("\n");
}
