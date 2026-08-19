from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Optional


class CraftMode(str, Enum):
    GENERIC = "generic"
    WORKFLOW = "workflow"


class MatchMode(str, Enum):
    ALL = "all"
    ANY = "any"


class CompareOp(str, Enum):
    NONE = ""
    GE = ">="
    GT = ">"
    LE = "<="
    LT = "<"
    EQ = "="


class StopReason(str, Enum):
    SUCCESS = "success"
    USER_STOP = "user_stop"
    MAX_ATTEMPTS = "max_attempts"
    PARSE_FAILURES = "parse_failures"
    TEMPLATE_NOT_FOUND = "template_not_found"
    CURRENCY_UNAVAILABLE = "currency_unavailable"
    UNCHANGED = "unchanged"
    WINDOW_NOT_FOUND = "window_not_found"
    WORKFLOW_STOP = "workflow_stop"
    ERROR = "error"
    NOT_STARTED = "not_started"


@dataclass
class Affix:
    text: str
    values: list[float] = field(default_factory=list)

    @property
    def first_value(self) -> Optional[float]:
        return self.values[0] if self.values else None

    @property
    def second_value(self) -> Optional[float]:
        return self.values[1] if len(self.values) > 1 else None


@dataclass
class Item:
    rarity: str = ""
    name: str = ""
    base_type: str = ""
    item_level: Optional[int] = None
    affixes: list[Affix] = field(default_factory=list)
    # 高级词缀说明中的前/后缀条数；用于判断魔法物品能否使用增幅石。
    # 老格式没有说明行时保持 None，并回退到实际词缀行数量。
    explicit_mod_count: Optional[int] = None
    corrupted: bool = False
    raw_text: str = ""
    flags: list[str] = field(default_factory=list)

    def affix_texts(self) -> list[str]:
        return [a.text for a in self.affixes]

    @property
    def craft_affix_count(self) -> int:
        if self.explicit_mod_count is not None:
            return self.explicit_mod_count
        return len(self.affixes)


@dataclass
class MatchRule:
    pattern: str
    operator: str = CompareOp.NONE.value
    threshold: Optional[float] = None
    # 双数值词缀的第二个阈值，例如「攻击附加 6 - 12 …」
    threshold2: Optional[float] = None
    enabled: bool = True
    note: str = ""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MatchRule":
        return cls(
            id=str(data.get("id") or uuid.uuid4()),
            pattern=str(data.get("pattern") or ""),
            operator=str(data.get("operator") or ""),
            threshold=_optional_float(data.get("threshold")),
            threshold2=_optional_float(data.get("threshold2")),
            enabled=bool(data.get("enabled", True)),
            note=str(data.get("note") or ""),
        )


@dataclass
class RuleGroup:
    """一组词缀条件。组内用 combine(all/any)，或至少命中 min_matches 条。"""

    name: str = "规则组"
    combine: str = MatchMode.ALL.value  # 组内 AND/OR
    enabled: bool = True
    rules: list[MatchRule] = field(default_factory=list)
    # 填了就按「至少命中 N 条」判断，忽略组内 AND/OR
    min_matches: Optional[int] = None
    id: str = field(default_factory=lambda: str(uuid.uuid4()))

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "combine": self.combine,
            "enabled": self.enabled,
            "min_matches": self.min_matches,
            "rules": [r.to_dict() for r in self.rules],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RuleGroup":
        raw_rules = data.get("rules") or []
        rules: list[MatchRule] = []
        if isinstance(raw_rules, list):
            for item in raw_rules:
                if isinstance(item, dict):
                    rules.append(MatchRule.from_dict(item))
        combine = str(
            data.get("combine") or data.get("match_mode") or MatchMode.ALL.value
        )
        if combine not in (MatchMode.ALL.value, MatchMode.ANY.value):
            combine = MatchMode.ALL.value
        min_matches = _optional_int(data.get("min_matches"))
        if min_matches is not None and min_matches < 1:
            min_matches = None
        return cls(
            id=str(data.get("id") or uuid.uuid4()),
            name=str(data.get("name") or "规则组"),
            combine=combine,
            enabled=bool(data.get("enabled", True)),
            rules=rules,
            min_matches=min_matches,
        )


