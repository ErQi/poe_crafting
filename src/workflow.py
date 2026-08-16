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
    WorkflowLibrary,
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


# 腰带 T1 按下限判断，不要求满 roll。
T1_LIFE = 130  # 丰饶的 130-144
T1_ELE_ATTACK = 43  # 毁灭的 43-50
T1_FIRE_DAMAGE = 26  # 督军的 26-30
T1_ELE_RES = 46  # 火/冰/闪 T1 46-48，抗性可互转
T1_GENERIC_ELE = 19  # 头盔「元素伤害提高」19-22


def _rule(pattern: str, threshold: float, note: str = "") -> MatchRule:
    return MatchRule(
        pattern=pattern,
        operator=">=",
        threshold=threshold,
        note=note,
    )


def _ruleset(name: str, combine: str, rules: list[MatchRule]) -> RuleSet:
    return RuleSet(
        group_combine=MatchMode.ALL.value,
        groups=[RuleGroup(name=name, combine=combine, rules=list(rules))],
    )


def _either(name: str, *rules: MatchRule) -> RuleSet:
    return _ruleset(name, MatchMode.ANY.value, list(rules))


def _both(name: str, *rules: MatchRule) -> RuleSet:
    return _ruleset(name, MatchMode.ALL.value, list(rules))


def _as_group(target: MatchRule | RuleGroup, name: str) -> RuleGroup:
    if isinstance(target, RuleGroup):
        return RuleGroup.from_dict(target.to_dict())
    return RuleGroup(name=name, combine=MatchMode.ALL.value, rules=[target])


def _pair_ruleset(combine: str, first: RuleGroup, second: RuleGroup) -> RuleSet:
    return RuleSet(group_combine=combine, groups=[first, second])


def life_rule(threshold: float = T1_LIFE) -> MatchRule:
    return _rule("最大生命", threshold, f"T1 ≥ {threshold:g}")


def ele_attack_rule(threshold: float = T1_ELE_ATTACK) -> MatchRule:
    return _rule("攻击技能的元素伤害提高", threshold, f"T1 ≥ {threshold:g}")


def fire_damage_rule(threshold: float = T1_FIRE_DAMAGE) -> MatchRule:
    return _rule("火焰伤害提高", threshold, f"T1 ≥ {threshold:g}")


def fire_res_rule(threshold: float = T1_ELE_RES) -> MatchRule:
    return _rule("火焰抗性", threshold, f"T1 ≥ {threshold:g}")


def cold_res_rule(threshold: float = T1_ELE_RES) -> MatchRule:
    return _rule("冰霜抗性", threshold, f"T1 ≥ {threshold:g}")


def lightning_res_rule(threshold: float = T1_ELE_RES) -> MatchRule:
    return _rule("闪电抗性", threshold, f"T1 ≥ {threshold:g}")


def any_t1_res_group(threshold: float = T1_ELE_RES) -> RuleGroup:
    return RuleGroup(
        name="T1 元素抗性（可转换）",
        combine=MatchMode.ANY.value,
        rules=[
            fire_res_rule(threshold),
            cold_res_rule(threshold),
            lightning_res_rule(threshold),
        ],
    )


def generic_ele_rule(threshold: float = T1_GENERIC_ELE) -> MatchRule:
    return _rule("元素伤害提高", threshold, f"T1 ≥ {threshold:g}")


