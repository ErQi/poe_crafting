from __future__ import annotations

import re

from .models import (
    CompareOp,
    GroupMatchResult,
    Item,
    MatchMode,
    MatchResult,
    MatchRule,
    RuleGroup,
    RuleHit,
    RuleSet,
)


def parse_threshold_text(text: str) -> tuple[float | None, float | None]:
    """解析阈值输入：`80` 或 `6-12` / `6 - 12` / `6到12`。"""
    raw = (text or "").strip()
    if not raw:
        return None, None
    parts = [p for p in re.split(r"\s*(?:-|—|–|到|至)\s*", raw) if p != ""]
    if len(parts) >= 2:
        try:
            return float(parts[0]), float(parts[1])
        except ValueError:
            return None, None
    try:
        return float(raw), None
    except ValueError:
        return None, None


def format_threshold_text(
    threshold: float | None, threshold2: float | None = None
) -> str:
    if threshold is None and threshold2 is None:
        return ""
    if threshold is None:
        return f"{threshold2:g}"
    if threshold2 is None:
        return f"{threshold:g}"
    return f"{threshold:g}-{threshold2:g}"


def split_pattern_keywords(pattern: str) -> list[str]:
    """「攻击附加 冰霜伤害」或「攻击附加,冰霜伤害」拆成多个必须同时命中的关键字。"""
    raw = (pattern or "").strip()
    if not raw:
        return []
    parts = [p.strip() for p in re.split(r"[,，;；|]+", raw) if p.strip()]
    keywords: list[str] = []
    for part in parts:
        keywords.extend(p for p in part.split() if p)
    return keywords


def _affix_has_keywords(text: str, keywords: list[str]) -> bool:
    return all(keyword in text for keyword in keywords)


def _compare(actual: float, op: str, threshold: float) -> bool:
    if op == CompareOp.GE.value or op == "≥":
        return actual >= threshold
    if op == CompareOp.GT.value or op == ">":
        return actual > threshold
    if op == CompareOp.LE.value or op == "≤":
        return actual <= threshold
    if op == CompareOp.LT.value or op == "<":
        return actual < threshold
    if op in (CompareOp.EQ.value, "==", "＝"):
        return abs(actual - threshold) < 1e-9
    return False


def match_rule(item: Item, rule: MatchRule) -> RuleHit:
    if not rule.enabled:
        return RuleHit(rule=rule, matched=True, reason="disabled")

    pattern = (rule.pattern or "").strip()
    keywords = split_pattern_keywords(pattern)
    if not keywords:
        return RuleHit(rule=rule, matched=False, reason="空规则")

    op = (rule.operator or "").strip()
    op = {"≥": ">=", "≤": "<=", "＝": "=", "＞": ">", "＜": "<"}.get(op, op)
    need_value = bool(
        op and (rule.threshold is not None or rule.threshold2 is not None)
    )

    candidates: list[RuleHit] = []
    for affix in item.affixes:
        if not _affix_has_keywords(affix.text, keywords):
            continue
        if not need_value:
            return RuleHit(
                rule=rule,
                matched=True,
                matched_affix=affix.text,
                actual_value=affix.first_value,
                actual_values=list(affix.values),
                reason="文本匹配",
            )
        if not affix.values:
            continue
        first_ok = True
        if rule.threshold is not None:
            if affix.first_value is None:
                continue
            first_ok = _compare(affix.first_value, op, float(rule.threshold))
        second_ok = True
        if rule.threshold2 is not None:
            if affix.second_value is None:
                continue
            second_ok = _compare(affix.second_value, op, float(rule.threshold2))
        ok = first_ok and second_ok
        candidates.append(
            RuleHit(
                rule=rule,
                matched=ok,
                matched_affix=affix.text,
                actual_value=affix.first_value,
                actual_values=list(affix.values),
                reason="数值匹配" if ok else "数值未达标",
            )
        )

    if not candidates:
        return RuleHit(rule=rule, matched=False, reason="未找到同时包含这些关键字的词缀")
    # 腰带固有生命等会先于显式词缀出现；>= 取最高值，<= 取最低值。
    successes = [hit for hit in candidates if hit.matched]
    pool = successes or candidates
    reverse = op in {">=", ">", CompareOp.GE.value, CompareOp.GT.value}
    return max(
        pool,
        key=lambda hit: (
            hit.actual_value is not None,
            hit.actual_value if reverse else -(hit.actual_value or 0),
        ),
    )


def match_group(item: Item, group: RuleGroup) -> GroupMatchResult:
    enabled_rules = [r for r in group.rules if r.enabled and (r.pattern or "").strip()]
    hits: list[RuleHit] = []
    for r in enabled_rules:
        h = match_rule(item, r)
        h.group_id = group.id
        h.group_name = group.name
        hits.append(h)

    if not enabled_rules:
        return GroupMatchResult(group=group, success=False, hits=hits)

    matched_n = sum(1 for h in hits if h.matched)
    if group.min_matches:
        success = matched_n >= int(group.min_matches)
    elif group.combine == MatchMode.ANY.value:
        success = matched_n >= 1
    else:
        success = matched_n == len(hits)
    return GroupMatchResult(group=group, success=success, hits=hits)


def match_ruleset(item: Item, ruleset: RuleSet) -> MatchResult:
    groups = [g for g in ruleset.groups if g.enabled]
    if not groups:
        return MatchResult(
            success=False, mode=ruleset.group_combine, hits=[], group_results=[]
        )

    group_results = [match_group(item, g) for g in groups]
    active = [gr for gr in group_results if gr.hits]
    if not active:
        return MatchResult(
            success=False,
            mode=ruleset.group_combine,
            hits=[],
            group_results=group_results,
        )

    if ruleset.group_combine == MatchMode.ANY.value:
        success = any(gr.success for gr in active)
    else:
        success = all(gr.success for gr in active)

    flat_hits: list[RuleHit] = []
    for gr in group_results:
        flat_hits.extend(gr.hits)

    return MatchResult(
        success=success,
        mode=ruleset.group_combine,
        hits=flat_hits,
        group_results=group_results,
    )


def match_item(
    item: Item,
    rules: list[MatchRule] | RuleSet,
    mode: str = MatchMode.ALL.value,
) -> MatchResult:
    if isinstance(rules, RuleSet):
        return match_ruleset(item, rules)

    enabled = [r for r in rules if r.enabled]
    if not enabled:
        return MatchResult(success=False, mode=mode, hits=[])

    group = RuleGroup(name="默认", combine=mode, rules=list(rules))
    rs = RuleSet(group_combine=MatchMode.ALL.value, groups=[group])
    return match_ruleset(item, rs)


def normalize_operator(op: str) -> str:
    op = (op or "").strip()
    mapping = {
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
        "无": "",
        "none": "",
    }
    return mapping.get(op, op)


def normalize_combine(mode: str) -> str:
    m = (mode or "").strip().lower()
    if m in ("any", "or", "任一", "或者"):
        return MatchMode.ANY.value
    return MatchMode.ALL.value