@dataclass
class RuleSet:
    """多组规则。组间用 group_combine(all/any) 组合。"""

    group_combine: str = MatchMode.ALL.value  # 组间 AND/OR
    groups: list[RuleGroup] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": 2,
            "group_combine": self.group_combine,
            "groups": [g.to_dict() for g in self.groups],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RuleSet":
        if not isinstance(data, dict):
            return cls()

        # 新格式：groups
        if isinstance(data.get("groups"), list):
            groups = [
                RuleGroup.from_dict(g) for g in data["groups"] if isinstance(g, dict)
            ]
            combine = str(data.get("group_combine") or MatchMode.ALL.value)
            if combine not in (MatchMode.ALL.value, MatchMode.ANY.value):
                combine = MatchMode.ALL.value
            if not groups:
                groups = [RuleGroup(name="规则组 1")]
            return cls(group_combine=combine, groups=groups)

        # 旧格式兼容：match_mode + rules → 单组
        mode = str(data.get("match_mode") or MatchMode.ALL.value)
        if mode not in (MatchMode.ALL.value, MatchMode.ANY.value):
            mode = MatchMode.ALL.value
        raw_rules = data.get("rules") or []
        rules: list[MatchRule] = []
        if isinstance(raw_rules, list):
            for item in raw_rules:
                if isinstance(item, dict):
                    rules.append(MatchRule.from_dict(item))
        return cls(
            group_combine=MatchMode.ALL.value,
            groups=[
                RuleGroup(
                    name="规则组 1",
                    combine=mode,
                    enabled=True,
                    rules=rules,
                )
            ],
        )

    def enabled_groups(self) -> list[RuleGroup]:
        return [g for g in self.groups if g.enabled]

    def all_rules_flat(self) -> list[MatchRule]:
        out: list[MatchRule] = []
        for g in self.groups:
            out.extend(g.rules)
        return out


@dataclass
class CraftStep:
    """多步骤通货流程中的一个动作与其结果分支。"""

    name: str = "新步骤"
    currency_template: str = ""
    expected_rarity: str = ""
    ruleset: RuleSet = field(
        default_factory=lambda: RuleSet(groups=[RuleGroup(name="本步条件")])
    )
    on_success: str = "next"
    on_failure: str = "repeat"
    enabled: bool = True
    id: str = field(default_factory=lambda: str(uuid.uuid4()))

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "enabled": self.enabled,
            "currency_template": self.currency_template,
            "expected_rarity": self.expected_rarity,
            "ruleset": self.ruleset.to_dict(),
            "on_success": self.on_success,
            "on_failure": self.on_failure,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CraftStep":
        raw_ruleset = data.get("ruleset")
        if not isinstance(raw_ruleset, dict):
            # 兼容早期草案中直接放在 step.rules 的单组格式。
            raw_rules = data.get("rules") if isinstance(data.get("rules"), list) else []
            raw_ruleset = {
                "match_mode": str(data.get("match_mode") or MatchMode.ALL.value),
                "rules": raw_rules,
            }
        return cls(
            id=str(data.get("id") or uuid.uuid4()),
            name=str(data.get("name") or "新步骤"),
            enabled=bool(data.get("enabled", True)),
            currency_template=str(data.get("currency_template") or "").strip(),
            expected_rarity=str(data.get("expected_rarity") or "").strip(),
            ruleset=RuleSet.from_dict(raw_ruleset),
            on_success=str(data.get("on_success") or "next"),
            on_failure=str(data.get("on_failure") or "repeat"),
        )


