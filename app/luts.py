"""内置 3D LUT（.cube）生成器。

不往仓库里塞几 MB 的二进制 LUT：这里用几组调色函数在首次使用时生成 17³ 的
.cube 文件，写到 ``DATA_DIR/luts``，之后直接复用。生成过程是确定性的，同一
版本得到同样的文件。
"""
from __future__ import annotations

import math
import os
import threading

from . import config

_LOCK = threading.Lock()
_READY: dict[str, str] = {}

# 每个调色函数接收 (r, g, b) ∈ [0,1]，返回新的三元组。
def _clip(value: float) -> float:
    return 0.0 if value < 0 else (1.0 if value > 1 else value)


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def _luma(r: float, g: float, b: float) -> float:
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _s_curve(value: float, strength: float) -> float:
    return _clip(value + strength * math.sin((value - 0.5) * math.pi) * 0.5)


def cinematic(r: float, g: float, b: float) -> tuple[float, float, float]:
    luma = _luma(r, g, b)
    shadow = max(0.0, 1.0 - luma * 2.0)
    high = max(0.0, luma * 2.0 - 1.0)
    r = _clip(r + high * 0.10 - shadow * 0.04)
    g = _clip(g + high * 0.02 + shadow * 0.02)
    b = _clip(b - high * 0.06 + shadow * 0.10)
    return r, g, b


def teal_orange(r: float, g: float, b: float) -> tuple[float, float, float]:
    luma = _luma(r, g, b)
    shadow = max(0.0, 1.0 - luma * 2.2)
    high = max(0.0, luma * 2.2 - 1.0)
    r = _clip(r + high * 0.18 - shadow * 0.08)
    g = _clip(g + high * 0.05 + shadow * 0.04)
    b = _clip(b - high * 0.12 + shadow * 0.20)
    return r, g, b


def warm_film(r: float, g: float, b: float) -> tuple[float, float, float]:
    r = _clip(0.04 + r * 0.95 + 0.03)
    g = _clip(0.02 + g * 0.94)
    b = _clip(0.02 + b * 0.88 - 0.01)
    luma = _luma(r, g, b)
    r = _lerp(luma, r, 0.88)
    g = _lerp(luma, g, 0.88)
    b = _lerp(luma, b, 0.82)
    return _s_curve(r, 0.10), _s_curve(g, 0.10), _s_curve(b, 0.10)


def cool_night(r: float, g: float, b: float) -> tuple[float, float, float]:
    r = _clip(r * 0.88)
    g = _clip(g * 0.94)
    b = _clip(b * 1.06 + 0.03)
    luma = _luma(r, g, b)
    r = _lerp(luma, r, 0.85)
    g = _lerp(luma, g, 0.9)
    b = _lerp(luma, b, 1.05)
    return _clip(r), _clip(g), _clip(b)


def vivid(r: float, g: float, b: float) -> tuple[float, float, float]:
    luma = _luma(r, g, b)
    factor = 1.35
    r = _lerp(luma, r, factor)
    g = _lerp(luma, g, factor)
    b = _lerp(luma, b, factor)
    return _s_curve(_clip(r), 0.14), _s_curve(_clip(g), 0.14), _s_curve(_clip(b), 0.14)


def bw_contrast(r: float, g: float, b: float) -> tuple[float, float, float]:
    value = _s_curve(_luma(r, g, b), 0.24)
    return value, value, value


def vintage(r: float, g: float, b: float) -> tuple[float, float, float]:
    luma = _luma(r, g, b)
    r = _clip(0.10 + _lerp(luma, r, 0.65) * 0.92)
    g = _clip(0.07 + _lerp(luma, g, 0.60) * 0.86)
    b = _clip(0.05 + _lerp(luma, b, 0.55) * 0.78)
    return r, g, b


def spring(r: float, g: float, b: float) -> tuple[float, float, float]:
    r = _clip(r * 1.04 + 0.015)
    g = _clip(g * 1.06 + 0.02)
    b = _clip(b * 0.96 + 0.03)
    luma = _luma(r, g, b)
    return _lerp(luma, r, 1.08), _lerp(luma, g, 1.08), _lerp(luma, b, 1.08)


def moody(r: float, g: float, b: float) -> tuple[float, float, float]:
    luma = _luma(r, g, b)
    r = _clip(_lerp(luma, r, 0.62) - 0.02)
    g = _clip(_lerp(luma, g, 0.66) - 0.01)
    b = _clip(_lerp(luma, b, 0.74) + 0.03)
    return r, g, b


LUTS = {
    "cinematic": ("电影感", cinematic),
    "teal_orange": ("青橙", teal_orange),
    "warm_film": ("暖胶片", warm_film),
    "cool_night": ("冷夜", cool_night),
    "vivid": ("鲜艳", vivid),
    "bw_contrast": ("黑白高反差", bw_contrast),
    "vintage": ("复古", vintage),
    "spring": ("春日", spring),
    "moody": ("低饱和情绪", moody),
}

SIZE = 17


def _render_cube(func) -> str:
    lines = [f'TITLE "CineCut generated"', f"LUT_3D_SIZE {SIZE}", "DOMAIN_MIN 0.0 0.0 0.0",
             "DOMAIN_MAX 1.0 1.0 1.0"]
    for b_index in range(SIZE):
        for g_index in range(SIZE):
            for r_index in range(SIZE):
                r = r_index / (SIZE - 1)
                g = g_index / (SIZE - 1)
                b = b_index / (SIZE - 1)
                out = func(r, g, b)
                lines.append(f"{out[0]:.6f} {out[1]:.6f} {out[2]:.6f}")
    return "\n".join(lines) + "\n"


def ensure_lut(name: str) -> str:
    """返回 LUT 文件路径；未知名称回退到 cinematic。"""
    key = name if name in LUTS else "cinematic"
    with _LOCK:
        cached = _READY.get(key)
        if cached and os.path.exists(cached):
            return cached
        directory = os.path.join(config.DATA_DIR, "luts")
        os.makedirs(directory, exist_ok=True)
        path = os.path.join(directory, f"{key}.cube")
        if not os.path.exists(path):
            payload = _render_cube(LUTS[key][1])
            tmp = f"{path}.{os.getpid()}.tmp"
            with open(tmp, "w", encoding="utf-8") as handle:
                handle.write(payload)
            os.replace(tmp, path)
        _READY[key] = path
        return path
