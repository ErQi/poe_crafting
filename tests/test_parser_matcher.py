from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.item_parser import extract_numbers, parse_item_text
from src.matcher import match_item, match_ruleset
from src.models import MatchMode, MatchRule, RuleGroup, RuleSet


SAMPLES = Path(__file__).resolve().parent / "samples"


class TestItemParser(unittest.TestCase):
    def test_parse_rare(self) -> None:
        text = (SAMPLES / "item_rare_cn.txt").read_text(encoding="utf-8")
        item = parse_item_text(text)
        self.assertEqual(item.rarity, "稀有")
        self.assertEqual(item.name, "苦闷轻语")
        self.assertEqual(item.base_type, "编织法衣")
        self.assertEqual(item.item_level, 78)
        texts = item.affix_texts()
        self.assertTrue(any("最大生命" in t for t in texts))
        self.assertFalse(any(t.startswith("能量护盾") for t in texts))
        life = next(a for a in item.affixes if "最大生命" in a.text)
        self.assertEqual(life.first_value, 96.0)

    def test_extract_numbers(self) -> None:
        self.assertEqual(extract_numbers("+96 最大生命"), [96.0])
        self.assertEqual(extract_numbers("攻击速度加快 12%"), [12.0])
        self.assertEqual(extract_numbers("增加 10-20% 物理伤害"), [10.0, 20.0])
        # 括号范围应被忽略
        vals = extract_numbers("附加 5-10 (5-10) 物理伤害")
        self.assertEqual(vals, [5.0, 10.0])


class TestMatcher(unittest.TestCase):
    def setUp(self) -> None:
        text = (SAMPLES / "item_rare_cn.txt").read_text(encoding="utf-8")
        self.item = parse_item_text(text)
        text2 = (SAMPLES / "item_magic_cn.txt").read_text(encoding="utf-8")
        self.item_low = parse_item_text(text2)

    def test_life_ge_80_pass(self) -> None:
        rules = [MatchRule(pattern="最大生命", operator=">=", threshold=80)]
        r = match_item(self.item, rules, MatchMode.ALL.value)
        self.assertTrue(r.success)

    def test_life_ge_80_fail(self) -> None:
        rules = [MatchRule(pattern="最大生命", operator=">=", threshold=80)]
        r = match_item(self.item_low, rules, MatchMode.ALL.value)
        self.assertFalse(r.success)

    def test_any_mode(self) -> None:
        rules = [
            MatchRule(pattern="最大生命", operator=">=", threshold=200),
            MatchRule(pattern="闪电抗性", operator=">=", threshold=20),
        ]
        r = match_item(self.item, rules, MatchMode.ANY.value)
        self.assertTrue(r.success)

    def test_all_mode_fail(self) -> None:
        rules = [
            MatchRule(pattern="最大生命", operator=">=", threshold=80),
            MatchRule(pattern="混沌抗性"),
        ]
        r = match_item(self.item, rules, MatchMode.ALL.value)
        self.assertFalse(r.success)

    def test_text_only(self) -> None:
        rules = [MatchRule(pattern="全属性")]
        r = match_item(self.item, rules, MatchMode.ALL.value)
        self.assertTrue(r.success)

    def test_group_or_between_groups(self) -> None:
        # 组A 要混沌抗(失败) OR 组B 要最大生命>=80(成功) → 总成功
        rs = RuleSet(
            group_combine=MatchMode.ANY.value,
            groups=[
                RuleGroup(
                    name="A",
                    combine=MatchMode.ALL.value,
                    rules=[MatchRule(pattern="混沌抗性")],
                ),
                RuleGroup(
                    name="B",
                    combine=MatchMode.ALL.value,
                    rules=[MatchRule(pattern="最大生命", operator=">=", threshold=80)],
                ),
            ],
        )
        r = match_ruleset(self.item, rs)
        self.assertTrue(r.success)

    def test_group_and_between_groups_fail(self) -> None:
        rs = RuleSet(
            group_combine=MatchMode.ALL.value,
            groups=[
                RuleGroup(
                    name="A",
                    combine=MatchMode.ALL.value,
                    rules=[MatchRule(pattern="最大生命", operator=">=", threshold=80)],
                ),
                RuleGroup(
                    name="B",
                    combine=MatchMode.ALL.value,
                    rules=[MatchRule(pattern="混沌抗性")],
                ),
            ],
        )
        r = match_ruleset(self.item, rs)
        self.assertFalse(r.success)

    def test_inner_or_group(self) -> None:
        # 组内 OR：混沌 或 闪电抗 → 成功
        rs = RuleSet(
            group_combine=MatchMode.ALL.value,
            groups=[
                RuleGroup(
                    name="抗性",
                    combine=MatchMode.ANY.value,
                    rules=[
                        MatchRule(pattern="混沌抗性"),
                        MatchRule(pattern="闪电抗性", operator=">=", threshold=20),
                    ],
                )
            ],
        )
        r = match_ruleset(self.item, rs)
        self.assertTrue(r.success)

    def test_legacy_rules_json_load(self) -> None:
        from src.models import RuleSet as RS

        data = {
            "match_mode": "any",
            "rules": [{"pattern": "最大生命", "operator": ">=", "threshold": 80}],
        }
        rs = RS.from_dict(data)
        self.assertEqual(len(rs.groups), 1)
        self.assertEqual(rs.groups[0].combine, MatchMode.ANY.value)
        r = match_ruleset(self.item, rs)
        self.assertTrue(r.success)


if __name__ == "__main__":
    unittest.main()
