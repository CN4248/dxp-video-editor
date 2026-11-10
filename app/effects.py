"""滤镜 / 转场 / 关键帧注册表。

Shotcut 与 OpenShot 的核心能力之一是“片段级效果栈 + 参数关键帧”。这里把
可用效果集中成一张注册表：前端的参数面板、后端的 FFmpeg 滤镜链、工程文档
的字段白名单都从同一份定义生成，避免三处各写一套。

约定：
- 每个效果 ``params`` 是标量参数列表；参数都可打关键帧。
- ``video(p, ctx)`` / ``audio(p, ctx)`` 返回一段可放进 filter 链的字符串列表。
- ``needs_alpha`` 表示该效果会输出透明通道，主轨需要先合成到黑底上。
"""
from __future__ import annotations

import math
from typing import Any, Callable

# 转场类型 → 中文名。值直接对应 FFmpeg xfade 的 transition。
TRANSITIONS: dict[str, str] = {
    "fade": "淡入淡出",
    "dissolve": "溶解",
    "wipeleft": "左擦除",
    "wiperight": "右擦除",
    "wipeup": "上擦除",
    "wipedown": "下擦除",
    "slideleft": "左滑入",
    "slideright": "右滑入",
    "slideup": "上滑入",
    "slidedown": "下滑入",
    "circleopen": "圆形展开",
    "circleclose": "圆形收拢",
    "radial": "径向",
    "pixelize": "像素化",
    "hblur": "水平模糊",
    "smoothleft": "平滑左移",
    "smoothright": "平滑右移",
    "diagtl": "左上对角",
    "diagbr": "右下对角",
}

BLEND_MODES: dict[str, str] = {
    "normal": "正常",
    "add": "相加",
    "screen": "滤色",
    "multiply": "正片叠底",
    "overlay": "叠加",
    "darken": "变暗",
    "lighten": "变亮",
    "softlight": "柔光",
    "hardlight": "强光",
    "difference": "差值",
    "exclusion": "排除",
    "color": "颜色",
    "hue": "色相",
    "saturation": "饱和度",
    "luminosity": "明度",
}

EASINGS = {"linear", "hold", "easeIn", "easeOut", "easeInOut"}