@dataclass
class CraftWorkflow:
    """可持久化的多步骤通货制作流程。"""

    name: str = "多步骤通货流程"
    steps: list[CraftStep] = field(default_factory=list)
    start_step_id: str = ""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    description: str = ""
    group: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": 1,
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "group": self.group,
            "start_step_id": self.start_step_id,
            "steps": [step.to_dict() for step in self.steps],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CraftWorkflow":
        if not isinstance(data, dict):
            return cls()
        raw_steps = data.get("steps") if isinstance(data.get("steps"), list) else []
        steps = [CraftStep.from_dict(x) for x in raw_steps if isinstance(x, dict)]
        start_step_id = str(data.get("start_step_id") or "")
        if start_step_id and not any(step.id == start_step_id for step in steps):
            start_step_id = ""
        return cls(
            id=str(data.get("id") or uuid.uuid4()),
            name=str(data.get("name") or "多步骤通货流程"),
            description=str(data.get("description") or ""),
            group=str(data.get("group") or ""),
            steps=steps,
            start_step_id=start_step_id,
        )

    def enabled_steps(self) -> list[CraftStep]:
        return [step for step in self.steps if step.enabled]

    def get_step(self, step_id: str) -> Optional[CraftStep]:
        return next((step for step in self.steps if step.id == step_id), None)


@dataclass
class WorkflowLibrary:
    """多套工艺流程，界面上可快速切换。"""

    active_id: str = ""
    workflows: list[CraftWorkflow] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": 2,
            "active_id": self.active_id,
            "workflows": [workflow.to_dict() for workflow in self.workflows],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "WorkflowLibrary":
        if not isinstance(data, dict):
            return cls()
        raw = data.get("workflows") if isinstance(data.get("workflows"), list) else []
        workflows = [
            CraftWorkflow.from_dict(item) for item in raw if isinstance(item, dict)
        ]
        seen: set[str] = set()
        unique: list[CraftWorkflow] = []
        for workflow in workflows:
            if workflow.id in seen:
                workflow.id = str(uuid.uuid4())
            seen.add(workflow.id)
            unique.append(workflow)
        active_id = str(data.get("active_id") or "")
        if active_id and not any(item.id == active_id for item in unique):
            active_id = ""
        if not active_id and unique:
            active_id = unique[0].id
        return cls(active_id=active_id, workflows=unique)

    def get(self, workflow_id: str) -> Optional[CraftWorkflow]:
        return next((item for item in self.workflows if item.id == workflow_id), None)

    def active(self) -> CraftWorkflow:
        current = self.get(self.active_id)
        if current is not None:
            return current
        if self.workflows:
            self.active_id = self.workflows[0].id
            return self.workflows[0]
        empty = CraftWorkflow(name="空流程", group="自定义")
        self.workflows.append(empty)
        self.active_id = empty.id
        return empty

    def select(self, workflow_id: str) -> CraftWorkflow:
        target = self.get(workflow_id)
        if target is None:
            return self.active()
        self.active_id = workflow_id
        return target

    def put(self, workflow: CraftWorkflow) -> None:
        if not workflow.id:
            workflow.id = str(uuid.uuid4())
        for index, existing in enumerate(self.workflows):
            if existing.id == workflow.id:
                self.workflows[index] = workflow
                return
        self.workflows.append(workflow)

    def remove(self, workflow_id: str) -> bool:
        if len(self.workflows) <= 1:
            return False
        self.workflows = [item for item in self.workflows if item.id != workflow_id]
        if self.active_id == workflow_id:
            self.active_id = self.workflows[0].id if self.workflows else ""
        return True

    def grouped(self) -> list[tuple[str, list[CraftWorkflow]]]:
        order = ("腰带重组", "其他", "自定义")
        buckets: dict[str, list[CraftWorkflow]] = {name: [] for name in order}
        extras: list[tuple[str, list[CraftWorkflow]]] = []
        extra_index: dict[str, int] = {}
        for workflow in self.workflows:
            group = workflow.group.strip() or "自定义"
            if group in buckets:
                buckets[group].append(workflow)
                continue
            if group not in extra_index:
                extra_index[group] = len(extras)
                extras.append((group, []))
            extras[extra_index[group]][1].append(workflow)
        result = [(name, items) for name, items in buckets.items() if items]
        result.extend(extras)
        return result


