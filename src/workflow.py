from __future__ import annotations

from dataclasses import dataclass

from .currencies import CURRENCY_BY_TEMPLATE
from .matcher import match_ruleset
from .models import (
    CraftStep,
    CraftWorkflow,
    Item,
    MatchMode,
    MatchResult,
    MatchRule,
    RuleGroup,
    RuleSet,
)

TRANSITION_NEXT = "next"
TRANSITION_REPEAT = "repeat"
TRANSITION_FINISH = "finish"
TRANSITION_STOP = "stop"
TRANSITION_GOTO_PREFIX = "goto:"

ROUTE_STEP = "step"
ROUTE_FINISH = "finish"
ROUTE_STOP = "stop"

RARITY_VALUES = ("", "普通", "魔法", "稀有")


@dataclass(frozen=True)
class StepEvaluation:
    success: bool
    rarity_matched: bool
    rules_matched: bool
    match: MatchResult
    summary: str


@dataclass(frozen=True)
class RouteDecision:
    kind: str
    next_step_id: str = ""


def _has_enabled_rules(ruleset: RuleSet) -> bool:
    return any(
        group.enabled and rule.enabled and bool(rule.pattern.strip())
        for group in ruleset.groups
        for rule in group.rules
    )


def evaluate_step(item: Item, step: CraftStep) -> StepEvaluation:
    """检查一步动作后的稀有度与词缀条件。

    没有启用词缀条件时视为无条件通过；若配置了稀有度，则稀有度仍须匹配。
    """

    if _has_enabled_rules(step.ruleset):
        match = match_ruleset(item, step.ruleset)
        rules_matched = match.success
    else:
        rules_matched = True
        match = MatchResult(
            success=True,
            mode=step.ruleset.group_combine or MatchMode.ALL.value,
        )

    expected = step.expected_rarity.strip()
    rarity_matched = not expected or item.rarity.strip() == expected
    success = rarity_matched and rules_matched
    # RunStatus 仍复用 MatchResult；把组合后的最终结果同步进去。
    match.success = success

    parts: list[str] = []
    if expected:
        mark = "✓" if rarity_matched else "✗"
        parts.append(f"{mark}稀有度={expected}（实际={item.rarity or '-'}）")
    if _has_enabled_rules(step.ruleset):
        parts.append(match.summary)
    elif not expected:
        parts.append("无条件")
    return StepEvaluation(
        success=success,
        rarity_matched=rarity_matched,
        rules_matched=rules_matched,
        match=match,
        summary=" | ".join(parts),
    )


def first_enabled_step(workflow: CraftWorkflow) -> CraftStep | None:
    if workflow.start_step_id:
        configured = workflow.get_step(workflow.start_step_id)
        if configured is not None and configured.enabled:
            return configured
    return next((step for step in workflow.steps if step.enabled), None)


def resolve_transition(
    workflow: CraftWorkflow,
    current_step_id: str,
    transition: str,
) -> RouteDecision:
    value = (transition or TRANSITION_STOP).strip()
    if value == TRANSITION_FINISH:
        return RouteDecision(ROUTE_FINISH)
    if value == TRANSITION_STOP:
        return RouteDecision(ROUTE_STOP)
    if value == TRANSITION_REPEAT:
        return RouteDecision(ROUTE_STEP, current_step_id)
    if value == TRANSITION_NEXT:
        current_index = next(
            (i for i, step in enumerate(workflow.steps) if step.id == current_step_id),
            -1,
        )
        for step in workflow.steps[current_index + 1 :]:
            if step.enabled:
                return RouteDecision(ROUTE_STEP, step.id)
        return RouteDecision(ROUTE_FINISH)
    if value.startswith(TRANSITION_GOTO_PREFIX):
        target_id = value[len(TRANSITION_GOTO_PREFIX) :]
        target = workflow.get_step(target_id)
        if target is not None and target.enabled:
            return RouteDecision(ROUTE_STEP, target.id)
    raise ValueError(f"无效或不可用的步骤去向: {value}")