def _num(value: Any, default: float, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(number) or math.isinf(number):
        return default
    return max(low, min(high, number))


def _f(value: float) -> str:
    text = f"{float(value):.4f}".rstrip("0").rstrip(".")
    return text if text not in {"", "-0"} else "0"


# ------------------------------------------------------------------ builders

def _eq(p: dict, ctx: dict) -> list[str]:
    return [
        f"eq=brightness={_f(p['brightness'])}:contrast={_f(p['contrast'])}:"
        f"saturation={_f(p['saturation'])}:gamma={_f(p['gamma'])}"
    ]


def _hue(p: dict, ctx: dict) -> list[str]:
    return [f"hue=h={_f(p['hue'])}:s={_f(p['strength'])}"]


def _temperature(p: dict, ctx: dict) -> list[str]:
    value = p["amount"]
    red = value * 0.32
    return [
        f"colorbalance=rs={_f(red)}:bs={_f(-red)}:"
        f"rm={_f(red * 0.5)}:bm={_f(-red * 0.5)}:pl=1"
    ]


def _exposure(p: dict, ctx: dict) -> list[str]:
    return [f"exposure=exposure={_f(p['exposure'])}:black={_f(p['black'])}"]


def _vignette(p: dict, ctx: dict) -> list[str]:
    angle = math.pi / max(2.2, 7.0 - 4.0 * p["amount"])
    return [f"vignette=angle={angle:.5f}:mode=forward"]


def _grain(p: dict, ctx: dict) -> list[str]:
    strength = max(1, round(p["amount"] * 100))
    return [f"noise=alls={strength}:allf=t+u"]


def _blur(p: dict, ctx: dict) -> list[str]:
    return [f"gblur=sigma={_f(p['sigma'])}:steps={max(1, int(p['steps']))}"]


def _sharpen(p: dict, ctx: dict) -> list[str]:
    return [f"unsharp=5:5:{_f(p['amount'])}:5:5:0"]


def _pixelate(p: dict, ctx: dict) -> list[str]:
    width, height = ctx["width"], ctx["height"]
    block = max(2, int(p["block"]))
    small_w = max(2, width // block)
    small_h = max(2, height // block)
    return [
        f"scale={small_w}:{small_h}:flags=neighbor",
        f"scale={width}:{height}:flags=neighbor",
    ]


def _posterize(p: dict, ctx: dict) -> list[str]:
    return [f"posterize=levels={max(2, int(p['levels']))}"]


def _edge(p: dict, ctx: dict) -> list[str]:
    return [f"edgedetect=mode={p['mode']}:high=0.3"]


def _sepia(p: dict, ctx: dict) -> list[str]:
    amount = p["amount"]
    # 原色与棕褐色的线性混合。
    return [
        "colorchannelmixer="
        f"rr={_f(0.393 + 0.607 * (1 - amount))}:rg={_f(0.769 * amount)}:rb={_f(0.189 * amount)}:"
        f"gr={_f(0.349 * amount)}:gg={_f(0.686 + 0.314 * (1 - amount))}:gb={_f(0.168 * amount)}:"
        f"br={_f(0.272 * amount)}:bg={_f(0.534 * amount)}:bb={_f(0.131 + 0.869 * (1 - amount))}"
    ]


def _mono(p: dict, ctx: dict) -> list[str]:
    amount = max(0.0, min(1.0, p["amount"]))
    saturation = 1.0 - amount
    return [f"eq=saturation={_f(saturation)}"]


def _invert(p: dict, ctx: dict) -> list[str]:
    return [f"negate=negate={_f(p['amount'])}"]


def _curves(p: dict, ctx: dict) -> list[str]:
    preset = str(p.get("preset") or "none")
    if preset not in {"none", "color_negative", "cross_process", "darker", "increase_contrast",
                      "lighter", "linear_contrast", "medium_contrast", "negative",
                      "strong_contrast", "vintage"}:
        preset = "medium_contrast"
    return [f"curves=preset={preset}"]


def _lift_gamma_gain(p: dict, ctx: dict) -> list[str]:
    lift = p["lift"]
    gamma = p["gamma"]
    gain = p["gain"]
    filters = [
        f"colorbalance=rs={_f(lift)}:gs={_f(lift * 0.9)}:bs={_f(lift)}:"
        f"rm={_f(gamma)}:gm={_f(gamma)}:bm={_f(gamma)}:"
        f"rh={_f(gain)}:gh={_f(gain * 0.9)}:bh={_f(gain)}:pl=1"
    ]
    return filters


def _lut(p: dict, ctx: dict) -> list[str]:
    from . import luts
    path = luts.ensure_lut(str(p.get("name") or "cinematic"))
    if not path:
        return []
    return [f"lut3d=file='{path}'"]


def _deinterlace(p: dict, ctx: dict) -> list[str]:
    return ["yadif=mode=send_frame:parity=auto:deint=all"]


def _deshake(p: dict, ctx: dict) -> list[str]:
    return ["deshake=rx=32:ry=32:edge=mirror"]


def _denoise(p: dict, ctx: dict) -> list[str]:
    return [f"nlmeans=s={_f(p['strength'])}:p=7:r=15"]


def _letterbox(p: dict, ctx: dict) -> list[str]:
    ratio = max(1.0, min(3.0, p["ratio"]))
    height = ctx["height"]
    bar = max(0, round((height - height / ratio) / 2))
    if bar <= 0:
        return []
    return [
        f"drawbox=x=0:y=0:w=iw:h={bar}:color=black:t=fill",
        f"drawbox=x=0:y=ih-{bar}:w=iw:h={bar}:color=black:t=fill",
    ]


def _chromakey(p: dict, ctx: dict) -> list[str]:
    color = str(p.get("color") or "0x00ff00")
    if not color.startswith("0x") and not color.startswith("#"):
        color = "0x00ff00"
    return [
        "format=rgba",
        f"chromakey=color={color}:similarity={_f(p['similarity'])}:blend={_f(p['blend'])}",
        "despill=type=green:mix=0.5",
    ]


def _opacity(p: dict, ctx: dict) -> list[str]:
    return [f"colorchannelmixer=aa={_f(p['alpha'])}"]


def _crop(p: dict, ctx: dict) -> list[str]:
    width, height = ctx["width"], ctx["height"]
    left = round(_num(p.get("left"), 0.0, 0, 0.95) * width / 2) * 2
    right = round(_num(p.get("right"), 0.0, 0, 0.95) * width / 2) * 2
    top = round(_num(p.get("top"), 0.0, 0, 0.95) * height / 2) * 2
    bottom = round(_num(p.get("bottom"), 0.0, 0, 0.95) * height / 2) * 2
    crop_w = max(2, width - left - right)
    crop_h = max(2, height - top - bottom)
    return [
        f"crop={crop_w}:{crop_h}:{left}:{top}",
        f"scale={width}:{height}",
    ]


def _rotate(p: dict, ctx: dict) -> list[str]:
    angle = float(p["angle"])
    return [f"rotate={_f(angle)}*PI/180:ow=rotw(iw):oh=roth(ih):c=black"]


# ------------------------------------------------------------------- audio

def _a_volume(p: dict, ctx: dict) -> list[str]:
    return [f"volume={_f(p['gain'])}"]


def _a_highpass(p: dict, ctx: dict) -> list[str]:
    return [f"highpass=f={_f(p['freq'])}"]


def _a_lowpass(p: dict, ctx: dict) -> list[str]:
    return [f"lowpass=f={_f(p['freq'])}"]


def _a_equalizer(p: dict, ctx: dict) -> list[str]:
    return [
        f"equalizer=f={_f(p['freq'])}:t=q:w={_f(p['width'])}:g={_f(p['gain'])}"
    ]


def _a_bass(p: dict, ctx: dict) -> list[str]:
    return [f"bass=g={_f(p['gain'])}:f={_f(p['freq'])}:width_type=q:w=1"]


def _a_treble(p: dict, ctx: dict) -> list[str]:
    return [f"treble=g={_f(p['gain'])}:f={_f(p['freq'])}:width_type=q:w=1"]


def _a_compressor(p: dict, ctx: dict) -> list[str]:
    return [
        f"acompressor=threshold={_f(p['threshold'])}dB:ratio={_f(p['ratio'])}:"
        f"attack={_f(p['attack'])}:release={_f(p['release'])}:makeup={_f(p['makeup'])}"
    ]


def _a_limiter(p: dict, ctx: dict) -> list[str]:
    return [f"alimiter=limit={_f(p['limit'])}:level=false"]


def _a_gate(p: dict, ctx: dict) -> list[str]:
    return [
        f"agate=threshold={_f(p['threshold'])}:ratio={_f(p['ratio'])}:"
        f"attack={_f(p['attack'])}:release={_f(p['release'])}"
    ]


def _a_reverb(p: dict, ctx: dict) -> list[str]:
    delay = max(20, int(p["delay"]))
    return [
        f"aecho=in_gain=0.8:out_gain={_f(p['mix'])}:delays={delay}:decays={_f(p['decay'])}"
    ]


def _a_pitch(p: dict, ctx: dict) -> list[str]:
    return [f"rubberband=pitch={_f(p['pitch'])}"]


def _a_stereo(p: dict, ctx: dict) -> list[str]:
    return [f"extrastereo=m={_f(p['width'])}"]


def _a_normalize(p: dict, ctx: dict) -> list[str]:
    return [f"dynaudnorm=f=200:g={max(1, int(p['frames']))}:p=0.9"]


def _a_muffle(p: dict, ctx: dict) -> list[str]:
    return [f"lowpass=f={_f(p['freq'])}", f"volume={_f(p.get('gain', 1.0))}"]


def _a_pan(p: dict, ctx: dict) -> list[str]:
    left = max(0.0, min(1.0, p["left"]))
    right = max(0.0, min(1.0, p["right"]))
    return [f"pan=stereo|c0={_f(left)}*c0|c1={_f(right)}*c1"]


# ------------------------------------------------------------------ registry

VideoBuilder = Callable[[dict, dict], list[str]]

EFFECTS: dict[str, dict] = {}


def _effect(key: str, label: str, category: str, params: list[dict],
            video: VideoBuilder | None = None, audio: VideoBuilder | None = None,
            needs_alpha: bool = False, description: str = "") -> None:
    EFFECTS[key] = {
        "id": key,
        "label": label,
        "category": category,
        "kind": "audio" if audio and not video else ("video" if video and not audio else "both"),
        "params": params,
        "video": video,
        "audio": audio,
        "needsAlpha": needs_alpha,
        "description": description,
    }


def _p(key: str, label: str, default: float, low: float, high: float,
       step: float = 0.01, unit: str = "") -> dict:
    return {"key": key, "label": label, "default": default, "min": low,
            "max": high, "step": step, "unit": unit}


# 调色 / 画面
_effect("brightness", "亮度", "color", [_p("brightness", "亮度", 0.0, -1.0, 1.0)],
        video=_eq, description="提亮或压暗画面")
_effect("contrast", "对比度", "color",
        [_p("contrast", "对比", 1.0, 0.0, 3.0)],
        video=lambda p, c: [f"eq=contrast={_f(p['contrast'])}"],
        description="调整明暗反差")
_effect("saturation", "饱和度", "color",
        [_p("saturation", "饱和", 1.0, 0.0, 3.0)],
        video=lambda p, c: [f"eq=saturation={_f(p['saturation'])}"],
        description="控制色彩浓淡")
_effect("gamma", "伽马", "color",
        [_p("gamma", "伽马", 1.0, 0.1, 4.0)],
        video=lambda p, c: [f"eq=gamma={_f(p['gamma'])}"],
        description="调整中间调亮度")
_effect("hue", "色相", "color",
        [_p("hue", "色相", 0.0, -180.0, 180.0, 1, "°"),
         _p("strength", "强度", 1.0, 0.0, 3.0)],
        video=_hue)
_effect("temperature", "色温", "color",
        [_p("amount", "冷暖", 0.0, -1.0, 1.0)], video=_temperature)
_effect("exposure", "曝光", "color",
        [_p("exposure", "曝光", 0.0, -3.0, 3.0),
         _p("black", "黑场", 0.0, -1.0, 1.0)], video=_exposure)
_effect("vignette", "暗角", "color",
        [_p("amount", "强度", 0.4, 0.0, 1.0)], video=_vignette)
_effect("lift_gamma_gain", "三向调色", "color",
        [_p("lift", "阴影", 0.0, -0.5, 0.5),
         _p("gamma", "中间调", 0.0, -0.5, 0.5),
         _p("gain", "高光", 0.0, -0.5, 0.5)], video=_lift_gamma_gain)
_effect("curves", "曲线预设", "color",
        [{"key": "preset", "label": "预设", "default": "medium_contrast",
          "options": ["none", "vintage", "strong_contrast", "medium_contrast",
                      "increase_contrast", "lighter", "darker", "cross_process",
                      "color_negative", "negative", "linear_contrast"]}],
        video=_curves)
_effect("sepia", "棕褐", "color",
        [_p("amount", "强度", 0.8, 0.0, 1.0)], video=_sepia)
_effect("mono", "黑白", "color",
        [_p("amount", "强度", 1.0, 0.0, 1.0)], video=_mono)
_effect("invert", "反相", "color",
        [_p("amount", "强度", 1.0, 0.0, 1.0)], video=_invert)
_effect("lut", "3D LUT", "color",
        [{"key": "name", "label": "LUT", "default": "cinematic",
          "options": ["cinematic", "teal_orange", "warm_film", "cool_night",
                      "vivid", "bw_contrast", "vintage", "spring", "moody"]}],
        video=_lut, description="电影感 3D LUT 调色")

# 模糊 / 风格
_effect("blur", "高斯模糊", "blur",
        [_p("sigma", "半径", 8.0, 0.0, 60.0),
         _p("steps", "质量", 2.0, 1.0, 6.0, 1)], video=_blur)
_effect("sharpen", "锐化", "stylize",
        [_p("amount", "强度", 1.2, 0.0, 5.0)], video=_sharpen)
_effect("pixelate", "像素化", "stylize",
        [_p("block", "像素块", 16.0, 2.0, 96.0, 1)], video=_pixelate)
_effect("posterize", "色阶海报", "stylize",
        [_p("levels", "色阶", 6.0, 2.0, 32.0, 1)], video=_posterize)
_effect("edge", "描边", "stylize",
        [{"key": "mode", "label": "模式", "default": "colormix",
          "options": ["colormix", "wires"]}], video=_edge)
_effect("grain", "胶片颗粒", "stylize",
        [_p("amount", "强度", 0.15, 0.01, 1.0)], video=_grain)
_effect("letterbox", "遮幅", "stylize",
        [_p("ratio", "画幅比", 2.35, 1.0, 3.0)], video=_letterbox)
_effect("deinterlace", "去隔行", "stylize", [], video=_deinterlace)
_effect("deshake", "防抖", "stylize", [], video=_deshake)
_effect("denoise", "降噪", "stylize",
        [_p("strength", "强度", 0.02, 0.001, 0.3, 0.001)], video=_denoise)
_effect("crop", "裁剪", "transform",
        [_p("left", "左", 0.0, 0.0, 0.45),
         _p("right", "右", 0.0, 0.0, 0.45),
         _p("top", "上", 0.0, 0.0, 0.45),
         _p("bottom", "下", 0.0, 0.0, 0.45)], video=_crop)
_effect("rotate", "旋转", "transform",
        [_p("angle", "角度", 0.0, -180.0, 180.0, 1, "°")], video=_rotate)
_effect("chromakey", "色度键", "key",
        [{"key": "color", "label": "键色", "default": "0x00ff00",
          "options": ["0x00ff00", "0x0000ff", "0xff0000", "0xffffff"]},
         _p("similarity", "容差", 0.12, 0.01, 0.6),
         _p("blend", "边缘", 0.08, 0.0, 0.5)],
        video=_chromakey, needs_alpha=True)
_effect("opacity", "不透明度", "transform",
        [_p("alpha", "不透明", 1.0, 0.0, 1.0)], video=_opacity, needs_alpha=True)

# 音频
_effect("a_volume", "音量", "audio",
        [_p("gain", "增益", 1.0, 0.0, 4.0)], audio=_a_volume)
_effect("a_highpass", "低切", "audio",
        [_p("freq", "频率", 80.0, 20.0, 2000.0, 1, "Hz")], audio=_a_highpass)
_effect("a_lowpass", "高切", "audio",
        [_p("freq", "频率", 12000.0, 1000.0, 20000.0, 1, "Hz")], audio=_a_lowpass)
_effect("a_eq", "均衡器", "audio",
        [_p("freq", "频率", 1000.0, 20.0, 18000.0, 1, "Hz"),
         _p("width", "带宽", 1.0, 0.1, 10.0),
         _p("gain", "增益", 0.0, -20.0, 20.0, 0.1, "dB")], audio=_a_equalizer)
_effect("a_bass", "低音", "audio",
        [_p("gain", "增益", 0.0, -20.0, 20.0, 0.1, "dB"),
         _p("freq", "分频", 110.0, 40.0, 400.0, 1, "Hz")], audio=_a_bass)
_effect("a_treble", "高音", "audio",
        [_p("gain", "增益", 0.0, -20.0, 20.0, 0.1, "dB"),
         _p("freq", "分频", 3000.0, 1000.0, 12000.0, 1, "Hz")], audio=_a_treble)
_effect("a_compressor", "压缩器", "audio",
        [_p("threshold", "阈值", 0.1, 0.001, 1.0, 0.001),
         _p("ratio", "压缩比", 3.0, 1.0, 20.0, 0.1),
         _p("attack", "启动", 20.0, 0.01, 200.0, 0.1, "ms"),
         _p("release", "释放", 250.0, 10.0, 2000.0, 1, "ms"),
         _p("makeup", "补偿", 1.0, 1.0, 10.0)], audio=_a_compressor)
_effect("a_limiter", "限幅器", "audio",
        [_p("limit", "上限", 0.95, 0.1, 1.0)], audio=_a_limiter)
_effect("a_gate", "噪声门", "audio",
        [_p("threshold", "阈值", 0.02, 0.0, 0.5, 0.001),
         _p("ratio", "压缩比", 2.0, 1.0, 20.0, 0.1),
         _p("attack", "启动", 20.0, 0.01, 200.0, 0.1, "ms"),
         _p("release", "释放", 250.0, 10.0, 2000.0, 1, "ms")], audio=_a_gate)
_effect("a_reverb", "混响", "audio",
        [_p("mix", "湿度", 0.4, 0.0, 1.0),
         _p("delay", "延迟", 120.0, 20.0, 800.0, 1, "ms"),
         _p("decay", "衰减", 0.35, 0.05, 0.9)], audio=_a_reverb)
_effect("a_pitch", "变调", "audio",
        [_p("pitch", "音高", 1.0, 0.5, 2.0)], audio=_a_pitch,
        description="保持时长改变音高（rubberband）")
_effect("a_stereo", "立体声宽度", "audio",
        [_p("width", "宽度", 1.0, 0.0, 3.0)], audio=_a_stereo)
_effect("a_normalize", "响度归一", "audio",
        [_p("frames", "窗口", 150.0, 10.0, 500.0, 1)], audio=_a_normalize)
_effect("a_muffle", "闷音", "audio",
        [_p("freq", "截止", 900.0, 200.0, 5000.0, 1, "Hz"),
         _p("gain", "增益", 1.0, 0.0, 2.0)], audio=_a_muffle)
_effect("a_pan", "声像", "audio",
        [_p("left", "左", 1.0, 0.0, 1.0), _p("right", "右", 1.0, 0.0, 1.0)],
        audio=_a_pan)


def public_catalog() -> dict:
    items = []
    for item in EFFECTS.values():
        entry = {key: item[key] for key in
                 ("id", "label", "category", "kind", "params", "needsAlpha", "description")}
        items.append(entry)
    return {
        "effects": items,
        "transitions": [{"id": key, "label": value} for key, value in TRANSITIONS.items()],
        "blendModes": [{"id": key, "label": value} for key, value in BLEND_MODES.items()],
        "easings": sorted(EASINGS),
    }


# ------------------------------------------------------------------ keyframes

def easing(t: float, mode: str) -> float:
    t = max(0.0, min(1.0, t))
    if mode == "hold":
        return 0.0
    if mode == "easeIn":
        return t * t
    if mode == "easeOut":
        return 1 - (1 - t) * (1 - t)
    if mode == "easeInOut":
        return 3 * t * t - 2 * t * t * t
    return t


def sample_keyframes(points: list[dict], t: float) -> float | None:
    """按时间 t 采样关键帧，返回 None 表示该参数没有关键帧。"""
    if not points:
        return None
    ordered = sorted(points, key=lambda p: float(p.get("t") or 0))
    if t <= float(ordered[0]["t"]):
        return float(ordered[0]["v"])
    if t >= float(ordered[-1]["t"]):
        return float(ordered[-1]["v"])
    for left, right in zip(ordered, ordered[1:]):
        l_t, r_t = float(left["t"]), float(right["t"])
        if l_t <= t <= r_t:
            span = max(1e-6, r_t - l_t)
            ratio = easing((t - l_t) / span, str(left.get("ease") or "linear"))
            return float(left["v"]) + (float(right["v"]) - float(left["v"])) * ratio
    return float(ordered[-1]["v"])


def sample_effect(effect: dict, t: float) -> dict:
    """返回在 t 时刻参数已固化的效果副本。"""
    sampled = dict(effect)
    params = dict(effect.get("params") or {})
    for key, points in (effect.get("keyframes") or {}).items():
        value = sample_keyframes(points, t)
        if value is not None:
            params[key] = value
    sampled["params"] = params
    return sampled


def default_params(effect_id: str) -> dict:
    spec = EFFECTS.get(effect_id)
    if not spec:
        return {}
    result = {}
    for param in spec["params"]:
        result[param["key"]] = param["default"]
    return result


def video_filters(effects: list[dict], t: float, ctx: dict) -> tuple[list[str], bool]:
    filters: list[str] = []
    needs_alpha = False
    for effect in effects or []:
        if not effect.get("enabled", True):
            continue
        spec = EFFECTS.get(str(effect.get("type") or ""))
        if not spec or not spec["video"]:
            continue
        params = dict(spec["params_default"]) if spec.get("params_default") else {}
        params.update(default_params(spec["id"]))
        params.update(effect.get("params") or {})
        params = sample_effect({"params": params, "keyframes": effect.get("keyframes") or {}}, t)["params"]
        try:
            filters += spec["video"](params, ctx)
        except Exception:
            continue
        if spec.get("needsAlpha"):
            needs_alpha = True
    return filters, needs_alpha


def audio_filters(effects: list[dict], t: float, ctx: dict) -> list[str]:
    filters: list[str] = []
    for effect in effects or []:
        if not effect.get("enabled", True):
            continue
        spec = EFFECTS.get(str(effect.get("type") or ""))
        if not spec or not spec["audio"]:
            continue
        params = {}
        params.update(default_params(spec["id"]))
        params.update(effect.get("params") or {})
        params = sample_effect({"params": params, "keyframes": effect.get("keyframes") or {}}, t)["params"]
        try:
            filters += spec["audio"](params, ctx)
        except Exception:
            continue
    return filters


def keyframe_times(item: dict) -> list[float]:
    times: set[float] = set()
    for points in (item.get("keyframes") or {}).values():
        for point in points or []:
            try:
                times.add(round(float(point.get("t") or 0), 3))
            except (TypeError, ValueError):
                continue
    for effect in item.get("effects") or []:
        for points in (effect.get("keyframes") or {}).values():
            for point in points or []:
                try:
                    times.add(round(float(point.get("t") or 0), 3))
                except (TypeError, ValueError):
                    continue
    return sorted(times)