def magic_two_mod_workflow(
    workflow_id: str,
    name: str,
    description: str,
    group: str,
    first: MatchRule | RuleGroup,
    second: MatchRule | RuleGroup,
) -> CraftWorkflow:
    """改造/增幅洗出两条目标的蓝装。"""

    prefix = workflow_id
    transmute_id = f"{prefix}__transmute"
    alteration_id = f"{prefix}__alteration"
    augment_id = f"{prefix}__augment"
    either = _pair_ruleset(
        MatchMode.ANY.value,
        _as_group(first, "目标 A"),
        _as_group(second, "目标 B"),
    )
    both = _pair_ruleset(
        MatchMode.ALL.value,
        _as_group(first, "目标 A"),
        _as_group(second, "目标 B"),
    )
    transmute = CraftStep(
        id=transmute_id,
        name="蜕变并检查任一目标",
        currency_template="currency_transmutation",
        expected_rarity="魔法",
        ruleset=either,
        on_success=f"{TRANSITION_GOTO_PREFIX}{augment_id}",
        on_failure=TRANSITION_NEXT,
    )
    alteration = CraftStep(
        id=alteration_id,
        name="改造洗出任一目标",
        currency_template="currency_alteration",
        expected_rarity="魔法",
        ruleset=either,
        on_success=TRANSITION_NEXT,
        on_failure=TRANSITION_REPEAT,
    )
    augmentation = CraftStep(
        id=augment_id,
        name="单词缀时增幅补另一目标",
        currency_template="currency_augmentation",
        expected_rarity="魔法",
        ruleset=both,
        on_success=TRANSITION_FINISH,
        on_failure=f"{TRANSITION_GOTO_PREFIX}{alteration_id}",
    )
    return CraftWorkflow(
        id=workflow_id,
        name=name,
        description=description,
        group=group,
        steps=[transmute, alteration, augmentation],
        start_step_id=transmute_id,
    )


def magic_one_mod_workflow(
    workflow_id: str,
    name: str,
    description: str,
    group: str,
    target: MatchRule,
) -> CraftWorkflow:
    """改造洗出单条目标前缀的蓝装。"""

    prefix = workflow_id
    transmute_id = f"{prefix}__transmute"
    alteration_id = f"{prefix}__alteration"
    hit = _both("命中目标前缀", target)
    transmute = CraftStep(
        id=transmute_id,
        name="蜕变并检查目标前缀",
        currency_template="currency_transmutation",
        expected_rarity="魔法",
        ruleset=hit,
        on_success=TRANSITION_FINISH,
        on_failure=TRANSITION_NEXT,
    )
    alteration = CraftStep(
        id=alteration_id,
        name="改造洗出目标前缀",
        currency_template="currency_alteration",
        expected_rarity="魔法",
        ruleset=hit,
        on_success=TRANSITION_FINISH,
        on_failure=TRANSITION_REPEAT,
    )
    return CraftWorkflow(
        id=workflow_id,
        name=name,
        description=description,
        group=group,
        steps=[transmute, alteration],
        start_step_id=transmute_id,
    )


def rare_two_prefix_workflow(
    workflow_id: str,
    name: str,
    description: str,
    group: str,
    first: MatchRule,
    second: MatchRule,
    step_ids: dict[str, str] | None = None,
) -> CraftWorkflow:
    """蜕变/改造/增幅/富豪做两条前缀的稀有底，失败重铸重来。"""

    ids = {
        "transmute": f"{workflow_id}__transmute",
        "alteration": f"{workflow_id}__alteration",
        "augment": f"{workflow_id}__augment",
        "regal": f"{workflow_id}__regal",
        "scour": f"{workflow_id}__scour",
    }
    if step_ids:
        ids.update(step_ids)
    either = _either("先保留任一 T1 目标", first, second)
    both = _both("同时具备两个 T1 目标", first, second)
    transmute = CraftStep(
        id=ids["transmute"],
        name="蜕变并检查任一目标",
        currency_template="currency_transmutation",
        expected_rarity="魔法",
        ruleset=either,
        on_success=f"{TRANSITION_GOTO_PREFIX}{ids['augment']}",
        on_failure=TRANSITION_NEXT,
    )
    alteration = CraftStep(
        id=ids["alteration"],
        name="改造洗出任一目标",
        currency_template="currency_alteration",
        expected_rarity="魔法",
        ruleset=either,
        on_success=TRANSITION_NEXT,
        on_failure=TRANSITION_REPEAT,
    )
    augmentation = CraftStep(
        id=ids["augment"],
        name="单词缀时增幅尝试补齐另一目标",
        currency_template="currency_augmentation",
        expected_rarity="魔法",
        ruleset=both,
        on_success=TRANSITION_NEXT,
        on_failure=TRANSITION_NEXT,
    )
    regal = CraftStep(
        id=ids["regal"],
        name="富豪尝试补齐两条目标",
        currency_template="currency_regal",
        expected_rarity="稀有",
        ruleset=both,
        on_success=TRANSITION_FINISH,
        on_failure=TRANSITION_NEXT,
    )
    scour = CraftStep(
        id=ids["scour"],
        name="富豪失败后重铸并重来",
        currency_template="currency_scouring",
        expected_rarity="普通",
        on_success=f"{TRANSITION_GOTO_PREFIX}{ids['transmute']}",
        on_failure=TRANSITION_REPEAT,
    )
    return CraftWorkflow(
        id=workflow_id,
        name=name,
        description=description,
        group=group,
        steps=[transmute, alteration, augmentation, regal, scour],
        start_step_id=ids["transmute"],
    )


