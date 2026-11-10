"""工程文档模型：默认值、字段白名单、时长与转场折算。

文档是前后端之间唯一的契约。所有落库/渲染的数据都必须先经过
``sanitize_doc``，避免任意 JSON 进入 FFmpeg 参数。
"""
from __future__ import annotations

import re
import uuid
from typing import Any

from pathlib import Path

from . import effects

VERSION = 2

PRESETS = {
    "landscape": {"width": 1920, "height": 1080, "label": "横屏 1080p"},
    "landscape4k": {"width": 3840, "height": 2160, "label": "横屏 4K"},
    "portrait": {"width": 1080, "height": 1920, "label": "竖屏 1080p"},
    "square": {"width": 1080, "height": 1080, "label": "方形 1080"},
    "vertical720": {"width": 720, "height": 1280, "label": "竖屏 720p"},
    "cinema": {"width": 2560, "height": 1080, "label": "宽银幕"},
}

HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
MAX_TRACKS_PER_TYPE = 12
TRACK_TYPES = {"video", "audio", "text"}

MAX_EFFECTS = 24
MAX_KEYFRAMES = 96
MAX_MARKERS = 200

KEYFRAME_KEYS = {
    "main": {"scale", "rotate", "opacity", "volume"},
    "overlay": {"x", "y", "scale", "rotate", "opacity"},
    "audio": {"volume", "pan"},
    "text": {"x", "y", "size", "opacity"},
}

FIT_MODES = {"contain", "cover", "stretch"}
MOSAIC_MODES = {"pixel", "blur", "box", "black"}
BLEND_IDS = set(effects.BLEND_MODES)
TRANSITION_IDS = set(effects.TRANSITIONS)


