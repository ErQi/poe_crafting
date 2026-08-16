from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

from .config_store import resolve_path
from .input_control import (
    WindowInfo,
    cursor_patch_size,
    find_game_window,
    get_cursor_hotspot,
    get_cursor_pos,
)

try:
    import mss
except ImportError:
    mss = None  # type: ignore


@dataclass
class MatchHit:
    name: str
    score: float
    # 屏幕绝对坐标（中心）
    screen_x: int
    screen_y: int
    # 相对客户区
    client_x: int
    client_y: int
    width: int
    height: int
    color_rmse: Optional[float] = None
    feature_matches: Optional[int] = None


@dataclass(frozen=True)
class FeatureCandidate:
    center_x: int
    center_y: int
    width: int
    height: int
    match_count: int
    mean_distance: float


class VisionError(RuntimeError):
    pass


# 默认只做 1.0；失败再试少量尺度（大幅加速）
DEFAULT_SCALES_FAST = (1.0,)
DEFAULT_SCALES_FALLBACK = (1.0, 0.95, 1.05)
DEFAULT_SCALES_FULL = (1.0, 0.9, 1.1, 0.8, 1.2)


def capture_region(
    left: int,
    top: int,
    width: int,
    height: int,
    sct: Optional["mss.mss"] = None,
) -> np.ndarray:
    """截取屏幕区域，返回 BGR numpy 图像。"""
    if width <= 0 or height <= 0:
        raise VisionError("截屏区域无效")
    if mss is None:
        raise VisionError("未安装 mss")
    mon = {
        "left": int(left),
        "top": int(top),
        "width": int(width),
        "height": int(height),
    }
    own = sct is None
    if own:
        sct = mss.mss()
    try:
        shot = sct.grab(mon)
        img = np.asarray(shot)  # BGRA
        return cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    finally:
        if own:
            sct.close()


def capture_window(window: WindowInfo, sct: Optional["mss.mss"] = None) -> np.ndarray:
    return capture_region(window.left, window.top, window.width, window.height, sct=sct)


def patch_rmse(a: np.ndarray, b: np.ndarray) -> float:
    if a.shape != b.shape:
        return 0.0
    diff = a.astype(np.float32) - b.astype(np.float32)
    return float(np.sqrt(np.mean(diff * diff)))


def capture_cursor_patch(
    size: Optional[int] = None,
    sct: Optional["mss.mss"] = None,
) -> Optional[np.ndarray]:
    """从实际热点原点截取光标块；尺寸按分辨率/DPI，不写死 32px。"""
    patch = cursor_patch_size() if size is None else max(32, int(size))
    cx, cy = get_cursor_pos()
    hx, hy = get_cursor_hotspot()
    try:
        return capture_region(
            max(0, int(cx) - int(hx)),
            max(0, int(cy) - int(hy)),
            patch,
            patch,
            sct=sct,
        )
    except Exception:
        return None


def load_template(path: Path) -> np.ndarray:
    if not path.exists():
        raise VisionError(f"模板不存在: {path}")
    data = np.fromfile(str(path), dtype=np.uint8)
    # 保留官方通货图标的 alpha；普通截图仍会得到 3 通道 BGR。
    img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise VisionError(f"无法读取模板: {path}")
    return img


