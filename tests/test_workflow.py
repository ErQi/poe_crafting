from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import call, patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.automation import (  # noqa: E402
    AutomationConfig,
    CraftAutomation,
    _should_skip_augmentation,
    _workflow_currency_panel_exclusions,
    _workflow_currency_scales,
)
from src.item_parser import ItemParseError, parse_item_text  # noqa: E402
from src.models import (  # noqa: E402
    AppSettings,
    CraftMode,
    CraftWorkflow,
    RuleSet,
    StopReason,
)
from src.vision import MatchHit  # noqa: E402
from src.workflow import (  # noqa: E402
    ROUTE_FINISH,
    ROUTE_STEP,
    default_workflow,
    evaluate_step,
    resolve_transition,
    validate_workflow,
)


def _item_text(rarity: str, *affixes: str) -> str:
    affix_block = "\n".join(affixes)
    return (
        f"稀有度: {rarity}\n"
        "测试之冠\n"
        "威武皮盔\n"
        "--------\n"
        "物品等级: 100\n"
        "--------\n"
        f"{affix_block}\n"
        "--------\n"
        "已鉴定"
    )


class TestWorkflow(unittest.TestCase):
    def setUp(self) -> None:
        self.workflow = default_workflow()

    def test_default_workflow_is_valid_and_round_trips(self) -> None:
        self.assertEqual(validate_workflow(self.workflow), [])
        restored = CraftWorkflow.from_dict(self.workflow.to_dict())
        self.assertEqual(restored.to_dict(), self.workflow.to_dict())

    def test_alteration_keeps_either_t1_elemental_or_t1_life(self) -> None:
        step = self.workflow.get_step("alteration_t1_elemental")
        self.assertIsNotNone(step)
        assert step is not None

        low_elemental = parse_item_text(_item_text("魔法", "元素伤害提高 18%"))
        t1_elemental = parse_item_text(_item_text("魔法", "元素伤害提高 19%"))
        low_life = parse_item_text(_item_text("魔法", "+129 最大生命"))
        t1_life = parse_item_text(_item_text("魔法", "+130 最大生命"))
        self.assertFalse(evaluate_step(low_elemental, step).success)
        self.assertTrue(evaluate_step(t1_elemental, step).success)
        self.assertFalse(evaluate_step(low_life, step).success)
        self.assertTrue(evaluate_step(t1_life, step).success)

    def test_transmutation_checks_roll_before_deciding_next_step(self) -> None:
        step = self.workflow.get_step("transmute")
        self.assertIsNotNone(step)
        assert step is not None

        low = parse_item_text(_item_text("魔法", "元素伤害提高 18%"))
        hit = parse_item_text(_item_text("魔法", "元素伤害提高 19%"))
        self.assertFalse(evaluate_step(low, step).success)
        self.assertTrue(evaluate_step(hit, step).success)

        miss_route = resolve_transition(
            self.workflow,
            step.id,
            step.on_failure,
        )
        hit_route = resolve_transition(
            self.workflow,
            step.id,
            step.on_success,
        )
        self.assertEqual(miss_route.next_step_id, "alteration_t1_elemental")
        self.assertEqual(hit_route.next_step_id, "augment_missing_target")

    def test_augmentation_checks_both_targets_then_always_goes_to_regal(self) -> None:
        step = self.workflow.get_step("augment_missing_target")
        assert step is not None

        one_target = parse_item_text(_item_text("魔法", "+130 最大生命"))
        both_targets = parse_item_text(
            _item_text("魔法", "+130 最大生命", "元素伤害提高 19%")
        )
        self.assertFalse(evaluate_step(one_target, step).success)
        self.assertTrue(evaluate_step(both_targets, step).success)

        miss_route = resolve_transition(self.workflow, step.id, step.on_failure)
        hit_route = resolve_transition(self.workflow, step.id, step.on_success)
        self.assertEqual(miss_route.next_step_id, "regal_t1_life")
        self.assertEqual(hit_route.next_step_id, "regal_t1_life")

    def test_augmentation_is_used_only_for_exactly_one_explicit_mod(self) -> None:
        step = self.workflow.get_step("augment_missing_target")
        assert step is not None
        one_mod = parse_item_text(_item_text("魔法", "元素伤害提高 19%"))
        two_mods = parse_item_text(
            _item_text("魔法", "元素伤害提高 19%", "+25% 冰霜抗性")
        )
        self.assertFalse(_should_skip_augmentation(step, one_mod))
        self.assertTrue(_should_skip_augmentation(step, two_mods))

    def test_regal_requires_elemental_and_t1_life(self) -> None:
        step = self.workflow.get_step("regal_t1_life")
        self.assertIsNotNone(step)
        assert step is not None

        missing_life = parse_item_text(
            _item_text("稀有", "元素伤害提高 22%", "+48% 火焰抗性")
        )
        complete = parse_item_text(
            _item_text("稀有", "元素伤害提高 19%", "+130 最大生命")
        )
        self.assertFalse(evaluate_step(missing_life, step).success)
        self.assertTrue(evaluate_step(complete, step).success)

    def test_expected_rarity_is_also_required(self) -> None:
        step = self.workflow.get_step("regal_t1_life")
        assert step is not None
        magic = parse_item_text(_item_text("魔法", "元素伤害提高 19%", "+130 最大生命"))
        result = evaluate_step(magic, step)
        self.assertFalse(result.success)
        self.assertFalse(result.rarity_matched)
        self.assertTrue(result.rules_matched)

    def test_regal_failure_goes_to_scour_and_scour_loops_to_start(self) -> None:
        regal = self.workflow.get_step("regal_t1_life")
        scour = self.workflow.get_step("scour_restart")
        assert regal is not None and scour is not None

        failure_route = resolve_transition(
            self.workflow,
            regal.id,
            regal.on_failure,
        )
        self.assertEqual(failure_route.kind, ROUTE_STEP)
        self.assertEqual(failure_route.next_step_id, scour.id)

        restart_route = resolve_transition(
            self.workflow,
            scour.id,
            scour.on_success,
        )
        self.assertEqual(restart_route.kind, ROUTE_STEP)
        self.assertEqual(restart_route.next_step_id, "transmute")

    def test_regal_success_finishes(self) -> None:
        regal = self.workflow.get_step("regal_t1_life")
        assert regal is not None
        route = resolve_transition(self.workflow, regal.id, regal.on_success)
        self.assertEqual(route.kind, ROUTE_FINISH)

    def test_next_skips_disabled_steps(self) -> None:
        alteration = self.workflow.get_step("alteration_t1_elemental")
        augmentation = self.workflow.get_step("augment_missing_target")
        regal = self.workflow.get_step("regal_t1_life")
        assert alteration is not None and augmentation is not None and regal is not None
        augmentation.enabled = False
        route = resolve_transition(
            self.workflow,
            alteration.id,
            alteration.on_success,
        )
        self.assertEqual(route.next_step_id, "regal_t1_life")

    def test_currency_action_right_clicks_currency_then_left_clicks_item(self) -> None:
        step = self.workflow.get_step("alteration_t1_elemental")
        assert step is not None
        currency_hit = MatchHit("currency", 1.0, 100, 200, 100, 200, 20, 20)
        item_hit = MatchHit("item", 1.0, 400, 500, 400, 500, 40, 40)

        class _Vision:
            def get_cached_position(self, name: str):
                return currency_hit if name == step.currency_template else item_hit

            def clear_position_cache(self, _name: str) -> None:
                return

        automation = CraftAutomation()
        automation._verified_currency_templates.add(  # noqa: SLF001
            step.currency_template
        )
        with (
            patch("src.automation.click_screen") as click,
            patch("src.automation.sleep_ms", return_value=False),
        ):
            ok = automation._apply_currency_step(  # noqa: SLF001
                _Vision(),  # type: ignore[arg-type]
                object(),
                step,
                AppSettings(action_delay_ms=1),
            )

        self.assertTrue(ok)
        self.assertEqual(
            click.call_args_list,
            [
                call(100, 200, settle_ms=15, button="right"),
                call(400, 500, settle_ms=15, button="left"),
            ],
        )

    def test_currency_action_never_clicks_when_match_is_inside_item(self) -> None:
        step = self.workflow.get_step("alteration_t1_elemental")
        assert step is not None
        item_hit = MatchHit("item", 1.0, 400, 500, 400, 500, 120, 120)
        false_currency_hit = MatchHit(
            "currency",
            0.95,
            400,
            500,
            400,
            500,
            48,
            48,
        )

        class _Vision:
            def get_cached_position(self, name: str):
                return item_hit if name == "item_slot" else false_currency_hit

            def clear_position_cache(self, _name: str) -> None:
                return

            def find_in_window(self, *_args, **_kwargs):
                return None

        automation = CraftAutomation()
        automation._verified_currency_templates.add(  # noqa: SLF001
            step.currency_template
        )
        with (
            patch("src.automation.click_screen") as click,
            patch("src.automation.sleep_ms", return_value=False),
        ):
            ok = automation._apply_currency_step(  # noqa: SLF001
                _Vision(),  # type: ignore[arg-type]
                object(),
                step,
                AppSettings(action_delay_ms=1),
            )

        self.assertFalse(ok)
        click.assert_not_called()

    def test_currency_action_never_clicks_an_unverified_candidate(self) -> None:
        step = self.workflow.get_step("alteration_t1_elemental")
        assert step is not None
        item_hit = MatchHit("item", 1.0, 400, 500, 400, 500, 120, 120)

        class _Vision:
            @staticmethod
            def get_cached_position(name: str):
                return item_hit if name == "item_slot" else None

            @staticmethod
            def clear_position_cache(_name: str) -> None:
                return

            @staticmethod
            def grab_window(_win):
                return object()

        automation = CraftAutomation()
        with (
            patch.object(
                automation,
                "_grab_workflow_frame_without_tooltip",
                return_value=object(),
            ),
            patch.object(
                automation,
                "_find_and_verify_currency_in_frame",
                return_value=None,
            ),
            patch("src.automation.click_screen") as click,
        ):
            ok = automation._apply_currency_step(  # noqa: SLF001
                _Vision(),  # type: ignore[arg-type]
                object(),
                step,
                AppSettings(),
            )

        self.assertFalse(ok)
        click.assert_not_called()

    def test_reading_item_only_moves_and_presses_ctrl_c(self) -> None:
        item_hit = MatchHit("item", 1.0, 400, 500, 400, 500, 120, 120)

        class _Vision:
            def get_cached_position(self, _name: str):
                return item_hit

        automation = CraftAutomation()
        with (
            patch("src.automation.move_screen") as move,
            patch("src.automation.click_screen") as click,
            patch("src.automation.sleep_ms", return_value=False),
            patch("src.automation.clear_clipboard"),
            patch("src.automation.hotkey") as hotkey_mock,
            patch(
                "src.automation.wait_clipboard_change",
                return_value=_item_text("普通"),
            ),
        ):
            item = automation._read_item_fast(  # noqa: SLF001
                _Vision(),  # type: ignore[arg-type]
                object(),
                AppSettings(action_delay_ms=1),
            )

        self.assertEqual(item.rarity, "普通")
        click.assert_not_called()
        move.assert_called_once_with(400, 500, settle_ms=20)
        hotkey_mock.assert_called_once_with("ctrl", "c")

    def test_currency_candidate_is_cached_only_after_name_copy_matches(self) -> None:
        step = self.workflow.get_step("alteration_t1_elemental")
        assert step is not None
        hit = MatchHit(
            step.currency_template,
            0.88,
            220,
            330,
            220,
            330,
            84,
            84,
            color_rmse=31.0,
        )

        class _Window:
            height = 2160

        class _Vision:
            cached = None

            @staticmethod
            def match_color_in_frame(*_args, **_kwargs):
                return hit

            def set_cached_position(self, _name: str, value: MatchHit) -> None:
                self.cached = value

        vision = _Vision()
        automation = CraftAutomation()
        with patch.object(
            automation,
            "_copy_hovered_text",
            return_value="物品类别: 可堆叠通货\n稀有度: 通货\n改造石",
        ):
            result = automation._find_and_verify_currency_in_frame(  # noqa: SLF001
                vision,  # type: ignore[arg-type]
                _Window(),
                AppSettings(),
                step.currency_template,
                object(),
                [],
            )

        self.assertIs(result, hit)
        self.assertIs(vision.cached, hit)
        self.assertIn(
            step.currency_template,
            automation._verified_currency_templates,  # noqa: SLF001
        )

    def test_currency_scale_is_recalibrated_from_verified_icon_size(self) -> None:
        class _Window:
            width = 3840
            height = 2160

        calibrated_4k = _workflow_currency_scales(
            _Window(),
            verified_icon_size=83,
            template_size=48,
        )
        calibrated_1080p = _workflow_currency_scales(
            _Window(),
            verified_icon_size=42,
            template_size=48,
        )
        self.assertAlmostEqual(calibrated_4k[1], 83 / 48, places=3)
        self.assertAlmostEqual(calibrated_1080p[1], 42 / 48, places=3)
        self.assertNotEqual(calibrated_4k, calibrated_1080p)
        self.assertGreater(min(calibrated_4k), 1.6)

    def test_currency_panel_is_inferred_relative_to_window(self) -> None:
        class _Window:
            width = 3840
            height = 2160

        left_hit = MatchHit("currency", 1.0, 111, 551, 111, 551, 83, 83)
        exclusions, label = _workflow_currency_panel_exclusions(
            _Window(),
            [left_hit],
        )
        self.assertEqual(label, "左侧面板")
        self.assertEqual(exclusions, [(1469, 0, 3840, 2160)])

        right_hit = MatchHit("currency", 1.0, 3700, 551, 3700, 551, 83, 83)
        exclusions, label = _workflow_currency_panel_exclusions(
            _Window(),
            [right_hit],
        )
        self.assertEqual(label, "右侧面板")
        self.assertEqual(exclusions, [(0, 0, 2371, 2160)])

    def test_verified_currency_calibrates_later_candidate_search(self) -> None:
        target = MatchHit(
            "currency_augmentation",
            0.88,
            344,
            551,
            344,
            551,
            83,
            83,
            color_rmse=32.0,
        )
        anchor = MatchHit(
            "currency_transmutation",
            0.90,
            111,
            551,
            111,
            551,
            83,
            83,
            color_rmse=30.0,
        )

        class _Window:
            width = 3840
            height = 2160

        class _Template:
            shape = (48, 48, 4)

        class _Vision:
            scales = None
            exclusions = None

            @staticmethod
            def get_cached_position(name: str):
                if name == "currency_transmutation":
                    return anchor
                return None

            @staticmethod
            def get_template(_name: str):
                return _Template()

            @classmethod
            def match_color_in_frame(cls, *_args, **kwargs):
                cls.scales = kwargs["scales"]
                cls.exclusions = kwargs["exclude_regions"]
                return target

            @staticmethod
            def set_cached_position(_name: str, _hit: MatchHit) -> None:
                return

        automation = CraftAutomation()
        automation._verified_currency_templates.add(  # noqa: SLF001
            "currency_transmutation"
        )
        with patch.object(
            automation,
            "_copy_hovered_text",
            return_value="物品类别: 可堆叠通货\n增幅石",
        ):
            hit = automation._find_and_verify_currency_in_frame(  # noqa: SLF001
                _Vision(),  # type: ignore[arg-type]
                _Window(),
                AppSettings(),
                "currency_augmentation",
                object(),
                [],
            )

        self.assertIs(hit, target)
        self.assertAlmostEqual(_Vision.scales[1], 83 / 48, places=3)
        self.assertIn((1469, 0, 3840, 2160), _Vision.exclusions)

    def test_sift_candidate_is_tried_before_color_fallback(self) -> None:
        anchor = MatchHit(
            "currency_transmutation",
            0.90,
            111,
            551,
            111,
            551,
            83,
            83,
            feature_matches=20,
        )
        target = MatchHit(
            "currency_augmentation",
            0.85,
            456,
            667,
            456,
            667,
            83,
            83,
            feature_matches=8,
        )

        class _Window:
            width = 3840
            height = 2160

        class _Template:
            shape = (48, 48, 4)

        class _Vision:
            @staticmethod
            def get_cached_position(name: str):
                return anchor if name == "currency_transmutation" else None

            @staticmethod
            def get_template(_name: str):
                return _Template()

            @staticmethod
            def feature_candidates_in_frame(*_args, **_kwargs):
                return [target]

            @staticmethod
            def match_color_in_frame(*_args, **_kwargs):
                raise AssertionError("SIFT 命中后不应进入颜色回退")

            @staticmethod
            def set_cached_position(_name: str, _hit: MatchHit) -> None:
                return

        automation = CraftAutomation()
        automation._verified_currency_templates.add(  # noqa: SLF001
            "currency_transmutation"
        )
        with patch.object(
            automation,
            "_copy_hovered_text",
            return_value="物品类别: 可堆叠通货\n增幅石",
        ):
            hit = automation._find_and_verify_currency_in_frame(  # noqa: SLF001
                _Vision(),  # type: ignore[arg-type]
                _Window(),
                AppSettings(),
                "currency_augmentation",
                object(),
                [],
            )

        self.assertIs(hit, target)

    def test_currency_frame_moves_off_item_tooltip_before_capture(self) -> None:
        frame = object()

        class _Window:
            center = (1920, 1080)

        class _Vision:
            @staticmethod
            def grab_window(_win):
                return frame

        automation = CraftAutomation()
        with (
            patch("src.automation.move_screen") as move,
            patch("src.automation.sleep_ms", return_value=False) as sleep,
        ):
            result = automation._grab_workflow_frame_without_tooltip(  # noqa: SLF001
                _Vision(),  # type: ignore[arg-type]
                _Window(),
                AppSettings(action_delay_ms=1),
            )

        self.assertIs(result, frame)
        move.assert_called_once_with(1920, 1080, settle_ms=20)
        sleep.assert_called_once()

    def test_workflow_does_not_apply_currency_before_initial_read_succeeds(
        self,
    ) -> None:
        class _Window:
            title = "Path of Exile"
            width = 1920
            height = 1080

        class _Vision:
            @staticmethod
            def template_path(name: str) -> Path:
                return ROOT / "assets" / "templates" / f"{name}.png"

            @staticmethod
            def clear_position_cache(_name: str) -> None:
                return

        automation = CraftAutomation()
        config = AutomationConfig(
            settings=AppSettings(max_parse_failures=1, action_delay_ms=1),
            ruleset=RuleSet(),
            craft_mode=CraftMode.WORKFLOW.value,
            craft_preset="",
            workflow=self.workflow,
        )
        with (
            patch(
                "src.automation.focus_game_window",
                return_value=(_Window(), True),
            ),
            patch.object(
                automation,
                "_locate_workflow_required",
                return_value=True,
            ),
            patch.object(
                automation,
                "_read_item_fast",
                side_effect=ItemParseError("读取失败"),
            ),
            patch.object(automation, "_apply_currency_step") as apply_currency,
            patch("src.automation.sleep_ms", return_value=False),
        ):
            automation._run_workflow_with_vision(  # noqa: SLF001
                config,
                _Vision(),  # type: ignore[arg-type]
            )

        apply_currency.assert_not_called()
        self.assertEqual(automation.status.stop_reason, StopReason.PARSE_FAILURES)

    def test_workflow_reads_normal_item_before_starting_transmutation(self) -> None:
        class _Window:
            hwnd = 1
            title = "Path of Exile"
            left = 0
            top = 0
            right = 1920
            bottom = 1080
            width = 1920
            height = 1080

        class _Vision:
            @staticmethod
            def template_path(name: str) -> Path:
                return ROOT / "assets" / "templates" / f"{name}.png"

        events: list[str] = []
        normal_item = parse_item_text(_item_text("普通"))
        automation = CraftAutomation()
        config = AutomationConfig(
            settings=AppSettings(max_parse_failures=1, action_delay_ms=1),
            ruleset=RuleSet(),
            craft_mode=CraftMode.WORKFLOW.value,
            craft_preset="",
            workflow=self.workflow,
        )

        def _read(*_args):
            events.append("read")
            return normal_item

        def _apply(_vision, _window, step, _settings):
            events.append(f"apply:{step.id}")
            return False

        with (
            patch(
                "src.automation.focus_game_window",
                return_value=(_Window(), True),
            ),
            patch("src.automation.find_game_window", return_value=_Window()),
            patch("src.automation.focus_window", return_value=True),
            patch.object(
                automation,
                "_locate_workflow_required",
                return_value=True,
            ),
            patch.object(
                automation,
                "_locate_and_verify_workflow_currencies",
                return_value=True,
            ),
            patch.object(automation, "_read_item_fast", side_effect=_read),
            patch.object(automation, "_apply_currency_step", side_effect=_apply),
        ):
            automation._run_workflow_with_vision(  # noqa: SLF001
                config,
                _Vision(),  # type: ignore[arg-type]
            )

        self.assertEqual(events, ["read", "apply:transmute"])


if __name__ == "__main__":
    unittest.main()
