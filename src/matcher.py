from __future__ import annotations

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
    if not pattern:
        return RuleHit(rule=rule, matched=False, reason="空规则")

    op = (rule.operator or "").strip()
    op = {"≥": ">=", "≤": "<=", "＝": "=", "＞": ">", "＜": "<"}.get(op, op)

    for affix in item.affixes:
        if pattern not in affix.text:
            continue
        if not op or rule.threshold is None:
            return RuleHit(
                rule=rule,
                matched=True,
                matched_affix=affix.text,
                actual_value=affix.first_value,
                reason="文本匹配",
            )
        if affix.first_value is None:
            continue
        ok = _compare(affix.first_value, op, float(rule.threshold))
        return RuleHit(
            rule=rule,
            matched=ok,
            matched_affix=affix.text,
            actual_value=affix.first_value,
            reason="数值匹配" if ok else "数值未达标",
        )

    return RuleHit(rule=rule, matched=False, reason="未找到包含该文本的词缀")


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

    if group.combine == MatchMode.ANY.value:
        success = any(h.matched for h in hits)
    else:
        success = all(h.matched for h in hits)
    return GroupMatchResult(group=group, success=success, hits=hits)


def match_ruleset(item: Item, ruleset: RuleSet) -> MatchResult:
    groups = [g for g in ruleset.groups if g.enabled]
    if not groups:
        return MatchResult(success=False, mode=ruleset.group_combine, hits=[], group_results=[])

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