def match_template(
    haystack_bgr: np.ndarray,
    needle_bgr: np.ndarray,
    threshold: float = 0.82,
    scales: Optional[list[float] | tuple[float, ...]] = None,
    haystack_gray: Optional[np.ndarray] = None,
    needle_gray: Optional[np.ndarray] = None,
    needle_mask: Optional[np.ndarray] = None,
    search_scale: float = 1.0,
    exclude_regions: Optional[list[tuple[int, int, int, int]]] = None,
) -> Optional[tuple[float, int, int, int, int]]:
    """
    在 haystack 中找 needle。
    返回 (score, top_left_x, top_left_y, w, h) —— 坐标相对原始 haystack。
    search_scale < 1 时先缩小搜索图加速，再把坐标映射回原图。
    exclude_regions 为原始 haystack 坐标中的 (left, top, right, bottom)，
    候选模板中心落入这些区域时不参与匹配。
    """
    if haystack_bgr is None and haystack_gray is None:
        return None
    if needle_bgr is None and needle_gray is None:
        return None

    gray_h = (
        haystack_gray
        if haystack_gray is not None
        else cv2.cvtColor(haystack_bgr, cv2.COLOR_BGR2GRAY)
    )
    gray_n0 = (
        needle_gray
        if needle_gray is not None
        else cv2.cvtColor(needle_bgr, cv2.COLOR_BGR2GRAY)
    )

    h_img, w_img = gray_h.shape[:2]
    scales = tuple(scales) if scales is not None else DEFAULT_SCALES_FAST

    # 降采样搜索
    ss = float(search_scale) if search_scale and search_scale > 0 else 1.0
    ss = min(ss, 1.0)
    if ss < 0.99:
        small_h = cv2.resize(
            gray_h,
            (max(1, int(w_img * ss)), max(1, int(h_img * ss))),
            interpolation=cv2.INTER_AREA,
        )
    else:
        small_h = gray_h
        ss = 1.0

    sh, sw = small_h.shape[:2]
    best: Optional[tuple[float, int, int, int, int]] = None

    # 先跑 1.0，足够好就提前结束
    ordered = list(scales)
    if 1.0 in ordered:
        ordered = [1.0] + [s for s in ordered if s != 1.0]

    for scale in ordered:
        # 模板在降采样坐标系下的尺寸
        nh = max(1, int(gray_n0.shape[0] * scale * ss))
        nw = max(1, int(gray_n0.shape[1] * scale * ss))
        if nh >= sh or nw >= sw:
            continue
        no_resize = abs(scale * ss - 1.0) < 1e-6 and ss == 1.0
        if no_resize:
            needle = gray_n0
        else:
            needle = cv2.resize(
                gray_n0,
                (nw, nh),
                interpolation=cv2.INTER_AREA if scale * ss < 1 else cv2.INTER_LINEAR,
            )
        mask = None
        if needle_mask is not None:
            if no_resize:
                mask = needle_mask
            else:
                mask = cv2.resize(
                    needle_mask,
                    (nw, nh),
                    interpolation=cv2.INTER_LINEAR,
                )
            # 完全透明的边缘不参与匹配，半透明边缘按 alpha 权重参与。
            mask = np.where(mask >= 8, mask, 0).astype(np.uint8)

        method = cv2.TM_CCORR_NORMED if mask is not None else cv2.TM_CCOEFF_NORMED
        res = cv2.matchTemplate(small_h, needle, method, mask=mask)
        if not np.isfinite(res).all():
            res = np.nan_to_num(res, nan=-1.0, posinf=-1.0, neginf=-1.0)
        if exclude_regions:
            # matchTemplate 的结果坐标是模板左上角。将“候选中心落入
            # 禁区”换算到当前降采样结果图，避免在目标装备图案里误命中通货。
            result_h, result_w = res.shape[:2]
            for left, top, right, bottom in exclude_regions:
                x0 = int(np.floor(left * ss - nw / 2))
                x1 = int(np.ceil(right * ss - nw / 2))
                y0 = int(np.floor(top * ss - nh / 2))
                y1 = int(np.ceil(bottom * ss - nh / 2))
                x0 = max(0, min(result_w, x0))
                x1 = max(0, min(result_w, x1))
                y0 = max(0, min(result_h, y0))
                y1 = max(0, min(result_h, y1))
                if x1 > x0 and y1 > y0:
                    res[y0:y1, x0:x1] = -1.0
        _min_val, max_val, _min_loc, max_loc = cv2.minMaxLoc(res)
        score = float(max_val)
        # 映射回原图像素
        ox = int(round(max_loc[0] / ss))
        oy = int(round(max_loc[1] / ss))
        ow = max(1, int(round(needle.shape[1] / ss)))
        oh = max(1, int(round(needle.shape[0] / ss)))
        if best is None or score > best[0]:
            best = (score, ox, oy, ow, oh)
        # 足够高分直接返回，不再扫其它尺度
        if score >= max(threshold, 0.92):
            break

    if best is None or best[0] < threshold:
        return None
    return best


