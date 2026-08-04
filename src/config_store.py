from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .models import AppSettings, MatchMode, MatchRule, RuleGroup, RuleSet


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def resolve_path(relative: str | Path) -> Path:
    path = Path(relative)
    if path.is_absolute():
        return path
    return project_root() / path


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def load_settings(path: Path | None = None) -> AppSettings:
    cfg_path = path or resolve_path("config/settings.json")
    data = load_json(cfg_path, {})
    if not isinstance(data, dict):
        data = {}
    return AppSettings.from_dict(data)


def save_settings(settings: AppSettings, path: Path | None = None) -> None:
    cfg_path = path or resolve_path("config/settings.json")
    save_json(cfg_path, settings.to_dict())


def load_ruleset(path: Path | None = None) -> RuleSet:
    rules_path = path or resolve_path("config/rules.json")
    data = load_json(rules_path, {})
    if not isinstance(data, dict):
        data = {}
    return RuleSet.from_dict(data)


def save_ruleset(ruleset: RuleSet, path: Path | None = None) -> None:
    rules_path = path or resolve_path("config/rules.json")
    save_json(rules_path, ruleset.to_dict())


def load_rules(path: Path | None = None) -> tuple[str, list[MatchRule]]:
    """兼容旧接口。新代码请用 load_ruleset。"""
    rs = load_ruleset(path)
    if rs.groups:
        return rs.groups[0].combine, list(rs.groups[0].rules)
    return MatchMode.ALL.value, []


def save_rules(
    match_mode: str,
    rules: list[MatchRule],
    path: Path | None = None,
) -> None:
    """兼容旧接口：保存为单组。"""
    rs = RuleSet(
        group_combine=MatchMode.ALL.value,
        groups=[
            RuleGroup(
                name="规则组 1",
                combine=match_mode or MatchMode.ALL.value,
                enabled=True,
                rules=list(rules),
            )
        ],
    )
    save_ruleset(rs, path)
