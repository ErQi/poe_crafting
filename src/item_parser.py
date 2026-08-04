from __future__ import annotations

import re
from typing import Optional

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
HEADER_KEYS = ("稀有度:", "物品等级:", "品质:", "插槽:", "需求:")
SKIP_LINE_PREFIXES = (
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
}
IMPLICIT_MARKERS = ("(implicit)", "（固有）", "(固有)")
ENCHANT_MARKERS = ("(enchant)", "（附魔）", "(附魔)")
FRACTURED_MARKERS = ("(fractured)", "（破裂）", "(破裂)")
CRAFTED_MARKERS = ("(crafted)", "（工艺）", "(工艺)")
RUNE_MARKERS = ("(rune)", "（符文）", "(符文)")


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
    if not s:
        return False
    if s in SKIP_EXACT:
        return False
    if s.startswith("稀有度:"):
        return False
    for p in SKIP_LINE_PREFIXES:
        if s.startswith(p):
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

    # 常见非物品内容
    if "未找到物品" in raw or raw.startswith("http"):
        raise ItemParseError("剪贴板内容不是物品文本")

    sections = _split_sections(raw)
    if not sections:
        raise ItemParseError("无法分割物品文本段落")

    item = Item(raw_text=raw)
    header = sections[0]
    # 第一段：稀有度 + 名称 + 基底
    for ln in header:
        s = ln.strip()
        if s.startswith("稀有度:"):
            item.rarity = s.split(":", 1)[1].strip()
        elif not item.name and s and not s.startswith("稀有度:"):
            item.name = s
        elif item.name and not item.base_type and s and s != item.name:
            item.base_type = s

    # 若只有一行名称（普通/魔法），base 可能为空
    if not item.name and header:
        item.name = header[0].strip()

    # 扫描全部行做 flags / item_level
    all_lines = [ln.strip() for sec in sections for ln in sec]
    for s in all_lines:
        if s.startswith("物品等级:"):
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
    affix_candidates: list[str] = []
    for idx, sec in enumerate(sections):
        if idx == 0:
            continue
        # 整段若以需求/插槽/品质等开头则跳过
        first = next((x.strip() for x in sec if x.strip()), "")
        if first.startswith(("需求:", "插槽:", "品质:", "堆叠数量:", "地图等级:")):
            continue
        if first.startswith("物品等级:"):
            continue
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
            affix_candidates.append(s)

    # 去重保持顺序
    seen: set[str] = set()
    for line in affix_candidates:
        if line in seen:
            continue
        seen.add(line)
        clean = _strip_affix_tags(line)
        values = extract_numbers(clean)
        item.affixes.append(Affix(text=clean, values=values))

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