def validate_workflow(workflow: CraftWorkflow) -> list[str]:
    errors: list[str] = []
    enabled = workflow.enabled_steps()
    if not enabled:
        errors.append("至少需要一个启用步骤")

    ids = [step.id for step in workflow.steps]
    if len(set(ids)) != len(ids):
        errors.append("步骤 ID 重复")

    if workflow.start_step_id:
        start = workflow.get_step(workflow.start_step_id)
        if start is None or not start.enabled:
            errors.append("起始步骤不存在或未启用")

    for index, step in enumerate(workflow.steps, 1):
        label = f"第 {index} 步「{step.name or '未命名'}」"
        if not step.id:
            errors.append(f"{label}缺少步骤 ID")
        if step.enabled and not step.currency_template.strip():
            errors.append(f"{label}未选择使用通货")
        elif step.enabled and step.currency_template not in CURRENCY_BY_TEMPLATE:
            errors.append(f"{label}选择了未内置的通货")
        if step.expected_rarity not in RARITY_VALUES:
            errors.append(f"{label}的期望稀有度无效: {step.expected_rarity}")
        for branch_name, transition in (
            ("命中去向", step.on_success),
            ("未命中去向", step.on_failure),
        ):
            value = (transition or "").strip()
            if value in {
                TRANSITION_NEXT,
                TRANSITION_REPEAT,
                TRANSITION_FINISH,
                TRANSITION_STOP,
            }:
                continue
            if value.startswith(TRANSITION_GOTO_PREFIX):
                target = workflow.get_step(value[len(TRANSITION_GOTO_PREFIX) :])
                if target is not None and target.enabled:
                    continue
            errors.append(f"{label}的{branch_name}无效: {value or '(空)'}")
    return errors


def default_workflow() -> CraftWorkflow:
    """用户当前需求的前两条 T1 词缀流程，可在 GUI 中继续扩展。"""

    # T1 的 roll 区间分别为 19-22 与 130-144；按档位下限判断，
    # 不能只接受满 roll 的 22 / 144。
    def elemental_rule() -> MatchRule:
        return MatchRule(pattern="元素伤害提高", operator=">=", threshold=19)

    def life_rule() -> MatchRule:
        return MatchRule(pattern="最大生命", operator=">=", threshold=130)

    def either_target(name: str) -> RuleSet:
        return RuleSet(
            group_combine=MatchMode.ALL.value,
            groups=[
                RuleGroup(
                    name=name,
                    combine=MatchMode.ANY.value,
                    rules=[elemental_rule(), life_rule()],
                )
            ],
        )

    def both_targets(name: str) -> RuleSet:
        return RuleSet(
            group_combine=MatchMode.ALL.value,
            groups=[
                RuleGroup(
                    name=name,
                    combine=MatchMode.ALL.value,
                    rules=[elemental_rule(), life_rule()],
                )
            ],
        )

    transmute = CraftStep(
        id="transmute",
        name="蜕变并检查 T1 元素或生命",
        currency_template="currency_transmutation",
        expected_rarity="魔法",
        ruleset=either_target("先保留任一 T1 目标"),
        on_success=f"{TRANSITION_GOTO_PREFIX}augment_missing_target",
        on_failure=TRANSITION_NEXT,
    )
    alteration = CraftStep(
        id="alteration_t1_elemental",
        name="改造洗出 T1 元素或生命",
        currency_template="currency_alteration",
        expected_rarity="魔法",
        ruleset=either_target("先保留任一 T1 目标"),
        on_success=TRANSITION_NEXT,
        on_failure=TRANSITION_REPEAT,
    )
    augmentation = CraftStep(
        id="augment_missing_target",
        name="单词缀时增幅尝试补齐另一目标",
        currency_template="currency_augmentation",
        expected_rarity="魔法",
        ruleset=both_targets("增幅后检查元素与生命"),
        # 无论增幅是否命中，都再用富豪：命中时升稀有并保留目标，
        # 未命中时让富豪再提供一次补齐机会。
        on_success=TRANSITION_NEXT,
        on_failure=TRANSITION_NEXT,
    )
    regal = CraftStep(
        id="regal_t1_life",
        name="富豪尝试补齐 T1 元素与生命",
        currency_template="currency_regal",
        expected_rarity="稀有",
        ruleset=both_targets("同时具备 T1 元素与 T1 生命"),
        on_success=TRANSITION_FINISH,
        on_failure=TRANSITION_NEXT,
    )
    scour = CraftStep(
        id="scour_restart",
        name="富豪失败后重铸并重来",
        currency_template="currency_scouring",
        expected_rarity="普通",
        on_success=f"{TRANSITION_GOTO_PREFIX}{transmute.id}",
        on_failure=TRANSITION_REPEAT,
    )
    return CraftWorkflow(
        name="威武皮盔：T1 元素伤害 + T1 生命底子",
        steps=[transmute, alteration, augmentation, regal, scour],
        start_step_id=transmute.id,
    )
