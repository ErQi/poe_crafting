from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .models import (
    AppSettings,
    CraftWorkflow,
    MatchMode,
    MatchRule,
    RuleGroup,
    RuleSet,
    WorkflowLibrary,
)
from .workflow import default_library


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


_OLD_FIXED_RES_NAMES = {"蓝装·生命+火抗", "蓝装·攻击元素+闪抗"}


def _migrate_any_t1_res(library: WorkflowLibrary) -> None:
    presets = {item.id: item for item in default_library().workflows}
    for index, item in enumerate(library.workflows):
        fresh = presets.get(item.id)
        if fresh is not None and item.name in _OLD_FIXED_RES_NAMES:
            library.workflows[index] = CraftWorkflow.from_dict(fresh.to_dict())


def _library_from_payload(data: Any) -> WorkflowLibrary | None:
    if not isinstance(data, dict):
        return None
    if isinstance(data.get("workflows"), list):
        library = WorkflowLibrary.from_dict(data)
        return library if library.workflows else None
    if data.get("steps"):
        workflow = CraftWorkflow.from_dict(data)
        if not workflow.steps:
            return None
        if not data.get("id"):
            workflow.id = "imported-legacy"
        if not workflow.group:
            workflow.group = "自定义"
        return WorkflowLibrary(active_id=workflow.id, workflows=[workflow])
    return None


def load_library(path: Path | None = None) -> WorkflowLibrary:
    primary = path or resolve_path("config/workflows.json")
    candidates = [primary]
    for extra in (
        resolve_path("config/workflows.json"),
        resolve_path("config/workflow.json"),
    ):
        if extra not in candidates:
            candidates.append(extra)

    library: WorkflowLibrary | None = None
    imported: CraftWorkflow | None = None
    for candidate in candidates:
        if not candidate.exists():
            continue
        parsed = _library_from_payload(load_json(candidate, {}))
        if parsed is None:
            continue
        if candidate.name == "workflow.json" and len(parsed.workflows) == 1:
            imported = parsed.workflows[0]
            continue
        if library is None:
            library = parsed

    if library is None:
        library = default_library()
    else:
        _migrate_any_t1_res(library)
    if imported is not None and imported.steps:
        if imported.id not in {item.id for item in library.workflows}:
            library.workflows.append(imported)
    if not library.get(library.active_id):
        library.active_id = library.workflows[0].id if library.workflows else ""
    return library


def save_library(library: WorkflowLibrary, path: Path | None = None) -> None:
    library_path = path or resolve_path("config/workflows.json")
    save_json(library_path, library.to_dict())


def load_workflow(path: Path | None = None) -> CraftWorkflow:
    return load_library(path).active()


def save_workflow(workflow: CraftWorkflow, path: Path | None = None) -> None:
    target = path or resolve_path("config/workflows.json")
    if target.exists():
        existing = _library_from_payload(load_json(target, {}))
        if existing is not None and len(existing.workflows) > 1:
            existing.put(workflow)
            existing.active_id = workflow.id
            save_library(existing, target)
            return
    save_json(target, workflow.to_dict())


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
