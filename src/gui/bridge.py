"""pywebview 暴露给 Vue 的最小 JS API。"""

from __future__ import annotations

from typing import Any


class JsApi:
    def __init__(self, host: Any) -> None:
        self._h = host

    def get_state(self) -> dict:
        return self._h.snapshot()

    def get_runtime(self) -> dict:
        return self._h.runtime()

    def select_workflow(self, workflow_id: str) -> dict:
        return self._h.select_workflow(str(workflow_id or ""))

    def new(self, group: str = "自定义") -> dict:
        return self._h.new_workflow(str(group or "自定义"))

    def new_workflow(self, group: str = "自定义") -> dict:
        return self.new(group)

    def duplicate(self) -> dict:
        return self._h.duplicate_workflow()

    def duplicate_workflow(self) -> dict:
        return self.duplicate()

    def delete(self) -> dict:
        return self._h.delete_workflow()

    def delete_workflow(self) -> dict:
        return self.delete()

    def save_workflow(self) -> dict:
        return self._h.save_workflow()

    def update_workflow_fields(self, fields: dict | None = None) -> dict:
        return self._h.update_workflow_fields(fields or {})

    def update_step(self, step_id: str, fields: dict | None = None) -> dict:
        return self._h.update_step(str(step_id or ""), fields or {})

    def add_step(self) -> dict:
        return self._h.add_step()

    def remove_step(self, step_id: str) -> dict:
        return self._h.remove_step(str(step_id or ""))

    def move_step(self, step_id: str, direction: int = 0) -> dict:
        return self._h.move_step(str(step_id or ""), int(direction or 0))

    def update_rules(self, ruleset: dict | None = None, step_id: str | None = None) -> dict:
        return self._h.update_rules(ruleset or {}, step_id)

    def set_ui_page(self, page: str = "") -> dict:
        return self._h.set_ui_page(str(page or ""))

    def prepare_start(self, kind: str = "") -> dict:
        return self._h.prepare_start(str(kind or ""))

    def start(self, kind: str = "") -> dict:
        return self._h.start(str(kind or ""))

    def stop(self) -> dict:
        return self._h.stop()

    def update_settings(self, patch: dict | None = None) -> dict:
        return self._h.update_settings(patch or {})

    def save_settings(self) -> dict:
        return self._h.save_settings()

    def save_rules(self) -> dict:
        return self._h.save_rules()

    def refresh_item(self) -> dict:
        return self._h.refresh_item()

    def parse_clipboard(self) -> dict:
        return self._h.parse_clipboard()

    def list_templates(self) -> dict:
        return self._h.list_templates()

    def paste_template(self) -> dict:
        return self._h.paste_template()

    def save_template(self, key: str, overwrite: bool = False) -> dict:
        return self._h.save_template(str(key or ""), bool(overwrite))

    def open_templates_dir(self) -> dict:
        return self._h.open_templates_dir()

    def refresh_templates(self) -> dict:
        return self._h.refresh_templates()

    def test_templates(self) -> dict:
        return self._h.test_templates()
