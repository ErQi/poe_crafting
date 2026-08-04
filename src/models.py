from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Optional
import uuid


class CraftMode(str, Enum):
    GENERIC = "generic"
    PRESET = "preset"


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
    LIFEFORCE_INSUFFICIENT = "lifeforce_insufficient"
    UNCHANGED = "unchanged"
    WINDOW_NOT_FOUND = "window_not_found"
    ERROR = "error"
    NOT_STARTED = "not_started"


# 预设工艺：显示名 -> 模板文件名（不含扩展名）
CRAFT_PRESETS: dict[str, str] = {
    "reforge": "reforge",
    "augment": "augment",
    "remove": "remove",
    "randomise": "randomise",
    "sacrifice": "sacrifice",
}

CRAFT_PRESET_LABELS: dict[str, str] = {
    "reforge": "重铸 (Reforge)",
    "augment": "增幅 (Augment)",
    "remove": "移除 (Remove)",
    "randomise": "随机 (Randomise)",
    "sacrifice": "献祭 (Sacrifice)",
}


@dataclass
class Affix:
    text: str
    values: list[float] = field(default_factory=list)

    @property
    def first_value(self) -> Optional[float]:
        return self.values[0] if self.values else None


@dataclass
class Item:
    rarity: str = ""
    name: str = ""
    base_type: str = ""
    item_level: Optional[int] = None
    affixes: list[Affix] = field(default_factory=list)
    corrupted: bool = False
    raw_text: str = ""
    flags: list[str] = field(default_factory=list)

    def affix_texts(self) -> list[str]:
        return [a.text for a in self.affixes]


@dataclass
class MatchRule:
    pattern: str
    operator: str = CompareOp.NONE.value
    threshold: Optional[float] = None
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
            enabled=bool(data.get("enabled", True)),
            note=str(data.get("note") or ""),
        )


@dataclass
class RuleGroup:
    """一组词缀条件。组内用 combine(all/any) 组合。"""

    name: str = "规则组"
    combine: str = MatchMode.ALL.value  # 组内 AND/OR
    enabled: bool = True
    rules: list[MatchRule] = field(default_factory=list)
    id: str = field(default_factory=lambda: str(uuid.uuid4()))

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "combine": self.combine,
            "enabled": self.enabled,
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
        combine = str(data.get("combine") or data.get("match_mode") or MatchMode.ALL.value)
        if combine not in (MatchMode.ALL.value, MatchMode.ANY.value):
            combine = MatchMode.ALL.value
        return cls(
            id=str(data.get("id") or uuid.uuid4()),
            name=str(data.get("name") or "规则组"),
            combine=combine,
            enabled=bool(data.get("enabled", True)),
            rules=rules,
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
class RuleHit:
    rule: MatchRule
    matched: bool
    matched_affix: Optional[str] = None
    actual_value: Optional[float] = None
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
        mark = "✓" if self.success else "✗"
        parts = []
        for h in self.hits:
            m = "✓" if h.matched else "✗"
            thr = h.rule.threshold if h.rule.threshold is not None else ""
            parts.append(f"{m}{h.rule.pattern}{h.rule.operator or ''}{thr}")
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
    craft_preset: str = "reforge"
    templates_dir: str = "assets/templates"
    rules_file: str = "config/rules.json"

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


def _optional_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