def default_workflow() -> CraftWorkflow:
    """头盔示例：T1 元素伤害 + T1 生命。测试依赖这些步骤 ID。"""

    return rare_two_prefix_workflow(
        "helmet-ele-life",
        "头盔·元素+生命",
        "原示例。蜕变/改造/增幅/富豪做 T1 元素伤害 + T1 生命稀有底。",
        "其他",
        generic_ele_rule(),
        life_rule(),
        step_ids={
            "transmute": "transmute",
            "alteration": "alteration_t1_elemental",
            "augment": "augment_missing_target",
            "regal": "regal_t1_life",
            "scour": "scour_restart",
        },
    )


def belt_recombinator_workflows() -> list[CraftWorkflow]:
    group = "腰带重组"
    return [
        magic_two_mod_workflow(
            "belt-life-fireres",
            "蓝装·生命+抗性",
            "重组 A 料。86+ 腰带洗出 T1 生命 + 任意 T1 元素抗性（火/冰/闪可互转）。",
            group,
            life_rule(),
            any_t1_res_group(),
        ),
        magic_two_mod_workflow(
            "belt-ele-lightres",
            "蓝装·攻击元素+抗性",
            "重组 B 料。86+ 腰带洗出 T1 攻击元素伤害 + 任意 T1 元素抗性（火/冰/闪可互转）。",
            group,
            ele_attack_rule(),
            any_t1_res_group(),
        ),
        magic_one_mod_workflow(
            "belt-life-prefix",
            "补前缀·生命",
            "缺生命时用。洗出带 T1 生命的蓝装，两边点神力后再重组，约 1/3 出 2前2后。",
            group,
            life_rule(),
        ),
        magic_one_mod_workflow(
            "belt-ele-prefix",
            "补前缀·攻击元素",
            "缺攻击元素时用。洗出带 T1 攻击元素伤害的蓝装，两边点神力后再重组。",
            group,
            ele_attack_rule(),
        ),
        rare_two_prefix_workflow(
            "belt-warlord-life",
            "督军·火伤+生命",
            "2前2后之后。督军影响 86+ 腰带洗出 T1 火伤% + T1 生命，再重组第三前缀，约 1/2。",
            group,
            fire_damage_rule(),
            life_rule(),
        ),
        rare_two_prefix_workflow(
            "belt-warlord-ele",
            "督军·火伤+攻击元素",
            "2前2后之后。督军影响 86+ 腰带洗出 T1 火伤% + T1 攻击元素，再重组第三前缀。",
            group,
            fire_damage_rule(),
            ele_attack_rule(),
        ),
    ]


def default_library() -> WorkflowLibrary:
    workflows = belt_recombinator_workflows()
    helmet = default_workflow()
    helmet.name = "头盔·元素+生命"
    helmet.description = "原示例。蜕变/改造/增幅/富豪做 T1 元素伤害 + T1 生命稀有底。"
    helmet.group = "其他"
    workflows.append(helmet)
    return WorkflowLibrary(active_id=workflows[0].id, workflows=workflows)
