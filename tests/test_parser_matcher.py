from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.item_parser import extract_numbers, parse_item_text
from src.matcher import (
    match_item,
    match_ruleset,
    parse_threshold_text,
    split_pattern_keywords,
)
from src.models import Affix, Item, MatchMode, MatchRule, RuleGroup, RuleSet


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
        self.assertEqual(
            extract_numbers("攻击附加 6 - 12 基础冰霜伤害"),
            [6.0, 12.0],
        )
        self.assertEqual(
            extract_numbers("法杖攻击附加 2 到 48 点闪电伤害"),
            [2.0, 48.0],
        )

    def test_missing_rarity_with_item_level_is_normal_item(self) -> None:
        item = parse_item_text(
            "威武皮盔\n--------\n闪避值: 669\n--------\n物品等级: 100\n--------\n已鉴定"
        )
        self.assertEqual(item.rarity, "普通")

    def test_influence_and_sale_metadata_are_not_counted_as_affixes(self) -> None:
        item = parse_item_text(
            "物品类别: 头部\n"
            "稀有度: 魔法\n"
            "丰饶的威武皮盔\n"
            "威武皮盔\n"
            "--------\n"
            "物品等级: 100\n"
            "--------\n"
            "+130 最大生命\n"
            "--------\n"
            "圣战者物品\n"
            "督军物品\n"
            "出售获得通货:非绑定\n"
            "--------\n"
            "已鉴定"
        )
        self.assertEqual(item.name, "丰饶的威武皮盔")
        self.assertEqual(item.base_type, "威武皮盔")
        self.assertEqual(item.affix_texts(), ["+130 最大生命"])
        self.assertEqual(item.craft_affix_count, 1)

    def test_parse_real_cn_magic_text_with_spaced_rarity_and_mod_details(self) -> None:
        item = parse_item_text(
            "物品类别: 头部\n"
            "稀 有 度: 魔法\n"
            "督军的雪人之威武皮盔\n"
            "--------\n"
            "品质: +27% (augmented)\n"
            "闪避值: 747 (augmented)\n"
            "--------\n"
            "需求:\n"
            "等级: 84\n"
            "敏捷: 224 (unmet)\n"
            "--------\n"
            "插槽: G\n"
            "--------\n"
            "物品等级: 84\n"
            "--------\n"
            '{ ▲ 前缀词缀 "督军的" (等阶：1)— 伤害, 元素 }\n'
            "元素伤害提高 19(19-22)%\n"
            '{ ▽ 后缀词缀 "雪人之" (等阶：5)— 元素, 冰霜, 抗性 }\n'
            "+25(24-29)% 冰霜抗性\n"
            "--------\n"
            "圣战者物品\n"
            "督军物品\n"
            "--------\n"
            "出售获得通货:非绑定"
        )
        self.assertEqual(item.rarity, "魔法")
        self.assertEqual(item.item_level, 84)
        self.assertEqual(
            item.affix_texts(),
            ["元素伤害提高 19(19-22)%", "+25(24-29)% 冰霜抗性"],
        )
        self.assertEqual(item.affixes[0].values, [19.0])
        self.assertEqual(item.affixes[1].values, [25.0])
        self.assertEqual(item.craft_affix_count, 2)


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

    def test_group_min_matches_at_least_two(self) -> None:
        rs = RuleSet(
            group_combine=MatchMode.ALL.value,
            groups=[
                RuleGroup(
                    name="抗性",
                    combine=MatchMode.ALL.value,
                    min_matches=2,
                    rules=[
                        MatchRule(pattern="最大生命", operator=">=", threshold=80),
                        MatchRule(pattern="闪电抗性", operator=">=", threshold=20),
                        MatchRule(pattern="混沌抗性"),
                    ],
                )
            ],
        )
        self.assertTrue(match_ruleset(self.item, rs).success)
        rs.groups[0].min_matches = 3
        self.assertFalse(match_ruleset(self.item, rs).success)

    def test_parse_threshold_text_supports_range(self) -> None:
        self.assertEqual(parse_threshold_text("80"), (80.0, None))
        self.assertEqual(parse_threshold_text("6-12"), (6.0, 12.0))
        self.assertEqual(parse_threshold_text("6 - 12"), (6.0, 12.0))
        self.assertEqual(parse_threshold_text("6到12"), (6.0, 12.0))

    def test_added_damage_range_compares_both_values(self) -> None:
        item = Item(
            affixes=[
                Affix(text="攻击附加 6 - 12 基础冰霜伤害", values=[6.0, 12.0]),
            ]
        )
        ok = match_item(
            item,
            [
                MatchRule(
                    pattern="基础冰霜伤害",
                    operator=">=",
                    threshold=6,
                    threshold2=12,
                )
            ],
        )
        self.assertTrue(ok.success)
        self.assertEqual(ok.hits[0].actual_values, [6.0, 12.0])

        fail_high = match_item(
            item,
            [
                MatchRule(
                    pattern="基础冰霜伤害",
                    operator=">=",
                    threshold=6,
                    threshold2=13,
                )
            ],
        )
        self.assertFalse(fail_high.success)

        fail_low = match_item(
            item,
            [
                MatchRule(
                    pattern="基础冰霜伤害",
                    operator=">=",
                    threshold=7,
                    threshold2=12,
                )
            ],
        )
        self.assertFalse(fail_low.success)

    def test_legacy_single_threshold_still_uses_first_value(self) -> None:
        item = Item(
            affixes=[
                Affix(text="攻击附加 6 - 12 基础冰霜伤害", values=[6.0, 12.0]),
            ]
        )
        r = match_item(
            item,
            [MatchRule(pattern="基础冰霜伤害", operator=">=", threshold=6)],
        )
        self.assertTrue(r.success)

    def test_split_pattern_keywords(self) -> None:
        self.assertEqual(split_pattern_keywords("最大生命"), ["最大生命"])
        self.assertEqual(
            split_pattern_keywords("攻击附加 冰霜伤害"),
            ["攻击附加", "冰霜伤害"],
        )
        self.assertEqual(
            split_pattern_keywords("攻击附加,冰霜伤害"),
            ["攻击附加", "冰霜伤害"],
        )

    def test_multi_keyword_must_all_appear_in_same_affix(self) -> None:
        item = Item(
            affixes=[
                Affix(text="攻击附加 6 - 12 基础冰霜伤害", values=[6.0, 12.0]),
                Affix(text="攻击附加 4 - 8 基础火焰伤害", values=[4.0, 8.0]),
            ]
        )
        hit = match_item(
            item,
            [
                MatchRule(
                    pattern="攻击附加 冰霜伤害",
                    operator=">=",
                    threshold=6,
                    threshold2=12,
                )
            ],
        )
        self.assertTrue(hit.success)
        self.assertEqual(hit.hits[0].matched_affix, "攻击附加 6 - 12 基础冰霜伤害")

        miss = match_item(
            item,
            [MatchRule(pattern="攻击附加 闪电伤害")],
        )
        self.assertFalse(miss.success)

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