def match_template_color_rmse(
    haystack_bgr: np.ndarray,
    needle_bgr: np.ndarray,
    needle_mask: Optional[np.ndarray],
    max_rmse: float = 80.0,
    scales: Optional[list[float] | tuple[float, ...]] = None,
    search_scale: float = 1.0,
    exclude_regions: Optional[list[tuple[int, int, int, int]]] = None,
) -> Optional[tuple[float, int, int, int, int, float]]:
    """用高不透明像素的 BGR 绝对色差匹配带 alpha 的通货图标。

    灰度相关对 PoE 中的圆形、高亮纹理很容易产生 0.9+ 的假分。
    这里使用 TM_SQDIFF 并换算为每通道 RMSE，返回
    (score, x, y, width, height, color_rmse)。
    """

    if haystack_bgr is None or needle_bgr is None:
        return None
    if haystack_bgr.ndim != 3 or needle_bgr.ndim != 3:
        return None

    h_img, w_img = haystack_bgr.shape[:2]
    ss = float(search_scale) if search_scale and search_scale > 0 else 1.0
    ss = min(ss, 1.0)
    if ss < 0.99:
        small_h = cv2.resize(
            haystack_bgr,
            (max(1, int(w_img * ss)), max(1, int(h_img * ss))),
            interpolation=cv2.INTER_AREA,
        )
    else:
        small_h = haystack_bgr
        ss = 1.0

    sh, sw = small_h.shape[:2]
    ordered = list(scales or DEFAULT_SCALES_FAST)
    best: Optional[tuple[float, int, int, int, int, float]] = None

    for scale in ordered:
        nh = max(1, int(needle_bgr.shape[0] * scale * ss))
        nw = max(1, int(needle_bgr.shape[1] * scale * ss))
        if nh >= sh or nw >= sw:
            continue
        interpolation = (
            cv2.INTER_AREA if scale * ss < 1.0 else cv2.INTER_LINEAR
        )
        needle = cv2.resize(
            needle_bgr,
            (nw, nh),
            interpolation=interpolation,
        )
        if needle_mask is None:
            mask = np.full((nh, nw), 255, dtype=np.uint8)
        else:
            alpha = cv2.resize(
                needle_mask,
                (nw, nh),
                interpolation=cv2.INTER_LINEAR,
            )
            # 只用高不透明核心，避免背景色影响半透明边缘。
            mask = np.where(alpha >= 192, 255, 0).astype(np.uint8)
            if np.count_nonzero(mask) < 16:
                mask = np.where(alpha >= 8, 255, 0).astype(np.uint8)
        pixel_count = int(np.count_nonzero(mask))
        if pixel_count <= 0:
            continue

        result = cv2.matchTemplate(
            small_h,
            needle,
            cv2.TM_SQDIFF,
            mask=mask,
        )
        result = np.nan_to_num(
            result,
            nan=1e30,
            posinf=1e30,
            neginf=1e30,
        )
        if exclude_regions:
            result_h, result_w = result.shape[:2]
            for left, top, right, bottom in exclude_regions:
                x0 = int(np.floor(left * ss - nw / 2))
                x1 = int(np.ceil(right * ss - nw / 2))
                y0 = int(np.floor(top * ss - nh / 2))
                y1 = int(np.ceil(bottom * ss - nh / 2))
                x0 = max(0, min(result_w, x0))
                x1 = max(0, min(result_w, x1))
                y0 = max(0, min(result_h, y0))
                y1 = max(0, min(result_h, y1))
                if x1 > x0 and y1 > y0:
                    result[y0:y1, x0:x1] = 1e30

        min_val, _max_val, min_loc, _max_loc = cv2.minMaxLoc(result)
        rmse = math.sqrt(max(0.0, float(min_val)) / (pixel_count * 3))
        ox = int(round(min_loc[0] / ss))
        oy = int(round(min_loc[1] / ss))
        ow = max(1, int(round(nw / ss)))
        oh = max(1, int(round(nh / ss)))
        score = max(0.0, min(1.0, 1.0 - rmse / 255.0))
        candidate = (score, ox, oy, ow, oh, rmse)
        if best is None or rmse < best[5]:
            best = candidate

    if best is None or best[5] > max_rmse:
        return None
    return best


def extract_sift_features(
    image_bgr: np.ndarray,
    mask: Optional[np.ndarray] = None,
) -> tuple[list, Optional[np.ndarray]]:
    """提取 SIFT 局部特征；不可用或无特征时返回空结果。"""

    if image_bgr is None:
        return [], None
    try:
        sift = cv2.SIFT_create(contrastThreshold=0.02, edgeThreshold=10)
    except (AttributeError, cv2.error):
        return [], None
    gray = (
        image_bgr
        if image_bgr.ndim == 2
        else cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    )
    try:
        keypoints, descriptors = sift.detectAndCompute(gray, mask)
    except cv2.error:
        return [], None
    return list(keypoints or []), descriptors


