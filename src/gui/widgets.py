from __future__ import annotations

from pathlib import Path
from typing import Callable, Optional

import customtkinter as ctk
import tkinter as tk
from PIL import Image
from tkinter import messagebox, simpledialog

from ..config_store import resolve_path
from ..matcher import format_threshold_text, normalize_operator, parse_threshold_text
from ..models import (
    CRAFT_PRESET_LABELS,
    MatchMode,
    MatchRule,
    RuleGroup,
    RuleSet,
)
from ..template_io import (
    ClipboardImageError,
    get_clipboard_image,
    load_template_image,
    save_template_image,
    thumbnail_fit,
)


OPS = ["", ">=", ">", "<=", "<", "="]

TEMPLATE_SLOT_DEFS: list[tuple[str, str, bool]] = [
    ("craft_button", "执行工艺按钮", True),
    ("item_slot", "目标装备位置（工艺槽/背包）", True),
    ("not_enough_lifeforce", "生命力不足提示", False),
]
for _k, _label in CRAFT_PRESET_LABELS.items():
    TEMPLATE_SLOT_DEFS.append((_k, f"预设 · {_label}", False))


def _mode_label(mode: str) -> str:
    return "OR (任一)" if mode == MatchMode.ANY.value else "AND (全部)"


def _mode_from_label(label: str) -> str:
    if "OR" in label or "任一" in label:
        return MatchMode.ANY.value
    return MatchMode.ALL.value


