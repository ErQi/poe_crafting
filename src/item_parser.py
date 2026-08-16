from __future__ import annotations

import re

from .models import Affix, Item


class ItemParseError(ValueError):
    """剪贴板文本无法解析为有效物品。"""


SECTION_SEP = re.compile(r"^-{3,}\s*$", re.MULTILINE)
# 正负号仅在字符串开头、空白或 + 后生效；`10-20` 中的 `-` 不当作负号
NUMBER_RE = re.compile(
    r"(?:(?<=^)|(?<=\s)|(?<=\+)|(?<=，)|(?<=,)|(?<=:)|(?<=：))"
    r"[+-]?"
    r"(?:\d+(?:\.\d+)?|\.\d+)"
    r"|(?:\d+(?:\.\d+)?|\.\d+)"
)
RANGE_IN_PARENS_RE = re.compile(r"\([^)]*\)")

# 非词缀段落/行特征（简体中文客户端）
HEADER_KEYS = (
    "物品类别:",
    "稀有度:",
    "物品等级:",
    "品质:",
    "插槽:",
    "需求:",
)
SKIP_LINE_PREFIXES = (
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
)
SKIP_EXACT = {
    "已鉴定",
    "未鉴定",
    "已腐化",
    "已分裂",
    "已复制",
    "镜像",
    "Mirrored",
    "Corrupted",
    "Unidentified",
    # 影响来源与出售绑定信息是物品元数据，不是可由通货增减的显式词缀。
    "塑界者物品",
    "裂界者物品",
    "圣战者物品",
    "救赎者物品",
    "狩猎者物品",
    "督军物品",
    "焚界者物品",
    "灭界者物品",
}
IMPLICIT_MARKERS = ("(implicit)", "（固有）", "(固有)")
ENCHANT_MARKERS = ("(enchant)", "（附魔）", "(附魔)")
FRACTURED_MARKERS = ("(fractured)", "（破裂）", "(破裂)")
CRAFTED_MARKERS = ("(crafted)", "（工艺）", "(工艺)")
RUNE_MARKERS = ("(rune)", "（符文）", "(符文)")


def _normalize_metadata_line(line: str) -> str:
    """规范国服复制文本的字段名，不改动物品名或词缀正文。

    国服会输出 ``稀 有 度: 魔法``，而其他字段通常不带空格。
    这里只压缩第一个冒号前的空白，兼容两种格式。
    """

    s = line.strip().replace("：", ":")
    if ":" not in s:
        return s
    label, value = s.split(":", 1)
    label = re.sub(r"\s+", "", label)
    return f"{label}:{value.lstrip()}"


def _is_modifier_descriptor_line(line: str) -> bool:
    s = line.strip()
    return s.startswith("{") and s.endswith("}")


def _is_implicit_or_enchant_descriptor(line: str) -> bool:
    if not _is_modifier_descriptor_line(line):
        return False
    return any(
        marker in line
        for marker in (
            "固有",
            "Implicit",
            "implicit",
            "附魔",
            "Enchant",
            "enchant",
            "符文",
            "Rune",
            "rune",
        )
    )


def _is_explicit_modifier_descriptor(line: str) -> bool:
    if not _is_modifier_descriptor_line(line):
        return False
    if _is_implicit_or_enchant_descriptor(line):
        return False
    return any(
        marker in line
        for marker in (
            "前缀词缀",
            "后缀词缀",
            "前缀属性",
            "后缀属性",
            "Prefix Modifier",
            "Suffix Modifier",
        )
    )


def _tagged_mod_kind(line: str) -> str | None:
    if any(marker in line for marker in IMPLICIT_MARKERS):
        return "implicit"
    if any(marker in line for marker in ENCHANT_MARKERS + RUNE_MARKERS):
        return "enchant"
    return None


def is_equipment_clipboard_text(text: str) -> bool:
    """排除空文本、网页、通货 tooltip，避免拿去匹配。"""
    raw = (text or "").strip()
    if not raw or "未找到物品" in raw or raw.startswith("http"):
        return False
    for line in raw.splitlines():
        normalized = _normalize_metadata_line(line)
        if normalized.startswith("物品类别:") and "通货" in normalized.split(":", 1)[1]:
            return False
        if normalized.startswith("稀有度:") and normalized.split(":", 1)[1].strip() in {
            "通货",
            "Currency",
        }:
            return False
    return True


def _looks_like_base_implicit(raw: str, line: str) -> bool:
    """无高级说明且固有/显式挤在同一段时，用基底常见固有排除。"""
    text = _strip_affix_tags(line)
    values = extract_numbers(text)
    blob = raw or ""
    if "腰带" not in blob and "Belt" not in blob:
        return False
    if "深渊" in text or "Abyss" in text:
        return True
    if ("最大生命" in text or "maximum Life" in text) and values:
        return values[0] <= 40
    if ("力量" in text or "Strength" in text) and values and "全" not in text:
        return values[0] <= 35
    if ("能量护盾" in text or "Energy Shield" in text) and values:
        return values[0] <= 25
    if ("物理伤害" in text or "Physical Damage" in text) and values:
        return values[0] <= 24
    return False