def match_template_feature_candidates(
    haystack_bgr: np.ndarray,
    needle_bgr: np.ndarray,
    needle_mask: Optional[np.ndarray],
    target_width: int,
    exclude_regions: Optional[list[tuple[int, int, int, int]]] = None,
    max_candidates: int = 6,
    haystack_features: Optional[tuple[list, Optional[np.ndarray]]] = None,
) -> list[FeatureCandidate]:
    """用 SIFT 特征位移聚类生成小图标候选。

    模板先缩放到本次画面实测宽度；每个特征匹配都能预测图标中心，
    多个预测在同一区域聚集时才形成候选，因此不会仅因颜色相近命中。
    """

    if haystack_bgr is None or needle_bgr is None or target_width <= 0:
        return []
    source_h, source_w = needle_bgr.shape[:2]
    if source_h <= 0 or source_w <= 0:
        return []
    width = max(12, int(round(target_width)))
    height = max(12, int(round(source_h * width / source_w)))
    needle = cv2.resize(
        needle_bgr,
        (width, height),
        interpolation=cv2.INTER_CUBIC,
    )
    mask: Optional[np.ndarray] = None
    if needle_mask is not None:
        alpha = cv2.resize(
            needle_mask,
            (width, height),
            interpolation=cv2.INTER_LINEAR,
        )
        mask = np.where(alpha >= 32, 255, 0).astype(np.uint8)

    needle_keypoints, needle_descriptors = extract_sift_features(needle, mask)
    if needle_descriptors is None or len(needle_keypoints) < 4:
        return []
    if haystack_features is None:
        frame_keypoints, frame_descriptors = extract_sift_features(haystack_bgr)
    else:
        frame_keypoints, frame_descriptors = haystack_features
    if frame_descriptors is None or len(frame_keypoints) < 4:
        return []

    try:
        matcher = cv2.FlannBasedMatcher(
            dict(algorithm=1, trees=5),
            dict(checks=50),
        )
        pairs = matcher.knnMatch(needle_descriptors, frame_descriptors, k=2)
    except cv2.error:
        return []

    predictions: list[tuple[float, float, float]] = []
    for pair in pairs:
        if len(pair) < 2:
            continue
        first, second = pair[0], pair[1]
        if first.distance >= 0.78 * second.distance:
            continue
        source_point = needle_keypoints[first.queryIdx].pt
        target_point = frame_keypoints[first.trainIdx].pt
        center_x = target_point[0] - source_point[0] + width / 2.0
        center_y = target_point[1] - source_point[1] + height / 2.0
        if center_x < 0 or center_y < 0:
            continue
        if center_x >= haystack_bgr.shape[1] or center_y >= haystack_bgr.shape[0]:
            continue
        if exclude_regions and any(
            left <= center_x < right and top <= center_y < bottom
            for left, top, right, bottom in exclude_regions
        ):
            continue
        predictions.append((center_x, center_y, float(first.distance)))

    if len(predictions) < 4:
        return []

    radius = max(10.0, float(width) * 0.27)
    radius_sq = radius * radius
    clusters: list[FeatureCandidate] = []
    for seed_x, seed_y, _seed_distance in predictions:
        members = [
            point
            for point in predictions
            if (point[0] - seed_x) ** 2 + (point[1] - seed_y) ** 2
            <= radius_sq
        ]
        if len(members) < 4:
            continue
        center_x = int(round(float(np.median([point[0] for point in members]))))
        center_y = int(round(float(np.median([point[1] for point in members]))))
        mean_distance = float(np.mean([point[2] for point in members]))
        clusters.append(
            FeatureCandidate(
                center_x=center_x,
                center_y=center_y,
                width=width,
                height=height,
                match_count=len(members),
                mean_distance=mean_distance,
            )
        )

    ordered = sorted(
        clusters,
        key=lambda candidate: (-candidate.match_count, candidate.mean_distance),
    )
    selected: list[FeatureCandidate] = []
    dedupe_radius_sq = (radius * 1.5) ** 2
    for candidate in ordered:
        if any(
            (candidate.center_x - previous.center_x) ** 2
            + (candidate.center_y - previous.center_y) ** 2
            <= dedupe_radius_sq
            for previous in selected
        ):
            continue
        selected.append(candidate)
        if len(selected) >= max_candidates:
            break
    return selected


