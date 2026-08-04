from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import cv2
import numpy as np

from .config_store import resolve_path
from .input_control import WindowInfo, find_game_window

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


def load_template(path: Path) -> np.ndarray:
    if not path.exists():
        raise VisionError(f"模板不存在: {path}")
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
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
    search_scale: float = 1.0,
) -> Optional[tuple[float, int, int, int, int]]:
    """
    在 haystack 中找 needle。
    返回 (score, top_left_x, top_left_y, w, h) —— 坐标相对原始 haystack。
    search_scale < 1 时先缩小搜索图加速，再把坐标映射回原图。
    """
    if haystack_bgr is None and haystack_gray is None:
        return None
    if needle_bgr is None and needle_gray is None:
        return None

    gray_h = haystack_gray if haystack_gray is not None else cv2.cvtColor(haystack_bgr, cv2.COLOR_BGR2GRAY)
    gray_n0 = needle_gray if needle_gray is not None else cv2.cvtColor(needle_bgr, cv2.COLOR_BGR2GRAY)

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
        if abs(scale * ss - 1.0) < 1e-6 and ss == 1.0:
            needle = gray_n0
        else:
            needle = cv2.resize(
                gray_n0,
                (nw, nh),
                interpolation=cv2.INTER_AREA if scale * ss < 1 else cv2.INTER_LINEAR,
            )
        res = cv2.matchTemplate(small_h, needle, cv2.TM_CCOEFF_NORMED)
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
        self.scales: tuple[float, ...] = tuple(scales) if scales is not None else DEFAULT_SCALES_FAST
        self._cache_bgr: dict[str, np.ndarray] = {}
        self._cache_gray: dict[str, np.ndarray] = {}
        self._pos_cache: dict[str, MatchHit] = {}
        self._sct = None
        if mss is not None:
            try:
                self._sct = mss.mss()
            except Exception:
                self._sct = None

    def close(self) -> None:
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
            bgr = load_template(path)
            self._cache_bgr[key] = bgr
            self._cache_gray[key] = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        return self._cache_bgr[key]

    def get_template_gray(self, name: str) -> np.ndarray:
        self.get_template(name)
        return self._cache_gray[str(self.template_path(name))]

    def clear_cache(self) -> None:
        self._cache_bgr.clear()
        self._cache_gray.clear()
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

    def grab_window(self, window: WindowInfo) -> np.ndarray:
        return capture_window(window, sct=self._sct)

    def match_in_frame(
        self,
        window: WindowInfo,
        frame_bgr: np.ndarray,
        template_name: str,
        threshold: Optional[float] = None,
        frame_gray: Optional[np.ndarray] = None,
        scales: Optional[list[float] | tuple[float, ...]] = None,
        use_fallback_scales: bool = True,
    ) -> Optional[MatchHit]:
        thr = self.threshold if threshold is None else threshold
        needle_gray = self.get_template_gray(template_name)
        gray = frame_gray if frame_gray is not None else cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)

        hit = match_template(
            frame_bgr,
            None,  # type: ignore[arg-type]
            threshold=thr,
            scales=scales or self.scales,
            haystack_gray=gray,
            needle_gray=needle_gray,
            search_scale=self.search_scale,
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
                search_scale=min(1.0, self.search_scale + 0.1),
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

    def find_in_window(
        self,
        window: WindowInfo,
        template_name: str,
        threshold: Optional[float] = None,
        frame_bgr: Optional[np.ndarray] = None,
        frame_gray: Optional[np.ndarray] = None,
    ) -> Optional[MatchHit]:
        if frame_bgr is None:
            frame_bgr = self.grab_window(window)
        return self.match_in_frame(
            window,
            frame_bgr,
            template_name,
            threshold=threshold,
            frame_gray=frame_gray,
        )

    def get_cached_position(self, template_name: str) -> Optional[MatchHit]:
        return self._pos_cache.get(template_name)

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
                    win, frame, name, threshold=thr, frame_gray=gray, use_fallback_scales=True
                )
                if hit is None:
                    raw = match_template(
                        frame,
                        None,  # type: ignore[arg-type]
                        threshold=0.0,
                        scales=DEFAULT_SCALES_FALLBACK,
                        haystack_gray=gray,
                        needle_gray=self.get_template_gray(name),
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