def _count_explicit_mods(
    rarity: str,
    affix_by_section: list[list[str]],
    raw_text: str = "",
) -> int:
    """没开高级说明时，按分隔段区分固有/附魔与显式。"""
    if not affix_by_section:
        return 0
    if len(affix_by_section) >= 2:
        explicit_idx = len(affix_by_section) - 1
    elif rarity.strip() == "普通":
        explicit_idx = -1
    else:
        explicit_idx = 0
    skip_first = (
        len(affix_by_section) == 1
        and explicit_idx == 0
        and len(affix_by_section[0]) >= 2
        and _looks_like_base_implicit(raw_text, affix_by_section[0][0])
    )
    count = 0
    for idx, lines in enumerate(affix_by_section):
        for line_i, line in enumerate(lines):
            if _tagged_mod_kind(line) in {"implicit", "enchant"}:
                continue
            if skip_first and idx == 0 and line_i == 0:
                continue
            if idx == explicit_idx:
                count += 1
    return count


def _count_craft_explicits(
    rarity: str,
    all_lines: list[str],
    affix_by_section: list[list[str]],
    raw_text: str,
) -> int:
    """有 { 前缀/后缀 } 用官方计数；固有说明即使带前缀字样也不计入。"""
    pending = ""
    saw_explicit_desc = False
    count = 0
    for line in all_lines:
        if _is_modifier_descriptor_line(line):
            if _is_explicit_modifier_descriptor(line):
                pending = "explicit"
                saw_explicit_desc = True
            else:
                pending = "skip"
            continue
        if not _is_affix_line(line):
            continue
        if _tagged_mod_kind(line) in {"implicit", "enchant"}:
            pending = ""
            continue
        if pending == "explicit":
            count += 1
        pending = ""
    if saw_explicit_desc:
        return count
    return _count_explicit_mods(rarity, affix_by_section, raw_text)


def extract_numbers(text: str) -> list[float]:
    """从词缀行提取数值。优先去掉括号内范围 roll，如 (18-22)。"""
    cleaned = RANGE_IN_PARENS_RE.sub(" ", text)
    values: list[float] = []
    for m in NUMBER_RE.finditer(cleaned):
        try:
            values.append(float(m.group(0)))
        except ValueError:
            continue
    return values


def _split_sections(text: str) -> list[list[str]]:
    lines = [
        ln.rstrip() for ln in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    ]
    sections: list[list[str]] = []
    current: list[str] = []
    for ln in lines:
        if SECTION_SEP.match(ln.strip()):
            if current:
                sections.append(current)
                current = []
            continue
        if ln.strip() == "" and not current:
            continue
        current.append(ln)
    if current:
        sections.append(current)
    return sections


# 基底防御/攻击属性行，如 "能量护盾: 142"、"物理伤害: 10-20"
BASE_STAT_LINE_RE = re.compile(
    r"^(?:护甲|闪避|闪避值|能量护盾|能量盾|物理伤害|元素伤害|暴击率|每秒攻击次数|"
    r"武器范围|格挡几率|法术格挡|品质|有机物|无机物|"
    r"Armour|Evasion|Energy Shield|Physical Damage|Critical Strike Chance|"
    r"Attacks per Second|Weapon Range)"
    r"\s*:"
)


def _is_affix_line(line: str) -> bool:
    s = line.strip()
    normalized = _normalize_metadata_line(s)
    if not s:
        return False
    # 开启高级词缀说明后，复制文本会在实际词缀前附带
    # `{ ▲ 前缀词缀 ... }` / `{ ▽ 后缀词缀 ... }`；它们只是说明行。
    if _is_modifier_descriptor_line(s):
        return False
    if s in SKIP_EXACT:
        return False
    if normalized.startswith("稀有度:"):
        return False
    for p in SKIP_LINE_PREFIXES:
        if normalized.startswith(p):
            return False
    if BASE_STAT_LINE_RE.match(s):
        return False
    # 纯标签行
    if s in {"攻击", "法术", "武器", "防具", "饰品"}:
        return False
    return True


def _strip_affix_tags(text: str) -> str:
    s = text.strip()
    for markers in (
        IMPLICIT_MARKERS,
        ENCHANT_MARKERS,
        FRACTURED_MARKERS,
        CRAFTED_MARKERS,
        RUNE_MARKERS,
    ):
        for m in markers:
            s = s.replace(m, "")
    return s.strip()