class VisionService:
    def __init__(
        self,
        templates_dir: str | Path,
        threshold: float = 0.82,
        search_scale: float = 0.75,
        scales: Optional[list[float] | tuple[float, ...]] = None,
    ) -> None:
        self.templates_dir = resolve_path(templates_dir)
        self.threshold = threshold
        # 0.75 倍搜索在 1080p 上通常可提速 2x+，坐标会映射回原图
        self.search_scale = float(search_scale)
        self.scales: tuple[float, ...] = (
            tuple(scales) if scales is not None else DEFAULT_SCALES_FAST
        )
        self._cache_bgr: dict[str, np.ndarray] = {}
        self._cache_gray: dict[str, np.ndarray] = {}
        self._cache_mask: dict[str, Optional[np.ndarray]] = {}
        self._pos_cache: dict[str, MatchHit] = {}
        self._feature_frame_ref: Optional[np.ndarray] = None
        self._feature_frame_data: Optional[tuple[list, Optional[np.ndarray]]] = None
        self._sct = None
        self._window_height = 0
        self._window_hwnd = 0
        if mss is not None:
            try:
                self._sct = mss.mss()
            except Exception:
                self._sct = None

    def close(self) -> None:
        self._feature_frame_ref = None
        self._feature_frame_data = None
        if self._sct is not None:
            try:
                self._sct.close()
            except Exception:
                pass
            self._sct = None

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def set_threshold(self, value: float) -> None:
        self.threshold = float(value)

    def template_path(self, name: str) -> Path:
        p = Path(name)
        if p.suffix:
            return self.templates_dir / p.name
        return self.templates_dir / f"{name}.png"

    def get_template(self, name: str) -> np.ndarray:
        path = self.template_path(name)
        key = str(path)
        if key not in self._cache_bgr:
            raw = load_template(path)
            mask: Optional[np.ndarray] = None
            if raw.ndim == 2:
                gray = raw
                bgr = cv2.cvtColor(raw, cv2.COLOR_GRAY2BGR)
            elif raw.shape[2] == 4:
                bgr = raw[:, :, :3]
                gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
                alpha = raw[:, :, 3]
                if np.any(alpha < 255) and np.any(alpha >= 8):
                    mask = alpha
            else:
                bgr = raw[:, :, :3]
                gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
            self._cache_bgr[key] = bgr
            self._cache_gray[key] = gray
            self._cache_mask[key] = mask
        return self._cache_bgr[key]

    def get_template_gray(self, name: str) -> np.ndarray:
        self.get_template(name)
        return self._cache_gray[str(self.template_path(name))]

    def get_template_mask(self, name: str) -> Optional[np.ndarray]:
        self.get_template(name)
        return self._cache_mask[str(self.template_path(name))]

    def clear_cache(self) -> None:
        self._cache_bgr.clear()
        self._cache_gray.clear()
        self._cache_mask.clear()
        self._pos_cache.clear()

    def clear_position_cache(self, name: Optional[str] = None) -> None:
        if name is None:
            self._pos_cache.clear()
        else:
            self._pos_cache.pop(name, None)

    def list_templates(self) -> list[str]:
        if not self.templates_dir.exists():
            return []
        return sorted(p.name for p in self.templates_dir.glob("*.png"))

    def _note_window(self, window: WindowInfo) -> None:
        self._window_height = window.height
        self._window_hwnd = window.hwnd

    def grab_window(self, window: WindowInfo) -> np.ndarray:
        self._note_window(window)
        return capture_window(window, sct=self._sct)

    def capture_cursor_patch(self, size: Optional[int] = None) -> Optional[np.ndarray]:
        if size is None:
            size = cursor_patch_size(self._window_height, self._window_hwnd)
        return capture_cursor_patch(size, sct=self._sct)

    def match_in_frame(
        self,
        window: WindowInfo,
        frame_bgr: np.ndarray,
        template_name: str,
        threshold: Optional[float] = None,
        frame_gray: Optional[np.ndarray] = None,
        scales: Optional[list[float] | tuple[float, ...]] = None,
        use_fallback_scales: bool = True,
        exclude_regions: Optional[list[tuple[int, int, int, int]]] = None,
    ) -> Optional[MatchHit]:
        self._note_window(window)
        thr = self.threshold if threshold is None else threshold
        needle_gray = self.get_template_gray(template_name)
        needle_mask = self.get_template_mask(template_name)
        gray = (
            frame_gray
            if frame_gray is not None
            else cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        )

        hit = match_template(
            frame_bgr,
            None,  # type: ignore[arg-type]
            threshold=thr,
            scales=scales or self.scales,
            haystack_gray=gray,
            needle_gray=needle_gray,
            needle_mask=needle_mask,
            search_scale=self.search_scale,
            exclude_regions=exclude_regions,
        )
        # 快速尺度失败时再试少量 fallback（仍远快于 5 尺度全扫）
        if hit is None and use_fallback_scales and (scales is None):
            hit = match_template(
                frame_bgr,
                None,  # type: ignore[arg-type]
                threshold=thr,
                scales=DEFAULT_SCALES_FALLBACK,
                haystack_gray=gray,
                needle_gray=needle_gray,
                needle_mask=needle_mask,
                search_scale=min(1.0, self.search_scale + 0.1),
                exclude_regions=exclude_regions,
            )
        if hit is None:
            return None
        score, x, y, w, h = hit
        cx = x + w // 2
        cy = y + h // 2
        result = MatchHit(
            name=template_name,
            score=score,
            screen_x=window.left + cx,
            screen_y=window.top + cy,
            client_x=cx,
            client_y=cy,
            width=w,
            height=h,
        )
        self._pos_cache[template_name] = result
        return result

    def match_color_in_frame(
        self,
        window: WindowInfo,
        frame_bgr: np.ndarray,
        template_name: str,
        max_rmse: float = 80.0,
        scales: Optional[list[float] | tuple[float, ...]] = None,
        exclude_regions: Optional[list[tuple[int, int, int, int]]] = None,
        cache_position: bool = False,
    ) -> Optional[MatchHit]:
        """用彩色 RMSE 定位透明图标；默认不缓存未核对的候选。"""

        self._note_window(window)
        template = self.get_template(template_name)
        mask = self.get_template_mask(template_name)
        hit = match_template_color_rmse(
            frame_bgr,
            template,
            mask,
            max_rmse=max_rmse,
            scales=scales or self.scales,
            search_scale=self.search_scale,
            exclude_regions=exclude_regions,
        )
        if hit is None:
            return None
        score, x, y, width, height, rmse = hit
        center_x = x + width // 2
        center_y = y + height // 2
        result = MatchHit(
            name=template_name,
            score=score,
            screen_x=window.left + center_x,
            screen_y=window.top + center_y,
            client_x=center_x,
            client_y=center_y,
            width=width,
            height=height,
            color_rmse=rmse,
        )
        if cache_position:
            self._pos_cache[template_name] = result
        return result

    def feature_candidates_in_frame(
        self,
        window: WindowInfo,
        frame_bgr: np.ndarray,
        template_name: str,
        target_width: int,
        exclude_regions: Optional[list[tuple[int, int, int, int]]] = None,
        max_candidates: int = 6,
    ) -> list[MatchHit]:
        """按 SIFT 特征聚类返回已排序候选，并复用同一帧的特征。"""

        if self._feature_frame_ref is not frame_bgr:
            self._feature_frame_ref = frame_bgr
            self._feature_frame_data = extract_sift_features(frame_bgr)
        template = self.get_template(template_name)
        candidates = match_template_feature_candidates(
            frame_bgr,
            template,
            self.get_template_mask(template_name),
            target_width=target_width,
            exclude_regions=exclude_regions,
            max_candidates=max_candidates,
            haystack_features=self._feature_frame_data,
        )
        hits: list[MatchHit] = []
        for candidate in candidates:
            hits.append(
                MatchHit(
                    name=template_name,
                    score=min(1.0, candidate.match_count / 12.0),
                    screen_x=window.left + candidate.center_x,
                    screen_y=window.top + candidate.center_y,
                    client_x=candidate.center_x,
                    client_y=candidate.center_y,
                    width=candidate.width,
                    height=candidate.height,
                    feature_matches=candidate.match_count,
                )
            )
        return hits

    def match_near_screen(
        self,
        screen_x: int,
        screen_y: int,
        template_name: str,
        radius: int = 72,
        max_rmse: float = 80.0,
        scales: Optional[list[float] | tuple[float, ...]] = None,
    ) -> Optional[MatchHit]:
        """在屏幕坐标附近小范围做彩色匹配，不写入位置缓存。"""

        left = int(screen_x) - radius
        top = int(screen_y) - radius
        size = max(16, radius * 2)
        try:
            frame = capture_region(left, top, size, size, sct=self._sct)
        except Exception:
            return None
        raw = match_template_color_rmse(
            frame,
            self.get_template(template_name),
            self.get_template_mask(template_name),
            max_rmse=max_rmse,
            scales=scales or (0.85, 1.0, 1.15),
            search_scale=1.0,
        )
        if raw is None:
            return None
        score, x, y, width, height, rmse = raw
        center_x = left + x + width // 2
        center_y = top + y + height // 2
        return MatchHit(
            name=template_name,
            score=score,
            screen_x=center_x,
            screen_y=center_y,
            client_x=x + width // 2,
            client_y=y + height // 2,
            width=width,
            height=height,
            color_rmse=rmse,
        )

    def find_color_in_window(
        self,
        window: WindowInfo,
        template_name: str,
        max_rmse: float = 80.0,
        scales: Optional[list[float] | tuple[float, ...]] = None,
        exclude_regions: Optional[list[tuple[int, int, int, int]]] = None,
        cache_position: bool = False,
    ) -> Optional[MatchHit]:
        frame = self.grab_window(window)
        return self.match_color_in_frame(
            window,
            frame,
            template_name,
            max_rmse=max_rmse,
            scales=scales,
            exclude_regions=exclude_regions,
            cache_position=cache_position,
        )

    def find_in_window(
        self,
        window: WindowInfo,
        template_name: str,
        threshold: Optional[float] = None,
        frame_bgr: Optional[np.ndarray] = None,
        frame_gray: Optional[np.ndarray] = None,
        exclude_regions: Optional[list[tuple[int, int, int, int]]] = None,
    ) -> Optional[MatchHit]:
        if frame_bgr is None:
            frame_bgr = self.grab_window(window)
        return self.match_in_frame(
            window,
            frame_bgr,
            template_name,
            threshold=threshold,
            frame_gray=frame_gray,
            exclude_regions=exclude_regions,
        )

    def get_cached_position(self, template_name: str) -> Optional[MatchHit]:
        return self._pos_cache.get(template_name)

    def set_cached_position(self, template_name: str, hit: MatchHit) -> None:
        self._pos_cache[template_name] = hit

    def find_game(
        self,
        keywords: list[str],
        template_name: str,
        threshold: Optional[float] = None,
    ) -> tuple[Optional[WindowInfo], Optional[MatchHit]]:
        win = find_game_window(keywords)
        if win is None:
            return None, None
        return win, self.find_in_window(win, template_name, threshold=threshold)

    def test_match_report(
        self,
        keywords: list[str],
        template_names: list[str],
        threshold: Optional[float] = None,
    ) -> list[dict]:
        win = find_game_window(keywords)
        results: list[dict] = []
        if win is None:
            for name in template_names:
                results.append(
                    {"template": name, "ok": False, "error": "未找到游戏窗口"}
                )
            return results
        try:
            frame = self.grab_window(win)
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        except Exception as e:
            for name in template_names:
                results.append(
                    {"template": name, "ok": False, "error": f"截屏失败: {e}"}
                )
            return results

        thr = self.threshold if threshold is None else threshold
        for name in template_names:
            path = self.template_path(name)
            if not path.exists():
                results.append(
                    {"template": name, "ok": False, "error": f"文件不存在: {path.name}"}
                )
                continue
            try:
                hit = self.match_in_frame(
                    win,
                    frame,
                    name,
                    threshold=thr,
                    frame_gray=gray,
                    use_fallback_scales=True,
                )
                if hit is None:
                    raw = match_template(
                        frame,
                        None,  # type: ignore[arg-type]
                        threshold=0.0,
                        scales=DEFAULT_SCALES_FALLBACK,
                        haystack_gray=gray,
                        needle_gray=self.get_template_gray(name),
                        needle_mask=self.get_template_mask(name),
                        search_scale=self.search_scale,
                    )
                    score = raw[0] if raw else 0.0
                    results.append(
                        {
                            "template": name,
                            "ok": False,
                            "score": round(score, 4),
                            "error": f"低于阈值 {thr}",
                        }
                    )
                else:
                    results.append(
                        {
                            "template": name,
                            "ok": True,
                            "score": round(hit.score, 4),
                            "client_xy": (hit.client_x, hit.client_y),
                            "screen_xy": (hit.screen_x, hit.screen_y),
                        }
                    )
            except Exception as e:
                results.append({"template": name, "ok": False, "error": str(e)})
        return results