class RuleSetEditor(ctk.CTkFrame):
    """多组规则编辑：组间 AND/OR + 组内 AND/OR。"""

    def __init__(
        self,
        master,
        on_change: Optional[Callable[[RuleSet], None]] = None,
        **kwargs,
    ) -> None:
        super().__init__(master, **kwargs)
        self.on_change = on_change
        self._ruleset = RuleSet(groups=[RuleGroup(name="规则组 1")])
        self._selected_group = 0
        self._selected_rule: Optional[int] = None
        self._rule_rows: list[dict] = []

        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(2, weight=1)

        # 组间逻辑
        top = ctk.CTkFrame(self, fg_color="transparent")
        top.grid(row=0, column=0, sticky="ew", padx=4, pady=(4, 2))
        ctk.CTkLabel(top, text="组间逻辑:").pack(side="left")
        self.group_combine_menu = ctk.CTkSegmentedButton(
            top,
            values=["AND (全部)", "OR (任一)"],
            command=self._on_group_combine,
        )
        self.group_combine_menu.pack(side="left", padx=8)
        self.group_combine_menu.set("AND (全部)")
        ctk.CTkLabel(
            top,
            text="组间 AND=每组都要满足；OR=任一组满足即可",
            text_color="gray",
            font=ctk.CTkFont(size=11),
        ).pack(side="left", padx=8)

        # 组列表 + 操作
        mid = ctk.CTkFrame(self, fg_color="transparent")
        mid.grid(row=1, column=0, sticky="ew", padx=4, pady=4)
        mid.grid_columnconfigure(0, weight=1)

        self.group_list = ctk.CTkSegmentedButton(
            mid, values=["规则组 1"], command=self._on_select_group_label
        )
        self.group_list.grid(row=0, column=0, sticky="ew", padx=(0, 8))

        gbtns = ctk.CTkFrame(mid, fg_color="transparent")
        gbtns.grid(row=0, column=1, sticky="e")
        ctk.CTkButton(gbtns, text="加组", width=56, command=self._add_group).pack(
            side="left", padx=2
        )
        ctk.CTkButton(
            gbtns, text="删组", width=56, fg_color="#8B3A3A", command=self._del_group
        ).pack(side="left", padx=2)
        ctk.CTkButton(
            gbtns, text="改名", width=56, fg_color="#3a3a3a", command=self._rename_group
        ).pack(side="left", padx=2)

        # 当前组详情
        body = ctk.CTkFrame(self)
        body.grid(row=2, column=0, sticky="nsew", padx=4, pady=4)
        body.grid_columnconfigure(0, weight=1)
        body.grid_rowconfigure(2, weight=1)

        ghead = ctk.CTkFrame(body, fg_color="transparent")
        ghead.grid(row=0, column=0, sticky="ew", padx=8, pady=(8, 4))
        self.group_title = ctk.CTkLabel(
            ghead, text="规则组 1", font=ctk.CTkFont(weight="bold")
        )
        self.group_title.pack(side="left")
        self.group_enabled = tk.BooleanVar(value=True)
        ctk.CTkCheckBox(
            ghead,
            text="启用本组",
            variable=self.group_enabled,
            command=self._on_group_enabled,
        ).pack(side="left", padx=12)
        ctk.CTkLabel(ghead, text="组内逻辑:").pack(side="left", padx=(12, 4))
        self.inner_combine_menu = ctk.CTkSegmentedButton(
            ghead,
            values=["AND (全部)", "OR (任一)"],
            command=self._on_inner_combine,
        )
        self.inner_combine_menu.pack(side="left")
        self.inner_combine_menu.set("AND (全部)")
        ctk.CTkLabel(ghead, text="至少匹配").pack(side="left", padx=(12, 4))
        self.min_matches_entry = ctk.CTkEntry(
            ghead, width=44, placeholder_text="空=逻辑"
        )
        self.min_matches_entry.pack(side="left")
        self.min_matches_entry.bind(
            "<FocusOut>", lambda _e: self._on_min_matches_change()
        )
        ctk.CTkLabel(
            ghead, text="条", text_color="gray", font=ctk.CTkFont(size=11)
        ).pack(side="left", padx=(2, 0))

        header = ctk.CTkFrame(body, fg_color="transparent")
        header.grid(row=1, column=0, sticky="ew", padx=8, pady=2)
        for text, w in (
            ("启用", 40),
            ("包含文本(可多词)", 170),
            ("算子", 60),
            ("阈值(可6-12)", 90),
            ("备注", 100),
        ):
            ctk.CTkLabel(header, text=text, width=w, anchor="w").pack(
                side="left", padx=2
            )

        self.list_host = ctk.CTkScrollableFrame(body, height=160)
        self.list_host.grid(row=2, column=0, sticky="nsew", padx=6, pady=4)

        # 组内条件操作（放在列表下方，避免找不到）
        rule_ops = ctk.CTkFrame(body, fg_color="transparent")
        rule_ops.grid(row=3, column=0, sticky="ew", padx=8, pady=(4, 2))
        ctk.CTkButton(
            rule_ops,
            text="+ 添加词缀条件",
            width=130,
            command=self.add_rule,
            fg_color="#2d6a4f",
            hover_color="#1b4332",
        ).pack(side="left", padx=(0, 8))
        ctk.CTkButton(
            rule_ops,
            text="删除选中条件",
            width=110,
            command=self.delete_selected,
            fg_color="#8B3A3A",
            hover_color="#6a2828",
        ).pack(side="left")

        tip = ctk.CTkLabel(
            body,
            text="至少匹配填数字则本组命中N条即可；包含文本可用空格/逗号写多关键字，如：攻击附加 冰霜伤害",
            text_color="gray",
            font=ctk.CTkFont(size=11),
            anchor="w",
        )
        tip.grid(row=4, column=0, sticky="ew", padx=8, pady=(0, 6))

    # ---- public ----
    def set_ruleset(self, ruleset: RuleSet) -> None:
        self._ruleset = RuleSet.from_dict(ruleset.to_dict())
        if not self._ruleset.groups:
            self._ruleset.groups = [RuleGroup(name="规则组 1")]
        self._selected_group = 0
        self._selected_rule = None
        self._refresh_group_tabs()
        self._load_current_group_to_ui()

    def get_ruleset(self) -> RuleSet:
        self._sync_current_group_from_ui()
        return RuleSet.from_dict(self._ruleset.to_dict())

    # 兼容旧 RulesTable API
    def set_rules(self, rules: list[MatchRule]) -> None:
        self.set_ruleset(
            RuleSet(
                group_combine=MatchMode.ALL.value,
                groups=[
                    RuleGroup(
                        name="规则组 1", combine=MatchMode.ALL.value, rules=list(rules)
                    )
                ],
            )
        )

    def get_rules(self) -> list[MatchRule]:
        rs = self.get_ruleset()
        return rs.all_rules_flat()

    def add_rule(self) -> None:
        self._sync_current_group_from_ui()
        g = self._current_group()
        g.rules.append(MatchRule(pattern="", enabled=True))
        self._rebuild_rules()
        self._emit()

    def delete_selected(self) -> None:
        self._sync_current_group_from_ui()
        g = self._current_group()
        if not g.rules:
            return
        if self._selected_rule is not None and 0 <= self._selected_rule < len(g.rules):
            g.rules.pop(self._selected_rule)
        else:
            g.rules.pop()
        self._selected_rule = None
        self._rebuild_rules()
        self._emit()

    # ---- internal ----
    def _current_group(self) -> RuleGroup:
        if not self._ruleset.groups:
            self._ruleset.groups = [RuleGroup(name="规则组 1")]
        if self._selected_group >= len(self._ruleset.groups):
            self._selected_group = 0
        return self._ruleset.groups[self._selected_group]

    def _emit(self) -> None:
        if self.on_change:
            self.on_change(self.get_ruleset())

    def _refresh_group_tabs(self) -> None:
        labels = []
        for i, g in enumerate(self._ruleset.groups):
            mark = "" if g.enabled else "∅"
            if g.min_matches:
                logic = f"≥{g.min_matches}"
            else:
                logic = "∨" if g.combine == MatchMode.ANY.value else "∧"
            labels.append(f"{mark}{g.name}[{logic}]"[:18])
        if not labels:
            labels = ["规则组 1"]
        # SegmentedButton 需要重建 values
        try:
            self.group_list.configure(values=labels)
        except Exception:
            pass
        sel = labels[min(self._selected_group, len(labels) - 1)]
        try:
            self.group_list.set(sel)
        except Exception:
            pass
        self.group_combine_menu.set(_mode_label(self._ruleset.group_combine))

    def _on_select_group_label(self, label: str) -> None:
        self._sync_current_group_from_ui()
        labels = list(self.group_list.cget("values"))
        try:
            idx = labels.index(label)
        except ValueError:
            idx = 0
        self._selected_group = idx
        self._selected_rule = None
        self._load_current_group_to_ui()

    def _load_current_group_to_ui(self) -> None:
        g = self._current_group()
        self.group_title.configure(text=g.name)
        self.group_enabled.set(g.enabled)
        self.inner_combine_menu.set(_mode_label(g.combine))
        self.min_matches_entry.delete(0, "end")
        if g.min_matches:
            self.min_matches_entry.insert(0, str(g.min_matches))
        self._rebuild_rules()

    def _sync_current_group_from_ui(self) -> None:
        if not self._ruleset.groups:
            return
        g = self._current_group()
        g.enabled = bool(self.group_enabled.get())
        g.combine = _mode_from_label(self.inner_combine_menu.get())
        raw_min = self.min_matches_entry.get().strip()
        if raw_min == "":
            g.min_matches = None
        else:
            try:
                n = int(raw_min)
                g.min_matches = n if n >= 1 else None
            except ValueError:
                g.min_matches = None
        # rules from widgets
        updated: list[MatchRule] = []
        for i, row in enumerate(self._rule_rows):
            if i >= len(g.rules):
                break
            rule = g.rules[i]
            rule.enabled = bool(row["enabled"].get())
            rule.pattern = row["pattern"].get().strip()
            op = row["op"].get()
            rule.operator = normalize_operator("" if op in ("(无)", "无", None) else op)
            rule.threshold, rule.threshold2 = parse_threshold_text(
                row["threshold"].get()
            )
            rule.note = row["note"].get().strip()
            updated.append(rule)
        if len(updated) == len(g.rules):
            g.rules = updated
        self._ruleset.group_combine = _mode_from_label(self.group_combine_menu.get())

    def _on_group_combine(self, value: str) -> None:
        self._ruleset.group_combine = _mode_from_label(value)
        self._emit()

    def _on_inner_combine(self, value: str) -> None:
        g = self._current_group()
        g.combine = _mode_from_label(value)
        self._refresh_group_tabs()
        self._emit()

    def _on_min_matches_change(self) -> None:
        self._sync_current_group_from_ui()
        self._refresh_group_tabs()
        self._emit()

    def _on_group_enabled(self) -> None:
        g = self._current_group()
        g.enabled = bool(self.group_enabled.get())
        self._refresh_group_tabs()
        self._emit()

    def _add_group(self) -> None:
        self._sync_current_group_from_ui()
        n = len(self._ruleset.groups) + 1
        self._ruleset.groups.append(
            RuleGroup(name=f"规则组 {n}", combine=MatchMode.ALL.value)
        )
        self._selected_group = len(self._ruleset.groups) - 1
        self._refresh_group_tabs()
        self._load_current_group_to_ui()
        self._emit()

    def _del_group(self) -> None:
        self._sync_current_group_from_ui()
        if len(self._ruleset.groups) <= 1:
            messagebox.showinfo("删组", "至少保留一个规则组")
            return
        self._ruleset.groups.pop(self._selected_group)
        self._selected_group = max(0, self._selected_group - 1)
        self._refresh_group_tabs()
        self._load_current_group_to_ui()
        self._emit()

    def _rename_group(self) -> None:
        g = self._current_group()
        name = simpledialog.askstring(
            "改名", "规则组名称:", initialvalue=g.name, parent=self
        )
        if name is None:
            return
        name = name.strip() or g.name
        g.name = name
        self._refresh_group_tabs()
        self.group_title.configure(text=g.name)
        self._emit()

    def _select_rule(self, idx: int) -> None:
        self._selected_rule = idx
        for i, row in enumerate(self._rule_rows):
            try:
                row["frame"].configure(
                    fg_color=("gray30" if i == idx else "transparent")
                )
            except Exception:
                pass

    def _rebuild_rules(self) -> None:
        for child in self.list_host.winfo_children():
            child.destroy()
        self._rule_rows.clear()
        g = self._current_group()
        if not g.rules:
            empty = ctk.CTkLabel(
                self.list_host,
                text="本组还没有词缀条件\n点击下方「+ 添加词缀条件」",
                text_color="gray",
                justify="center",
            )
            empty.pack(expand=True, pady=24)
            return
        for idx, rule in enumerate(g.rules):
            frame = ctk.CTkFrame(self.list_host, fg_color="transparent")
            frame.pack(fill="x", pady=2)
            frame.bind("<Button-1>", lambda _e, i=idx: self._select_rule(i))

            en_var = tk.BooleanVar(value=rule.enabled)
            ctk.CTkCheckBox(
                frame, text="", variable=en_var, width=40, command=self._emit
            ).pack(side="left", padx=2)

            pattern = ctk.CTkEntry(frame, width=150)
            pattern.insert(0, rule.pattern)
            pattern.pack(side="left", padx=2)
            pattern.bind("<FocusOut>", lambda _e: self._emit())
            pattern.bind("<Button-1>", lambda _e, i=idx: self._select_rule(i))

            op_values = ["(无)"] + [o for o in OPS if o]
            op_menu = ctk.CTkOptionMenu(
                frame, values=op_values, width=70, command=lambda _v: self._emit()
            )
            cur_op = rule.operator if rule.operator in OPS and rule.operator else "(无)"
            op_menu.set(cur_op)
            op_menu.pack(side="left", padx=2)

            thr = ctk.CTkEntry(frame, width=90)
            formatted = format_threshold_text(rule.threshold, rule.threshold2)
            if formatted:
                thr.insert(0, formatted)
            thr.pack(side="left", padx=2)
            thr.bind("<FocusOut>", lambda _e: self._emit())

            note = ctk.CTkEntry(frame, width=120)
            note.insert(0, rule.note)
            note.pack(side="left", padx=2, fill="x", expand=True)
            note.bind("<FocusOut>", lambda _e: self._emit())

            self._rule_rows.append(
                {
                    "frame": frame,
                    "enabled": en_var,
                    "pattern": pattern,
                    "op": op_menu,
                    "threshold": thr,
                    "note": note,
                }
            )


