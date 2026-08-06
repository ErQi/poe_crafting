from __future__ import annotations

import sys
import unittest
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.vision import (  # noqa: E402
    VisionService,
    match_template,
    match_template_color_rmse,
    match_template_feature_candidates,
)


class TestTransparentTemplateMatching(unittest.TestCase):
    def test_alpha_mask_ignores_transparent_template_border(self) -> None:
        needle = np.zeros((12, 12), dtype=np.uint8)
        mask = np.zeros((12, 12), dtype=np.uint8)
        needle[2:10, 2:10] = np.array(
            [
                [10, 20, 30, 40, 50, 60, 70, 80],
                [80, 70, 60, 50, 40, 30, 20, 10],
                [15, 35, 55, 75, 95, 115, 135, 155],
                [155, 135, 115, 95, 75, 55, 35, 15],
                [25, 50, 75, 100, 125, 150, 175, 200],
                [200, 175, 150, 125, 100, 75, 50, 25],
                [35, 65, 95, 125, 155, 185, 215, 245],
                [245, 215, 185, 155, 125, 95, 65, 35],
            ],
            dtype=np.uint8,
        )
        mask[2:10, 2:10] = 255

        haystack = np.full((60, 80), 120, dtype=np.uint8)
        target_x, target_y = 31, 19
        target = haystack[target_y : target_y + 12, target_x : target_x + 12]
        target[mask > 0] = needle[mask > 0]

        hit = match_template(
            None,  # type: ignore[arg-type]
            None,  # type: ignore[arg-type]
            threshold=0.99,
            scales=(1.0,),
            haystack_gray=haystack,
            needle_gray=needle,
            needle_mask=mask,
            search_scale=1.0,
        )

        self.assertIsNotNone(hit)
        assert hit is not None
        self.assertEqual(hit[1:3], (target_x, target_y))

    def test_bundled_currency_icons_keep_alpha_masks(self) -> None:
        vision = VisionService("assets/templates")
        try:
            mask = vision.get_template_mask("currency_alteration")
            self.assertIsNotNone(mask)
            assert mask is not None
            self.assertEqual(mask.shape, (48, 48))
            self.assertGreater(np.count_nonzero(mask), 0)
            self.assertLess(np.count_nonzero(mask), mask.size)
        finally:
            vision.close()

    def test_excluded_region_skips_a_better_match_inside_target_item(self) -> None:
        needle = np.array(
            [
                [11, 72, 19, 203, 44, 155],
                [91, 8, 177, 35, 222, 63],
                [17, 141, 58, 199, 4, 118],
                [231, 49, 106, 13, 166, 81],
                [32, 188, 70, 215, 25, 129],
                [146, 2, 238, 54, 97, 184],
            ],
            dtype=np.uint8,
        )
        haystack = np.zeros((60, 90), dtype=np.uint8)
        haystack[8:14, 9:15] = needle
        haystack[37:43, 62:68] = needle

        hit = match_template(
            None,  # type: ignore[arg-type]
            None,  # type: ignore[arg-type]
            threshold=0.99,
            scales=(1.0,),
            haystack_gray=haystack,
            needle_gray=needle,
            search_scale=1.0,
            exclude_regions=[(0, 0, 30, 30)],
        )

        self.assertIsNotNone(hit)
        assert hit is not None
        self.assertEqual(hit[1:3], (62, 37))

    def test_color_rmse_finds_the_scaled_exact_icon(self) -> None:
        needle = np.array(
            [
                [[12, 80, 210], [190, 20, 40], [35, 220, 90], [240, 170, 15]],
                [[90, 15, 180], [25, 140, 230], [210, 60, 10], [45, 200, 160]],
                [[170, 230, 30], [15, 55, 200], [225, 100, 70], [80, 190, 20]],
                [[30, 180, 240], [200, 35, 120], [65, 210, 175], [245, 75, 25]],
            ],
            dtype=np.uint8,
        )
        mask = np.full(needle.shape[:2], 255, dtype=np.uint8)
        scale = 1.75
        scaled = cv2.resize(
            needle,
            (int(needle.shape[1] * scale), int(needle.shape[0] * scale)),
            interpolation=cv2.INTER_LINEAR,
        )
        haystack = np.full((70, 120, 3), 25, dtype=np.uint8)
        target_x, target_y = 81, 39
        haystack[
            target_y : target_y + scaled.shape[0],
            target_x : target_x + scaled.shape[1],
        ] = scaled

        hit = match_template_color_rmse(
            haystack,
            needle,
            mask,
            max_rmse=1.0,
            scales=(scale,),
            search_scale=1.0,
        )

        self.assertIsNotNone(hit)
        assert hit is not None
        self.assertEqual(hit[1:3], (target_x, target_y))
        self.assertAlmostEqual(hit[5], 0.0, places=5)

    def test_sift_features_find_scaled_icon_despite_brightness_change(self) -> None:
        raw = cv2.imread(
            str(ROOT / "assets" / "templates" / "currency_augmentation.png"),
            cv2.IMREAD_UNCHANGED,
        )
        self.assertIsNotNone(raw)
        icon_bgr = raw[:, :, :3]
        icon_alpha = raw[:, :, 3]
        target_size = 83
        scaled_icon = cv2.resize(
            icon_bgr,
            (target_size, target_size),
            interpolation=cv2.INTER_CUBIC,
        )
        scaled_alpha = (
            cv2.resize(
                icon_alpha,
                (target_size, target_size),
                interpolation=cv2.INTER_LINEAR,
            ).astype(np.float32)
            / 255.0
        )
        # 模拟游戏内整体变暗和有纹理的仓库背景。
        scaled_icon = np.clip(
            scaled_icon.astype(np.float32) * 0.68 + 22,
            0,
            255,
        ).astype(np.uint8)
        rng = np.random.default_rng(4)
        haystack = rng.integers(10, 70, (260, 360, 3), dtype=np.uint8)
        target_x, target_y = 173, 91
        patch = haystack[
            target_y : target_y + target_size,
            target_x : target_x + target_size,
        ]
        patch[:] = (
            scaled_icon * scaled_alpha[:, :, None]
            + patch * (1.0 - scaled_alpha[:, :, None])
        ).astype(np.uint8)

        candidates = match_template_feature_candidates(
            haystack,
            icon_bgr,
            icon_alpha,
            target_width=target_size,
            max_candidates=3,
        )

        self.assertTrue(candidates)
        best = candidates[0]
        self.assertAlmostEqual(
            best.center_x,
            target_x + target_size // 2,
            delta=2,
        )
        self.assertAlmostEqual(
            best.center_y,
            target_y + target_size // 2,
            delta=2,
        )
        self.assertGreaterEqual(best.match_count, 4)


if __name__ == "__main__":
    unittest.main()