@dataclass
class RuleHit:
    rule: MatchRule
    matched: bool
    matched_affix: Optional[str] = None
    actual_value: Optional[float] = None
    actual_values: list[float] = field(default_factory=list)
    reason: str = ""
    group_id: str = ""
    group_name: str = ""


@dataclass
class GroupMatchResult:
    group: RuleGroup
    success: bool
    hits: list[RuleHit] = field(default_factory=list)

    @property
    def summary(self) -> str:
        logic = "AND" if self.group.combine == MatchMode.ALL.value else "OR"
        if self.group.min_matches:
            logic = f"至少{self.group.min_matches}"
        mark = "✓" if self.success else "✗"
        parts = []
        for h in self.hits:
            m = "✓" if h.matched else "✗"
            threshold = h.rule.threshold
            thr = f"{threshold:g}" if threshold is not None else ""
            if h.rule.threshold2 is not None:
                thr = (
                    f"{thr}-{h.rule.threshold2:g}" if thr else f"{h.rule.threshold2:g}"
                )
            actual = ""
            if h.actual_values:
                actual = "（实际=" + "-".join(f"{v:g}" for v in h.actual_values) + "）"
            elif h.actual_value is not None:
                actual = f"（实际={h.actual_value:g}）"
            parts.append(f"{m}{h.rule.pattern}{h.rule.operator or ''}{thr}{actual}")
        body = " · ".join(parts) if parts else "(空组)"
        return f"{mark}[{self.group.name}|{logic}] {body}"


@dataclass
class MatchResult:
    success: bool
    mode: str  # 组间逻辑 all/any
    hits: list[RuleHit] = field(default_factory=list)
    group_results: list[GroupMatchResult] = field(default_factory=list)

    @property
    def summary(self) -> str:
        if self.group_results:
            logic = "AND" if self.mode == MatchMode.ALL.value else "OR"
            parts = [gr.summary for gr in self.group_results]
            return f"组间{logic}: " + " || ".join(parts)
        parts = []
        for h in self.hits:
            mark = "✓" if h.matched else "✗"
            parts.append(
                f"{mark} {h.rule.pattern}{h.rule.operator or ''}{h.rule.threshold if h.rule.threshold is not None else ''}"
            )
        return " | ".join(parts) if parts else "(无启用规则)"


@dataclass
class AppSettings:
    window_title_keywords: list[str] = field(
        default_factory=lambda: ["Path of Exile", "流放之路"]
    )
    hotkey_stop: str = "f8"
    hotkey_start: str = "f7"
    max_attempts: int = 200
    max_parse_failures: int = 5
    max_unchanged: int = 8
    action_delay_ms: int = 350
    craft_wait_ms: int = 600
    clipboard_timeout_ms: int = 1500
    clipboard_poll_ms: int = 50
    template_threshold: float = 0.82
    match_mode: str = MatchMode.ALL.value
    craft_mode: str = CraftMode.GENERIC.value
    templates_dir: str = "assets/templates"
    rules_file: str = "config/rules.json"
    workflow_file: str = "config/workflows.json"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AppSettings":
        base = cls()
        known = {f.name for f in base.__dataclass_fields__.values()}  # type: ignore[attr-defined]
        kwargs: dict[str, Any] = {}
        for k, v in data.items():
            if k in known:
                kwargs[k] = v
        return cls(**{**asdict(base), **kwargs})


@dataclass
class RunStatus:
    running: bool = False
    attempt: int = 0
    parse_failures: int = 0
    unchanged_streak: int = 0
    last_item: Optional[Item] = None
    last_match: Optional[MatchResult] = None
    stop_reason: StopReason = StopReason.NOT_STARTED
    message: str = ""
    workflow_step_name: str = ""
    workflow_step_index: int = 0
    workflow_name: str = ""


def _optional_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _optional_int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