# 兼容旧名称
RulesTable = RuleSetEditor


class TemplatePastePanel(ctk.CTkFrame):
    """模板配置：Ctrl+V / 粘贴按钮把剪贴板图片存为模板。"""

    PREVIEW_MAX = (280, 150)
    SLOT_THUMB = (72, 48)

    def __init__(
        self,
        master,
        templates_dir: str | Path,
        on_log: Optional[Callable[[str], None]] = None,
        on_saved: Optional[Callable[[str, Path], None]] = None,
        **kwargs,
    ) -> None:
        super().__init__(master, **kwargs)
        self.templates_dir = resolve_path(templates_dir)
        self.on_log = on_log or (lambda _m: None)
        self.on_saved = on_saved
        self._pending: Optional[Image.Image] = None
        self._pending_ctk: Optional[ctk.CTkImage] = None
        self._slot_images: dict[str, ctk.CTkImage] = {}
        self._selected_key = "craft_button"
        self._slot_cards: dict[str, ctk.CTkFrame] = {}

        self.grid_columnconfigure(0, weight=2)
        self.grid_columnconfigure(1, weight=3)
        self.grid_rowconfigure(1, weight=1)

        self._build()
        self.refresh_slots()

    def set_templates_dir(self, templates_dir: str | Path) -> None:
        self.templates_dir = resolve_path(templates_dir)
        self.refresh_slots()

    def bind_paste_shortcuts(self, widget) -> None:
        widget.bind_all("<Control-v>", self._on_global_paste, add="+")
        widget.bind_all("<Control-V>", self._on_global_paste, add="+")

    def _build(self) -> None:
        head = ctk.CTkFrame(self, fg_color="transparent")
        head.grid(row=0, column=0, columnspan=2, sticky="ew", padx=12, pady=(12, 6))
        ctk.CTkLabel(
            head,
            text="模板配置",
            font=ctk.CTkFont(size=16, weight="bold"),
        ).pack(side="left")
        ctk.CTkLabel(
            head,
            text="Win+Shift+S 截图 → Ctrl+V 粘贴 → 保存",
            text_color="gray",
        ).pack(side="left", padx=12)

        # 左：粘贴区
        left = ctk.CTkFrame(self)
        left.grid(row=1, column=0, sticky="nsew", padx=(12, 6), pady=(0, 12))
        left.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(
            left, text="剪贴板预览", anchor="w", font=ctk.CTkFont(weight="bold")
        ).grid(row=0, column=0, sticky="ew", padx=12, pady=(12, 6))

        self.pending_label = ctk.CTkLabel(
            left,
            text="截图后按 Ctrl+V\n或点下方「从剪贴板粘贴」",
            width=self.PREVIEW_MAX[0],
            height=self.PREVIEW_MAX[1],
            fg_color=("gray85", "gray22"),
            corner_radius=8,
            justify="center",
        )
        self.pending_label.grid(row=1, column=0, sticky="ew", padx=12, pady=4)

        self.pending_info = ctk.CTkLabel(
            left, text="未粘贴", text_color="gray", anchor="w"
        )
        self.pending_info.grid(row=2, column=0, sticky="ew", padx=12, pady=(2, 8))

        ctk.CTkLabel(left, text="保存为", anchor="w").grid(
            row=3, column=0, sticky="ew", padx=12, pady=(4, 2)
        )
        labels = [f"{title}  ({k}.png)" for k, title, _req in TEMPLATE_SLOT_DEFS]
        self._label_to_key = {
            f"{title}  ({k}.png)": k for k, title, _req in TEMPLATE_SLOT_DEFS
        }
        self.target_menu = ctk.CTkOptionMenu(
            left, values=labels, command=self._on_target_change, dynamic_resizing=False
        )
        self.target_menu.grid(row=4, column=0, sticky="ew", padx=12, pady=2)
        self.target_menu.set(labels[0])

        btn_row = ctk.CTkFrame(left, fg_color="transparent")
        btn_row.grid(row=5, column=0, sticky="ew", padx=12, pady=12)
        btn_row.grid_columnconfigure(0, weight=1)
        btn_row.grid_columnconfigure(1, weight=1)
        ctk.CTkButton(
            btn_row, text="从剪贴板粘贴", command=self.paste_from_clipboard
        ).grid(row=0, column=0, sticky="ew", padx=(0, 6))
        ctk.CTkButton(
            btn_row,
            text="保存到模板",
            fg_color="#2d6a4f",
            hover_color="#1b4332",
            command=self.save_pending,
        ).grid(row=0, column=1, sticky="ew", padx=(6, 0))

        tip = ctk.CTkLabel(
            left,
            text="输入框内 Ctrl+V 仍粘贴文字。\n保存会覆盖同名 png。\n单击右侧卡片可选中保存目标。",
            text_color="gray",
            font=ctk.CTkFont(size=11),
            anchor="w",
            justify="left",
        )
        tip.grid(row=6, column=0, sticky="ew", padx=12, pady=(0, 12))

        # 右：已保存列表
        right = ctk.CTkFrame(self)
        right.grid(row=1, column=1, sticky="nsew", padx=(6, 12), pady=(0, 12))
        right.grid_rowconfigure(1, weight=1)
        right.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(
            right, text="已保存模板", anchor="w", font=ctk.CTkFont(weight="bold")
        ).grid(row=0, column=0, sticky="ew", padx=12, pady=(12, 6))
        self.slots_host = ctk.CTkScrollableFrame(right)
        self.slots_host.grid(row=1, column=0, sticky="nsew", padx=8, pady=(0, 12))
        self.slots_host.grid_columnconfigure(0, weight=1)

        for w in (self, left, right, self.pending_label, self.slots_host):
            w.bind("<Button-1>", lambda _e: self.focus_set())
            w.bind("<Control-v>", self._on_local_paste)
            w.bind("<Control-V>", self._on_local_paste)

    def _slot_path(self, key: str) -> Path:
        return self.templates_dir / f"{key}.png"

    def _on_target_change(self, value: str) -> None:
        self._selected_key = self._label_to_key.get(value, self._current_target_key())
        self._highlight_selected()

    def _current_target_key(self) -> str:
        value = self.target_menu.get()
        if value in self._label_to_key:
            return self._label_to_key[value]
        # 兼容
        if ".png)" in value:
            inner = value.rsplit("(", 1)[-1].rstrip(")")
            return inner.replace(".png", "").strip()
        return value.split("—")[0].split(" ")[0].strip() or "craft_button"

    def _menu_label_for_key(self, key: str) -> str:
        for k, title, _req in TEMPLATE_SLOT_DEFS:
            if k == key:
                return f"{title}  ({k}.png)"
        return key

    def _is_text_focus(self) -> bool:
        w = self.focus_get()
        if w is None:
            return False
        cur = w
        for _ in range(6):
            if cur is None:
                break
            cls = ""
            name = type(cur).__name__
            try:
                cls = cur.winfo_class()
            except Exception:
                pass
            if cls in {"Entry", "Text", "TEntry", "TCombobox"}:
                return True
            if name in {"Entry", "Text", "CTkEntry", "CTkTextbox", "CTkComboBox"}:
                return True
            if "Entry" in name or "Textbox" in name or name == "Text":
                return True
            try:
                cur = cur.master
            except Exception:
                break
        return False

    def _on_global_paste(self, event) -> Optional[str]:
        if self._is_text_focus():
            return None
        self.paste_from_clipboard()
        return "break"

    def _on_local_paste(self, _event=None) -> str:
        self.paste_from_clipboard()
        return "break"

    def paste_from_clipboard(self) -> None:
        try:
            img = get_clipboard_image()
        except ClipboardImageError as e:
            messagebox.showwarning("粘贴模板", str(e))
            self.on_log(str(e))
            return
        except Exception as e:
            messagebox.showerror("粘贴模板", f"读取剪贴板失败: {e}")
            self.on_log(f"粘贴失败: {e}")
            return

        self._pending = img
        thumb = thumbnail_fit(img, *self.PREVIEW_MAX)
        self._pending_ctk = ctk.CTkImage(
            light_image=thumb, dark_image=thumb, size=thumb.size
        )
        self.pending_label.configure(image=self._pending_ctk, text="")
        self.pending_info.configure(
            text=f"已粘贴 {img.size[0]}×{img.size[1]}，选择目标后点「保存到模板」"
        )
        self.on_log(f"已从剪贴板粘贴图片 {img.size[0]}×{img.size[1]}")

    def save_pending(self) -> None:
        if self._pending is None:
            try:
                self._pending = get_clipboard_image()
            except Exception:
                messagebox.showwarning("保存模板", "请先 Ctrl+V 或点「从剪贴板粘贴」")
                return

        key = self._current_target_key()
        path = self._slot_path(key)
        if path.exists():
            if not messagebox.askyesno("覆盖确认", f"已存在 {path.name}，是否覆盖？"):
                return
        try:
            save_template_image(self._pending, path)
        except Exception as e:
            messagebox.showerror("保存失败", str(e))
            self.on_log(f"保存模板失败: {e}")
            return

        self.on_log(f"已保存模板: {path}")
        self.refresh_slots()
        if self.on_saved:
            self.on_saved(key, path)
        messagebox.showinfo("保存成功", f"已写入\n{path}")

    def refresh_slots(self) -> None:
        for child in self.slots_host.winfo_children():
            child.destroy()
        self._slot_images.clear()
        self._slot_cards.clear()

        for key, title, required in TEMPLATE_SLOT_DEFS:
            path = self._slot_path(key)
            img = load_template_image(path)
            req_tag = "必需" if required else "可选"
            exists = img is not None

            card = ctk.CTkFrame(self.slots_host, corner_radius=8)
            card.pack(fill="x", pady=4, padx=2)
            card.grid_columnconfigure(1, weight=1)
            self._slot_cards[key] = card

            if exists:
                thumb = thumbnail_fit(img, *self.SLOT_THUMB)
                cimg = ctk.CTkImage(
                    light_image=thumb, dark_image=thumb, size=thumb.size
                )
                self._slot_images[key] = cimg
                preview = ctk.CTkLabel(card, image=cimg, text="", width=80, height=52)
                status_text = f"{key}.png · {img.size[0]}×{img.size[1]} · {req_tag}"
                status_color = "#6a994e"
            else:
                preview = ctk.CTkLabel(
                    card,
                    text="缺失",
                    width=80,
                    height=52,
                    fg_color=("gray80", "gray28"),
                    corner_radius=6,
                    text_color=("#9b2226" if required else "gray"),
                )
                status_text = f"{key}.png · 未配置 · {req_tag}"
                status_color = "#e5383b" if required else "gray"

            preview.grid(row=0, column=0, rowspan=2, padx=10, pady=10, sticky="nw")

            title_lbl = ctk.CTkLabel(
                card,
                text=title,
                anchor="w",
                font=ctk.CTkFont(size=13, weight="bold"),
            )
            title_lbl.grid(row=0, column=1, sticky="ew", padx=(0, 10), pady=(10, 0))

            st = ctk.CTkLabel(
                card,
                text=status_text,
                anchor="w",
                text_color=status_color,
                font=ctk.CTkFont(size=12),
            )
            st.grid(row=1, column=1, sticky="ew", padx=(0, 10), pady=(2, 10))

            def _bind_select(widget, k=key, t=title):
                widget.bind(
                    "<Button-1>", lambda _e, kk=k, tt=t: self._select_target(kk, tt)
                )

            for w in (card, preview, title_lbl, st):
                _bind_select(w)

        self._highlight_selected()

    def _highlight_selected(self) -> None:
        for key, card in self._slot_cards.items():
            if key == self._selected_key:
                card.configure(border_width=2, border_color="#3a86ff")
            else:
                card.configure(border_width=0)

    def _select_target(self, key: str, title: str) -> None:
        self._selected_key = key
        self.target_menu.set(self._menu_label_for_key(key))
        self._highlight_selected()
        self.on_log(f"保存目标已设为 {key}.png")