def parse_item_text(text: str) -> Item:
    """解析 PoE 简体中文客户端 Ctrl+C 物品文本。"""
    raw = (text or "").strip()
    if not raw:
        raise ItemParseError("剪贴板为空")
    if not is_equipment_clipboard_text(raw):
        raise ItemParseError("剪贴板内容不是装备文本")

    sections = _split_sections(raw)
    if not sections:
        raise ItemParseError("无法分割物品文本段落")

    item = Item(raw_text=raw)
    header = sections[0]
    # 第一段：稀有度 + 名称 + 基底
    for ln in header:
        s = ln.strip()
        normalized = _normalize_metadata_line(s)
        if normalized.startswith("稀有度:"):
            item.rarity = normalized.split(":", 1)[1].strip()
        elif any(normalized.startswith(key) for key in HEADER_KEYS):
            continue
        elif not item.name and s:
            item.name = s
        elif item.name and not item.base_type and s and s != item.name:
            item.base_type = s

    # 若只有一行名称（普通/魔法），base 可能为空
    if not item.name and header:
        item.name = header[0].strip()

    # 扫描全部行做 flags / item_level
    all_lines = [ln.strip() for sec in sections for ln in sec]
    for s in all_lines:
        normalized = _normalize_metadata_line(s)
        if normalized.startswith("物品等级:"):
            m = re.search(r"(\d+)", s)
            if m:
                item.item_level = int(m.group(1))
        if s in {"已腐化", "Corrupted"}:
            item.corrupted = True
            item.flags.append("corrupted")
        if s in {"已分裂", "Split"}:
            item.flags.append("split")
        if s in {"镜像", "Mirrored"}:
            item.flags.append("mirrored")
        if s in {"未鉴定", "Unidentified"}:
            item.flags.append("unidentified")

    if "unidentified" in item.flags:
        # 未鉴定仍返回基础信息，词缀为空
        return item

    # 词缀段落：跳过明显的需求/属性头段，收集看起来像词缀的行
    # PoE 物品结构大致：header | 属性/防御 | 需求 | 插槽 | 固有 | 显式 | 风味
    affix_by_section: list[list[str]] = []
    for idx, sec in enumerate(sections):
        if idx == 0:
            continue
        # 整段若以需求/插槽/品质等开头则跳过
        first = next((x.strip() for x in sec if x.strip()), "")
        normalized_first = _normalize_metadata_line(first)
        if normalized_first.startswith(
            ("需求:", "插槽:", "品质:", "堆叠数量:", "地图等级:")
        ):
            continue
        if normalized_first.startswith("物品等级:"):
            continue
        sec_affixes: list[str] = []
        # 风味文本段通常很长且无数字、或不含典型词缀模式——仍尝试收集短行
        for ln in sec:
            s = ln.strip()
            if not _is_affix_line(s):
                continue
            # 跳过纯 flavor（很长且无数字、无 %、无 +）
            if len(s) > 80 and not extract_numbers(s) and "+" not in s and "%" not in s:
                continue
            if s in SKIP_EXACT:
                if s in {"已腐化", "Corrupted"}:
                    item.corrupted = True
                continue
            sec_affixes.append(s)
        if sec_affixes:
            affix_by_section.append(sec_affixes)
    affix_candidates = [line for sec_affixes in affix_by_section for line in sec_affixes]

    # 去重保持顺序
    seen: set[str] = set()
    for line in affix_candidates:
        if line in seen:
            continue
        seen.add(line)
        clean = _strip_affix_tags(line)
        values = extract_numbers(clean)
        item.affixes.append(Affix(text=clean, values=values))

    # 国服普通装备的 Ctrl+C 文本可能不带“稀有度”行。
    # 只在已确认存在物品等级时将空值视为普通，避免把任意剪贴板文字当成装备。
    if not item.rarity and item.item_level is not None:
        item.rarity = "普通"

    if item.explicit_mod_count is None:
        item.explicit_mod_count = _count_craft_explicits(
            item.rarity, all_lines, affix_by_section, raw
        )

    # 至少要有稀有度或名称才算解析成功
    if not item.rarity and not item.name:
        raise ItemParseError("未识别到物品稀有度或名称")

    return item


def format_item_preview(item: Item) -> str:
    lines = [
        f"稀有度: {item.rarity or '-'}",
        f"名称: {item.name or '-'}",
        f"基底: {item.base_type or '-'}",
        f"物品等级: {item.item_level if item.item_level is not None else '-'}",
        f"显式词缀数: {item.craft_affix_count}",
    ]
    if item.corrupted:
        lines.append("状态: 已腐化")
    if item.flags:
        lines.append(f"标记: {', '.join(item.flags)}")
    lines.append("词缀:")
    if not item.affixes:
        lines.append("  (无)")
    else:
        for a in item.affixes:
            val = f"  [values={a.values}]" if a.values else ""
            lines.append(f"  • {a.text}{val}")
    return "\n".join(lines)