def _num(value: Any, default: float, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number or number in (float("inf"), float("-inf")):
        return default
    return max(low, min(high, number))


def _int(value: Any, default: int, low: int, high: int) -> int:
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def _bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return default


def _text(value: Any, default: str = "", limit: int = 240) -> str:
    if not isinstance(value, str):
        return default
    return value[:limit]


def _id(value: Any) -> str:
    text = _text(value, "", 48)
    if re.fullmatch(r"[A-Za-z0-9_-]{1,48}", text or ""):
        return text
    return uuid.uuid4().hex[:12]


def _src(value: Any) -> str:
    text = _text(value, "", 1024).strip()
    if not text:
        return ""
    if text.startswith("/") or ".." in text.split("/"):
        return ""
    return text


def _color(value: Any, default: str = "#ffffff") -> str:
    text = _text(value, default, 9)
    return text if HEX_COLOR.match(text) else default


def _rotate(value: Any) -> int:
    angle = _int(value, 0, -360, 360)
    return angle


def _fit(value: Any) -> str:
    text = _text(value, "contain", 16)
    return text if text in FIT_MODES else "contain"


def _mosaic_mode(value: Any) -> str:
    text = _text(value, "pixel", 16)
    return text if text in MOSAIC_MODES else "pixel"


def _blend(value: Any) -> str:
    text = _text(value, "normal", 24)
    return text if text in BLEND_IDS else "normal"


# --------------------------------------------------------------- keyframes

def _keyframes(value: Any, allowed: set[str]) -> dict:
    result: dict[str, list[dict]] = {}
    if not isinstance(value, dict):
        return result
    for key, points in value.items():
        if key not in allowed or not isinstance(points, list):
            continue
        clean: list[dict] = []
        for point in points[:MAX_KEYFRAMES]:
            if not isinstance(point, dict):
                continue
            t = _num(point.get("t"), 0.0, 0.0, 12 * 3600)
            v = _num(point.get("v"), 0.0, -100000.0, 100000.0)
            ease = _text(point.get("ease"), "linear", 16)
            if ease not in effects.EASINGS:
                ease = "linear"
            clean.append({"t": round(t, 3), "v": v, "ease": ease})
        clean.sort(key=lambda item: item["t"])
        if clean:
            result[key] = clean
    return result


def _effect_params(effect_id: str, value: Any) -> dict:
    spec = effects.EFFECTS.get(effect_id)
    if not spec:
        return {}
    result: dict[str, Any] = {}
    given = value if isinstance(value, dict) else {}
    for param in spec["params"]:
        key = param["key"]
        if "options" in param:
            text = _text(given.get(key), str(param["default"]), 64)
            result[key] = text if text in param["options"] else param["default"]
        else:
            result[key] = _num(given.get(key), float(param["default"]),
                               float(param["min"]), float(param["max"]))
    return result


def _effects(value: Any) -> list[dict]:
    result: list[dict] = []
    if not isinstance(value, list):
        return result
    for raw in value[:MAX_EFFECTS]:
        if not isinstance(raw, dict):
            continue
        effect_id = _text(raw.get("type"), "", 32)
        spec = effects.EFFECTS.get(effect_id)
        if not spec:
            continue
        frames = _keyframes(raw.get("keyframes"),
                            {param["key"] for param in spec["params"]})
        result.append({
            "id": _id(raw.get("id")),
            "type": effect_id,
            "enabled": _bool(raw.get("enabled"), True),
            "params": _effect_params(effect_id, raw.get("params")),
            "keyframes": frames,
        })
    return result


def _mask(value: Any) -> dict:
    raw = value if isinstance(value, dict) else {}
    return {
        "enabled": _bool(raw.get("enabled"), False),
        "shape": _text(raw.get("shape"), "rect", 12) if _text(raw.get("shape"), "rect", 12) in {"rect", "ellipse"} else "rect",
        "x": _num(raw.get("x"), 0.1, 0.0, 1.0),
        "y": _num(raw.get("y"), 0.1, 0.0, 1.0),
        "w": _num(raw.get("w"), 0.8, 0.02, 1.0),
        "h": _num(raw.get("h"), 0.8, 0.02, 1.0),
        "feather": _num(raw.get("feather"), 0.0, 0.0, 0.5),
        "invert": _bool(raw.get("invert"), False),
    }


def _crop(value: Any) -> dict:
    raw = value if isinstance(value, dict) else {}
    return {
        "left": _num(raw.get("left"), 0.0, 0.0, 0.45),
        "right": _num(raw.get("right"), 0.0, 0.0, 0.45),
        "top": _num(raw.get("top"), 0.0, 0.0, 0.45),
        "bottom": _num(raw.get("bottom"), 0.0, 0.0, 0.45),
    }


def _transition(value: Any, duration: float) -> dict | None:
    if not isinstance(value, dict):
        return None
    if _bool(value.get("enabled"), True) is False:
        return None
    kind = _text(value.get("type"), "fade", 24)
    if kind in {"", "none"}:
        return None
    if kind not in TRANSITION_IDS:
        kind = "fade"
    raw = _num(value.get("duration"), 0.6, 0.0, 5.0)
    if raw <= 0.001:
        return None
    length = round(min(raw, max(0.1, duration * 0.6)), 3)
    return {"type": kind, "duration": length}


def _markers(value: Any, total: float) -> list[dict]:
    result: list[dict] = []
    if not isinstance(value, list):
        return result
    for raw in value[:MAX_MARKERS]:
        if not isinstance(raw, dict):
            continue
        result.append({
            "id": _id(raw.get("id")),
            "time": round(_num(raw.get("time"), 0.0, 0.0, max(0.0, total)), 3),
            "label": _text(raw.get("label"), "标记", 80),
            "color": _color(raw.get("color"), "#ffd166"),
        })
    result.sort(key=lambda item: item["time"])
    return result


# ------------------------------------------------------------------ items

def _clip(value: Any) -> dict:
    raw = value if isinstance(value, dict) else {}
    start_in = _num(raw.get("in"), 0.0, 0.0, 24 * 3600)
    out = _num(raw.get("out"), start_in + 1.0, 0.01, 24 * 3600)
    if out <= start_in:
        out = start_in + 1.0
    clip = {
        "id": _id(raw.get("id")),
        "kind": "video" if _text(raw.get("kind"), "video", 12) != "image" else "image",
        "src": _src(raw.get("src")),
        "in": round(start_in, 3),
        "out": round(out, 3),
        "speed": round(_num(raw.get("speed"), 1.0, 0.05, 16.0), 4),
        "volume": round(_num(raw.get("volume"), 1.0, 0.0, 2.0), 4),
        "muted": _bool(raw.get("muted")),
        "scale": round(_num(raw.get("scale"), 1.0, 0.05, 8.0), 4),
        "rotate": _rotate(raw.get("rotate")),
        "flipH": _bool(raw.get("flipH")),
        "flipV": _bool(raw.get("flipV")),
        "fit": _fit(raw.get("fit")),
        "fadeIn": round(_num(raw.get("fadeIn"), 0.0, 0.0, 30.0), 3),
        "fadeOut": round(_num(raw.get("fadeOut"), 0.0, 0.0, 30.0), 3),
        "hasAudio": _bool(raw.get("hasAudio"), True),
        "audioDetached": _bool(raw.get("audioDetached")),
        "mosaic": _bool(raw.get("mosaic")),
        "mosaicMode": _mosaic_mode(raw.get("mosaicMode")),
        "mosaicX": round(_num(raw.get("mosaicX"), 0.25, 0.0, 0.95), 4),
        "mosaicY": round(_num(raw.get("mosaicY"), 0.25, 0.0, 0.95), 4),
        "mosaicW": round(_num(raw.get("mosaicW"), 0.3, 0.02, 1.0), 4),
        "mosaicH": round(_num(raw.get("mosaicH"), 0.3, 0.02, 1.0), 4),
        "mosaicBlock": _int(raw.get("mosaicBlock"), 12, 2, 64),
        "effects": _effects(raw.get("effects")),
        "keyframes": _keyframes(raw.get("keyframes"), KEYFRAME_KEYS["main"]),
        "crop": _crop(raw.get("crop")),
        "mask": _mask(raw.get("mask")),
        "opacity": round(_num(raw.get("opacity"), 1.0, 0.0, 1.0), 4),
        "blend": _blend(raw.get("blend")),
    }
    clip["duration"] = clip_duration(clip)
    clip["transition"] = _transition(raw.get("transition"), clip["duration"])
    return clip


def _overlay(value: Any) -> dict:
    raw = value if isinstance(value, dict) else {}
    kind = _text(raw.get("kind"), "image", 12)
    overlay = {
        "id": _id(raw.get("id")),
        "kind": kind if kind in {"image", "video"} else "image",
        "trackId": _id(raw.get("trackId")),
        "src": _src(raw.get("src")),
        "in": round(_num(raw.get("in"), 0.0, 0.0, 24 * 3600), 3),
        "start": round(_num(raw.get("start"), 0.0, 0.0, 12 * 3600), 3),
        "duration": round(_num(raw.get("duration"), 3.0, 0.02, 12 * 3600), 3),
        "x": round(_num(raw.get("x"), 0.5, -1.0, 2.0), 4),
        "y": round(_num(raw.get("y"), 0.5, -1.0, 2.0), 4),
        "scale": round(_num(raw.get("scale"), 1.0, 0.01, 8.0), 4),
        "rotate": _rotate(raw.get("rotate")),
        "opacity": round(_num(raw.get("opacity"), 1.0, 0.0, 1.0), 4),
        "blend": _blend(raw.get("blend")),
        "effects": _effects(raw.get("effects")),
        "keyframes": _keyframes(raw.get("keyframes"), KEYFRAME_KEYS["overlay"]),
        "crop": _crop(raw.get("crop")),
        "mask": _mask(raw.get("mask")),
    }
    return overlay


def _audio(value: Any) -> dict:
    raw = value if isinstance(value, dict) else {}
    audio = {
        "id": _id(raw.get("id")),
        "trackId": _id(raw.get("trackId")),
        "src": _src(raw.get("src")),
        "in": round(_num(raw.get("in"), 0.0, 0.0, 24 * 3600), 3),
        "start": round(_num(raw.get("start"), 0.0, 0.0, 12 * 3600), 3),
        "duration": round(_num(raw.get("duration"), 3.0, 0.02, 12 * 3600), 3),
        "volume": round(_num(raw.get("volume"), 1.0, 0.0, 2.0), 4),
        "muted": _bool(raw.get("muted")),
        "speed": round(_num(raw.get("speed"), 1.0, 0.05, 16.0), 4),
        "fadeIn": round(_num(raw.get("fadeIn"), 0.0, 0.0, 30.0), 3),
        "fadeOut": round(_num(raw.get("fadeOut"), 0.0, 0.0, 30.0), 3),
        "loop": _bool(raw.get("loop")),
        "pan": round(_num(raw.get("pan"), 0.0, -1.0, 1.0), 4),
        "linkedMainId": _text(raw.get("linkedMainId"), "", 48),
        "linkedOverlayId": _text(raw.get("linkedOverlayId"), "", 48),
        "effects": _effects(raw.get("effects")),
        "keyframes": _keyframes(raw.get("keyframes"), KEYFRAME_KEYS["audio"]),
    }
    return audio


def _text_item(value: Any) -> dict:
    raw = value if isinstance(value, dict) else {}
    item = {
        "id": _id(raw.get("id")),
        "trackId": _id(raw.get("trackId")),
        "text": _text(raw.get("text"), "文字", 400),
        "start": round(_num(raw.get("start"), 0.0, 0.0, 12 * 3600), 3),
        "duration": round(_num(raw.get("duration"), 3.0, 0.02, 12 * 3600), 3),
        "x": round(_num(raw.get("x"), 0.5, -0.5, 1.5), 4),
        "y": round(_num(raw.get("y"), 0.8, -0.5, 1.5), 4),
        "size": _int(raw.get("size"), 64, 8, 400),
        "color": _color(raw.get("color"), "#ffffff"),
        "bg": _color(raw.get("bg"), "#000000") if _bool(raw.get("bgEnabled"), False) else "",
        "bgEnabled": _bool(raw.get("bgEnabled"), False),
        "bgAlpha": round(_num(raw.get("bgAlpha"), 0.55, 0.0, 1.0), 3),
        "bold": _bool(raw.get("bold"), True),
        "italic": _bool(raw.get("italic"), False),
        "outline": _int(raw.get("outline"), 3, 0, 20),
        "shadow": _int(raw.get("shadow"), 0, 0, 20),
        "opacity": round(_num(raw.get("opacity"), 1.0, 0.0, 1.0), 4),
        "keyframes": _keyframes(raw.get("keyframes"), KEYFRAME_KEYS["text"]),
    }
    return item


def _track(value: Any, index: int) -> dict:
    raw = value if isinstance(value, dict) else {}
    kind = _text(raw.get("type"), "video", 12)
    if kind not in TRACK_TYPES:
        kind = "video"
    return {
        "id": _id(raw.get("id")),
        "type": kind,
        "name": _text(raw.get("name"), f"{kind[0].upper()}{index + 1}", 40),
        "muted": _bool(raw.get("muted")),
        "solo": _bool(raw.get("solo")),
        "locked": _bool(raw.get("locked")),
        "hidden": _bool(raw.get("hidden")),
        "volume": round(_num(raw.get("volume"), 1.0, 0.0, 2.0), 4),
    }


def default_doc(name: str = "未命名工程") -> dict:
    return {
        "version": VERSION,
        "name": _text(name, "未命名工程", 120) or "未命名工程",
        "canvas": {"width": 1920, "height": 1080, "fps": 30},
        "main": [],
        "overlays": [],
        "audios": [],
        "texts": [],
        "tracks": [
            {"id": "v1", "type": "video", "name": "视频 1", "muted": False, "solo": False,
             "locked": False, "hidden": False, "volume": 1.0},
            {"id": "a1", "type": "audio", "name": "音频 1", "muted": False, "solo": False,
             "locked": False, "hidden": False, "volume": 1.0},
            {"id": "t1", "type": "text", "name": "字幕 1", "muted": False, "solo": False,
             "locked": False, "hidden": False, "volume": 1.0},
        ],
        "grade": {"brightness": 0.0, "contrast": 1.0, "saturation": 1.0, "hue": 0.0,
                  "temperature": 0.0, "vignette": 0.0},
        "masterVolume": 1.0,
        "markers": [],
    }


def sanitize_doc(value: Any, fallback_name: str = "未命名工程") -> dict:
    raw = value if isinstance(value, dict) else {}
    doc = default_doc(_text(raw.get("name"), "", 120) or fallback_name)
    canvas = raw.get("canvas") if isinstance(raw.get("canvas"), dict) else {}
    width = _int(canvas.get("width"), 1920, 320, 8192)
    height = _int(canvas.get("height"), 1080, 320, 8192)
    doc["canvas"] = {
        "width": width // 2 * 2,
        "height": height // 2 * 2,
        "fps": _int(canvas.get("fps"), 30, 1, 120),
    }
    main = raw.get("main") if isinstance(raw.get("main"), list) else []
    doc["main"] = [c for c in (_clip(item) for item in main[:300]) if c["src"]]
    overlays = raw.get("overlays") if isinstance(raw.get("overlays"), list) else []
    doc["overlays"] = [o for o in (_overlay(item) for item in overlays[:100]) if o["src"]]
    audios = raw.get("audios") if isinstance(raw.get("audios"), list) else []
    doc["audios"] = [a for a in (_audio(item) for item in audios[:50]) if a["src"]]
    texts = raw.get("texts") if isinstance(raw.get("texts"), list) else []
    doc["texts"] = [_text_item(item) for item in texts[:100]]
    tracks = raw.get("tracks") if isinstance(raw.get("tracks"), list) else []
    clean_tracks = [_track(item, index) for index, item in enumerate(tracks[:36])]
    if not any(track["type"] == "video" for track in clean_tracks):
        clean_tracks.append({"id": "v1", "type": "video", "name": "视频 1", "muted": False,
                             "solo": False, "locked": False, "hidden": False, "volume": 1.0})
    if not any(track["type"] == "audio" for track in clean_tracks):
        clean_tracks.append({"id": "a1", "type": "audio", "name": "音频 1", "muted": False,
                             "solo": False, "locked": False, "hidden": False, "volume": 1.0})
    if not any(track["type"] == "text" for track in clean_tracks):
        clean_tracks.append({"id": "t1", "type": "text", "name": "字幕 1", "muted": False,
                             "solo": False, "locked": False, "hidden": False, "volume": 1.0})
    doc["tracks"] = clean_tracks
    video_ids = [track["id"] for track in clean_tracks if track["type"] == "video"]
    audio_ids = [track["id"] for track in clean_tracks if track["type"] == "audio"]
    text_ids = [track["id"] for track in clean_tracks if track["type"] == "text"]
    for item in doc["overlays"]:
        if item["trackId"] not in video_ids:
            item["trackId"] = video_ids[0]
    for item in doc["audios"]:
        if item["trackId"] not in audio_ids:
            item["trackId"] = audio_ids[0]
    for item in doc["texts"]:
        if item["trackId"] not in text_ids:
            item["trackId"] = text_ids[0]
    grade = raw.get("grade") if isinstance(raw.get("grade"), dict) else {}
    doc["grade"] = {
        "brightness": round(_num(grade.get("brightness"), 0.0, -1.0, 1.0), 4),
        "contrast": round(_num(grade.get("contrast"), 1.0, 0.0, 3.0), 4),
        "saturation": round(_num(grade.get("saturation"), 1.0, 0.0, 3.0), 4),
        "hue": round(_num(grade.get("hue"), 0.0, -180.0, 180.0), 4),
        "temperature": round(_num(grade.get("temperature"), 0.0, -1.0, 1.0), 4),
        "vignette": round(_num(grade.get("vignette"), 0.0, 0.0, 1.0), 4),
    }
    doc["masterVolume"] = round(_num(raw.get("masterVolume"), 1.0, 0.0, 2.0), 4)
    doc["markers"] = _markers(raw.get("markers"), project_duration(doc))
    doc["version"] = VERSION
    return doc


# --------------------------------------------------------------- durations

def clip_duration(clip: dict) -> float:
    start = float(clip.get("in") or 0.0)
    end = float(clip.get("out") or 0.0)
    speed = float(clip.get("speed") or 1.0)
    return max(0.0, (end - start) / max(0.05, speed))


def main_offsets(doc: dict) -> list[float]:
    """主轨每段的开始时间，转场处与上一段重叠。"""
    offsets: list[float] = []
    cursor = 0.0
    for index, clip in enumerate(doc.get("main") or []):
        duration = clip_duration(clip)
        if index == 0:
            offsets.append(0.0)
            cursor = duration
            continue
        overlap = 0.0
        transition = clip.get("transition")
        if transition:
            overlap = float(transition.get("duration") or 0.0)
            previous = clip_duration(doc["main"][index - 1])
            overlap = min(overlap, max(0.0, min(previous, duration) - 0.05))
        start = max(0.0, cursor - overlap)
        offsets.append(start)
        cursor = start + duration
    return offsets


def main_duration(doc: dict) -> float:
    clips = doc.get("main") or []
    if not clips:
        return 0.0
    offsets = main_offsets(doc)
    return offsets[-1] + clip_duration(clips[-1])


def project_duration(doc: dict) -> float:
    """成片时长由主轨决定；叠加/字幕/音轨超出部分会被裁掉。"""
    return round(main_duration(doc), 3)


# ---------------------------------------------------------------- export

def export_options(value: Any, doc: dict) -> dict:
    """把前端导出参数清洗成渲染层能直接使用的结构。"""
    from . import config, formats, media

    raw = value if isinstance(value, dict) else {}
    fmt = formats.get(str(raw.get("format") or formats.DEFAULT_FORMAT))
    default_name = f"{doc.get('name') or '剪辑'}_{__import__('datetime').datetime.now().strftime('%Y%m%d_%H%M%S')}"
    filename = media.sanitize_filename(_text(raw.get("filename"), "", 160) or default_name, "剪辑")
    suffix = Path(filename).suffix.lower()
    if suffix in formats.EXTENSIONS or suffix in config.MEDIA_EXT:
        filename = Path(filename).stem
    filename = media.sanitize_filename(f"{filename}{fmt['ext']}", f"剪辑{fmt['ext']}")
    subdir = _text(raw.get("subdir"), "", 160).replace("\\", "/").strip("/")
    parts = [part for part in subdir.split("/") if part and part not in {".", ".."}]
    subdir = "/".join(parts)[:160]
    quality = _text(raw.get("quality"), "balanced", 16)
    if quality not in {"draft", "balanced", "high", "lossless"}:
        quality = "balanced"
    preset = _text(raw.get("preset"), "medium", 20)
    if preset not in {"ultrafast", "veryfast", "faster", "fast", "medium", "slow", "slower"}:
        preset = "medium"
    crf_default = {"draft": 28, "balanced": 23, "high": 18, "lossless": 0}.get(quality, 23)
    crf = _int(raw.get("crf"), crf_default, 0, 40)
    audio_bitrate = _int(raw.get("audioBitrate"), 192, 64, 320)
    start = _num(raw.get("start"), 0.0, 0.0, 24 * 3600)
    end = _num(raw.get("end"), 0.0, 0.0, 24 * 3600)
    if 0 < end <= start:
        end = 0.0
    return {
        "format": fmt["key"],
        "ext": fmt["ext"],
        "filename": filename,
        "subdir": subdir,
        "overwrite": _bool(raw.get("overwrite")),
        "crf": crf,
        "preset": preset,
        "quality": quality,
        "audioBitrate": f"{audio_bitrate}k",
        "start": round(start, 3),
        "end": round(end, 3),
    }
