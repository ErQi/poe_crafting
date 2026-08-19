from __future__ import annotations

from pathlib import Path


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def resolve_path(relative: str | Path) -> Path:
    path = Path(relative)
    if path.is_absolute():
        return path
    return project_root() / path
