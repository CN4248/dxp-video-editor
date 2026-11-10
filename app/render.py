"""FFmpeg 渲染：关键帧切片 → 分段编码 → 转场拼接 → 叠加/字幕/混音。

v2 相比 v1 的变化：
- 片段支持效果栈与参数关键帧：按关键帧时间把片段切成若干“参数恒定”的子段，
  每段单独编码后再拼接，视觉上等价于连续变化的参数。
- 主轨片段之间支持 xfade 转场（视频 + 音频交叉淡化），工程总时长会扣除重叠。
- 叠加层支持效果、蒙版、混合模式与关键帧；字幕支持描边/阴影/底框/透明度；
  音频轨支持效果栈、声像、轨道静音/独奏。
- 导出支持时间范围与章节标记。
"""
from __future__ import annotations

import errno
import json
import os
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import config, effects, formats, media, project


class RenderError(Exception):
    pass


@dataclass
class SegmentPlan:
    index: int
    clip_index: int
    part_index: int
    clip: dict
    duration: float
    path: Path
    has_audio: bool
    src_duration: float | None = None


@dataclass
class RenderPlan:
    doc: dict
    duration: float
    segments: list[SegmentPlan] = field(default_factory=list)
    needs_final: bool = False
    total_main: float = 0.0
    clip_durations: list[float] = field(default_factory=list)
    transitions: list[dict | None] = field(default_factory=list)

    def clip_indexes(self) -> list[list[int]]:
        buckets: list[list[int]] = [[] for _ in self.clip_durations]
        for segment in self.segments:
            buckets[segment.clip_index].append(segment.index)
        return buckets


def _f(value: float) -> str:
    text = f"{float(value):.3f}".rstrip("0").rstrip(".")
    return text if text not in {"", "-0"} else "0"


def atempo_chain(speed: float) -> list[str]:
    filters = []
    remaining = float(speed)
    while remaining > 2.0 + 1e-6:
        filters.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5 - 1e-6:
        filters.append("atempo=0.5")
        remaining /= 0.5
    if abs(remaining - 1.0) > 1e-6:
        filters.append(f"atempo={remaining:.6f}".rstrip("0").rstrip("."))
    return filters


def _rotate_filter(angle: int) -> list[str]:
    angle = int(angle) % 360
    if angle == 0:
        return []
    if angle == 90:
        return ["transpose=1"]
    if angle == 180:
        return ["transpose=2", "transpose=2"]
    if angle == 270:
        return ["transpose=2"]
    return [f"rotate={angle}*PI/180:ow=rotw(iw):oh=roth(ih):c=black"]


def _even(value: float) -> int:
    number = max(2, int(round(value)))
    return number - (number % 2)


def _grade_filters(grade: dict) -> list[str]:
    brightness = float(grade.get("brightness") or 0)
    contrast = float(grade.get("contrast") or 1)
    saturation = float(grade.get("saturation") or 1)
    filters = []
    if abs(brightness) > 1e-6 or abs(contrast - 1) > 1e-6 or abs(saturation - 1) > 1e-6:
        filters.append(f"eq=brightness={brightness:.3f}:contrast={contrast:.3f}:saturation={saturation:.3f}")
    hue = float(grade.get("hue") or 0)
    if abs(hue) > 1e-6:
        filters.append(f"hue=h={hue:.3f}")
    temperature = max(-1.0, min(1.0, float(grade.get("temperature") or 0)))
    if abs(temperature) > 0.01:
        red = round(temperature * 0.32, 4)
        filters.append(
            f"colorbalance=rs={red:.4f}:bs={-red:.4f}:"
            f"rm={red * 0.5:.4f}:bm={-red * 0.5:.4f}:pl=1"
        )
    vignette = max(0.0, min(1.0, float(grade.get("vignette") or 0)))
    if vignette > 0.02:
        angle = 3.141592653589793 / max(2.2, 7.0 - 4.0 * vignette)
        filters.append(f"vignette=angle={angle:.5f}:mode=forward")
    return filters


def _crop_filters(crop: dict, width: int, height: int) -> list[str]:
    left = float(crop.get("left") or 0)
    right = float(crop.get("right") or 0)
    top = float(crop.get("top") or 0)
    bottom = float(crop.get("bottom") or 0)
    if max(left, right, top, bottom) < 0.005:
        return []
    crop_w = max(2, _even(width * (1 - left - right)))
    crop_h = max(2, _even(height * (1 - top - bottom)))
    x = _even(width * left)
    y = _even(height * top)
    return [f"crop={crop_w}:{crop_h}:{x}:{y}", f"scale={width}:{height}"]


def _mask_filters(mask: dict, width: int, height: int) -> list[str]:
    if not mask or not mask.get("enabled"):
        return []
    shape = mask.get("shape") or "rect"
    x = float(mask.get("x") or 0)
    y = float(mask.get("y") or 0)
    w = max(0.01, float(mask.get("w") or 1))
    h = max(0.01, float(mask.get("h") or 1))
    feather = max(0.0, float(mask.get("feather") or 0))
    invert = bool(mask.get("invert"))
    w_expr = "W"
    h_expr = "H"
    if shape == "ellipse":
        cx = f"({w_expr}*{x + w / 2:.6f})"
        cy = f"({h_expr}*{y + h / 2:.6f})"
        rx = f"({w_expr}*{w / 2:.6f})"
        ry = f"({h_expr}*{h / 2:.6f})"
        dist = f"((X-{cx})*(X-{cx})/(({rx})*({rx}))+(Y-{cy})*(Y-{cy})/(({ry})*({ry})))"
        if feather > 0.001:
            band = max(0.001, feather * 2)
            alpha = f"255*clip((1-{dist})/{band:.4f},0,1)"
        else:
            alpha = f"if(lte({dist},1),255,0)"
    else:
        x0 = f"({w_expr}*{x:.6f})"
        x1 = f"({w_expr}*{min(1.0, x + w):.6f})"
        y0 = f"({h_expr}*{y:.6f})"
        y1 = f"({h_expr}*{min(1.0, y + h):.6f})"
        if feather > 0.001:
            band = max(1.0, feather * min(width, height))
            inner = (f"min(min((X-{x0})/{band:.3f},({x1}-X)/{band:.3f}),"
                     f"min((Y-{y0})/{band:.3f},({y1}-Y)/{band:.3f}))")
            alpha = f"255*clip({inner},0,1)"
        else:
            alpha = f"if(between(X,{x0},{x1})*between(Y,{y0},{y1}),255,0)"
    if invert:
        alpha = f"(255-({alpha}))"
    return [
        "format=rgba",
        f"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='{alpha}'",
    ]


def _mosaic_rect(clip: dict, width: int, height: int) -> tuple[int, int, int, int]:
    x = int(round(float(clip.get("mosaicX") or 0.25) * width))
    y = int(round(float(clip.get("mosaicY") or 0.25) * height))
    w = int(round(float(clip.get("mosaicW") or 0.5) * width))
    h = int(round(float(clip.get("mosaicH") or 0.5) * height))
    x = max(0, min(_even(x), width - 2))
    y = max(0, min(_even(y), height - 2))
    w = max(2, min(_even(w), width - x))
    h = max(2, min(_even(h), height - y))
    return x, y, w, h


# --------------------------------------------------------------- segment cmd

def build_segment_cmd(clip: dict, doc: dict, duration: float, out_path: Path,
                      crf: int, preset: str, apply_grade: bool,
                      has_audio: bool) -> list[str]:
    canvas = doc["canvas"]
    width, height = int(canvas["width"]), int(canvas["height"])
    fps = int(canvas["fps"])
    source_span = max(0.05, float(clip["out"]) - float(clip["in"]))
    speed = float(clip.get("speed") or 1)
    clip_dur = max(0.05, float(duration))
    ctx = {"width": width, "height": height, "fps": fps, "duration": clip_dur,
           "sampleRate": 48000}

    vf: list[str] = ["setpts=PTS-STARTPTS"]
    if abs(speed - 1) > 1e-6:
        vf.append(f"setpts=PTS/{speed:.6f}")
    vf += _rotate_filter(int(clip.get("rotate") or 0))
    if clip.get("flipH"):
        vf.append("hflip")
    if clip.get("flipV"):
        vf.append("vflip")

    scale = float(clip.get("scale") or 1)
    box_w = _even(width * scale)
    box_h = _even(height * scale)
    if clip.get("fit") == "cover":
        vf.append(f"scale={box_w}:{box_h}:force_original_aspect_ratio=increase")
        vf.append(f"crop={box_w}:{box_h}")
    elif clip.get("fit") == "stretch":
        vf.append(f"scale={box_w}:{box_h}")
    else:
        vf.append(f"scale={box_w}:{box_h}:force_original_aspect_ratio=decrease")
    if box_w > width or box_h > height:
        vf.append(f"pad={box_w}:{box_h}:(ow-iw)/2:(oh-ih)/2:color=black")
        vf.append(f"crop={width}:{height}:(iw-{width})/2:(ih-{height})/2")
    else:
        vf.append(f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black")
    vf.append(f"fps={fps}")
    vf.append("setsar=1")
    vf.append("format=yuv420p")
    vf += _crop_filters(clip.get("crop") or {}, width, height)

    effect_filters, needs_alpha = effects.video_filters(clip.get("effects") or [], 0.0, ctx)
    vf += effect_filters
    mask_filters = _mask_filters(clip.get("mask") or {}, width, height)
    if mask_filters:
        vf += mask_filters
        needs_alpha = True
    opacity = max(0.0, min(1.0, float(clip.get("opacity") if clip.get("opacity") is not None else 1)))
    if opacity < 0.999:
        vf.append(f"colorchannelmixer=aa={opacity:.3f}")
        needs_alpha = True

    fade_in = min(float(clip.get("_fadeIn", clip.get("fadeIn") or 0) or 0), clip_dur / 2)
    fade_out = min(float(clip.get("_fadeOut", clip.get("fadeOut") or 0) or 0), clip_dur / 2)

    inputs = ["-ss", _f(float(clip["in"])), "-t", _f(source_span),
              "-i", str(config.INPUT_ROOT / clip["src"])]
    index = 1
    bg_index = None
    if needs_alpha:
        bg_index = index
        inputs += ["-f", "lavfi", "-t", _f(clip_dur),
                   "-i", f"color=c=black:s={width}x{height}:r={fps}"]
        index += 1
    if has_audio:
        audio_index = 0
    else:
        inputs += ["-f", "lavfi", "-t", _f(clip_dur),
                   "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
        audio_index = index

    parts: list[str] = [f"[0:v]{','.join(vf)}[vfx]"]
    current = "vfx"
    if needs_alpha and bg_index is not None:
        parts.append(f"[{bg_index}:v]format=rgba[bgfx]")
        parts.append(f"[bgfx][{current}]overlay=shortest=1:format=auto[vcomp]")
        current = "vcomp"
        parts.append(f"[{current}]format=yuv420p[vnorm]")
        current = "vnorm"

    if apply_grade:
        grade = _grade_filters(doc.get("grade") or {})
        if grade:
            parts.append(f"[{current}]{','.join(grade)}[vgrade]")
            current = "vgrade"

    if clip.get("mosaic"):
        x, y, w, h = _mosaic_rect(clip, width, height)
        block = max(2, min(64, int(clip.get("mosaicBlock") or 16)))
        mode = clip.get("mosaicMode") or "pixel"
        if mode == "black":
            parts.append(f"[{current}]drawbox=x={x}:y={y}:w={w}:h={h}:"
                         f"color=black@1:t=fill[vmos]")
            current = "vmos"
        else:
            parts.append(f"[{current}]split=2[vbase][vcrop]")
            if mode == "blur":
                sigma = max(1.0, min(48.0, block / 2.0))
                parts.append(f"[vcrop]crop={w}:{h}:{x}:{y},gblur=sigma={sigma:.2f}[vmos2]")
            else:
                small_w = max(1, round(w / block))
                small_h = max(1, round(h / block))
                parts.append(f"[vcrop]crop={w}:{h}:{x}:{y},"
                             f"scale={small_w}:{small_h}:flags=neighbor,"
                             f"scale={w}:{h}:flags=neighbor[vmos2]")
            parts.append(f"[vbase][vmos2]overlay={x}:{y}[vmos]")
            current = "vmos"

    fade_filters: list[str] = []
    if fade_in > 0.01:
        fade_filters.append(f"fade=t=in:st=0:d={fade_in:.3f}")
    if fade_out > 0.01:
        fade_filters.append(f"fade=t=out:st={max(0.0, clip_dur - fade_out):.3f}:d={fade_out:.3f}")
    if fade_filters:
        parts.append(f"[{current}]{','.join(fade_filters)}[vfade]")
        current = "vfade"
    parts.append(f"[{current}]null[vout]")

    af: list[str] = ["asetpts=PTS-STARTPTS"]
    af += atempo_chain(speed)
    volume = 0.0 if (clip.get("muted") or clip.get("audioDetached")) else float(clip.get("volume") or 1)
    if abs(volume - 1) > 1e-6:
        af.append(f"volume={volume:.3f}")
    af += effects.audio_filters(clip.get("effects") or [], 0.0, ctx)
    if fade_in > 0.01:
        af.append(f"afade=t=in:st=0:d={fade_in:.3f}")
    if fade_out > 0.01:
        af.append(f"afade=t=out:st={max(0.0, clip_dur - fade_out):.3f}:d={fade_out:.3f}")
    af += ["aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo"]
    if not has_audio:
        af = ["atrim=0:" + _f(clip_dur), "asetpts=PTS-STARTPTS",
              f"volume={volume:.3f}"] + effects.audio_filters(clip.get("effects") or [], 0.0, ctx) + [
              "aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo"]

    parts.append(f"[{audio_index}:a]{','.join(af)}[aout]")
    filter_complex = ";".join(parts)
    cmd = [config.FFMPEG, "-hide_banner", "-loglevel", "warning", "-nostdin", "-y"]
    cmd += inputs
    cmd += [
        "-filter_complex", filter_complex,
        "-map", "[vout]", "-map", "[aout]",
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-pix_fmt", "yuv420p", "-r", str(fps),
        "-colorspace", "bt470bg", "-color_primaries", "bt470bg",
        "-color_trc", "bt709", "-color_range", "tv",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-t", _f(clip_dur), "-movflags", "+faststart",
        "-max_muxing_queue_size", "4096",
        str(out_path),
    ]
    return cmd


# --------------------------------------------------------------- assembly

def build_concat_cmd(segments: list[Path], work_dir: Path, out_path: Path) -> list[str]:
    list_file = work_dir / "concat.txt"
    lines = []
    for seg in segments:
        escaped = str(seg).replace("'", "'\\''")
        lines.append(f"file '{escaped}'")
    list_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return [
        config.FFMPEG, "-hide_banner", "-loglevel", "warning", "-nostdin", "-y",
        "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-c", "copy", "-movflags", "+faststart", "-max_muxing_queue_size", "4096",
        str(out_path),
    ]


def build_xfade_cmd(paths: list[Path], transitions: list[dict | None],
                    durations: list[float], out_path: Path, fps: int = 30) -> list[str]:
    if len(paths) < 2:
        raise RenderError("转场至少需要两个片段")
    cmd = [config.FFMPEG, "-hide_banner", "-loglevel", "warning", "-nostdin", "-y"]
    for path in paths:
        cmd += ["-i", str(path)]
    parts: list[str] = []
    cursor = float(durations[0])
    last_v = "0:v"
    last_a = "0:a"
    for index in range(1, len(paths)):
        transition = transitions[index] or {"type": "fade", "duration": 0.5}
        kind = transition.get("type") or "fade"
        length = max(0.1, float(transition.get("duration") or 0.5))
        length = min(length, max(0.1, min(durations[index - 1], durations[index]) - 0.05))
        offset = max(0.0, cursor - length)
        out_v = f"vx{index}"
        out_a = f"ax{index}"
        parts.append(
            f"[{last_v}][{index}:v]xfade=transition={kind}:duration={length:.3f}:"
            f"offset={offset:.3f}[{out_v}]"
        )
        parts.append(f"[{last_a}][{index}:a]acrossfade=d={length:.3f}:c1=tri:c2=tri[{out_a}]")
        last_v, last_a = out_v, out_a
        cursor = offset + float(durations[index])
    cmd += [
        "-filter_complex", ";".join(parts),
        "-map", f"[{last_v}]", "-map", f"[{last_a}]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
        "-pix_fmt", "yuv420p", "-r", str(int(fps)),
        "-colorspace", "bt470bg", "-color_primaries", "bt470bg",
        "-color_trc", "bt709", "-color_range", "tv",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", "-max_muxing_queue_size", "4096",
        str(out_path),
    ]
    return cmd


# ------------------------------------------------------------ final compose

def _ordered_by_track(items: list[dict], track_type: str, doc: dict) -> list[dict]:
    track_ids = [track["id"] for track in doc.get("tracks") or [] if track.get("type") == track_type]
    if not track_ids:
        return list(items)
    indexed = list(enumerate(items))

    def key(pair):
        index, item = pair
        try:
            track_index = track_ids.index(item.get("trackId"))
        except ValueError:
            track_index = 0
        return (-track_index, index)

    return [item for _, item in sorted(indexed, key=key)]


def _track_maps(doc: dict) -> tuple[dict, dict]:
    tracks = {track["id"]: track for track in doc.get("tracks") or []}
    audio_solo = any(track.get("solo") and track.get("type") == "audio" for track in tracks.values())
    return tracks, audio_solo


def _visible(item: dict, tracks: dict, kind: str) -> bool:
    track = tracks.get(item.get("trackId")) or {}
    if kind == "video" and (track.get("hidden") or track.get("muted")):
        return False
    if kind == "text" and track.get("hidden"):
        return False
    return True


def _slice_bounds(item: dict, duration: float) -> list[tuple[float, float]]:
    points = {0.0, round(duration, 3)}
    for t in effects.keyframe_times(item):
        if 0.05 < t < duration - 0.05:
            points.add(round(t, 3))
    ordered = sorted(points)
    if len(ordered) > 49:
        ordered = [round(duration * index / 48, 3) for index in range(49)]
    return list(zip(ordered, ordered[1:]))


def _sample_item(item: dict, t: float, kind: str) -> dict:
    sampled = json.loads(json.dumps(item, ensure_ascii=False))
    frames = item.get("keyframes") or {}
    for key, value in frames.items():
        picked = effects.sample_keyframes(value, t)
        if picked is None:
            continue
        if key in {"size"}:
            picked = int(round(picked))
        if key == "rotate":
            picked = int(round(picked))
        if key in {"x", "y", "scale", "opacity", "volume", "pan", "size", "rotate"}:
            sampled[key] = picked
    chosen = []
    for effect in item.get("effects") or []:
        concrete = effects.sample_effect(effect, t)
        concrete["keyframes"] = {}
        chosen.append(concrete)
    sampled["effects"] = chosen
    return sampled


def _write_text_files(doc: dict, work_dir: Path) -> dict[str, Path]:
    mapping = {}
    for item in doc.get("texts") or []:
        path = work_dir / f"text_{item['id']}.txt"
        path.write_text(item["text"], encoding="utf-8")
        mapping[item["id"]] = path
    return mapping


def _write_chapters(doc: dict, work_dir: Path, offset: float, duration: float) -> Path | None:
    markers = [m for m in doc.get("markers") or [] if offset <= float(m["time"]) < offset + duration]
    if not markers:
        return None
    path = work_dir / "chapters.ffmeta"
    lines = [";FFMETADATA1"]
    for index, marker in enumerate(markers):
        start = int(round((float(marker["time"]) - offset) * 1000))
        if index + 1 < len(markers):
            end = int(round((float(markers[index + 1]["time"]) - offset) * 1000))
        else:
            end = int(round(duration * 1000))
        end = max(start + 200, end)
        lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={start}", f"END={end}",
                  f"title={marker['label']}"]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def build_final_cmd(doc: dict, base_path: Path, work_dir: Path, out_path: Path,
                    export: dict) -> list[str]:
    fmt = formats.get(export.get("format"))
    kind = fmt["kind"]
    want_video = kind in {"video", "gif"}
    want_audio = kind != "gif"
    width, height = int(doc["canvas"]["width"]), int(doc["canvas"]["height"])
    fps = int(doc["canvas"]["fps"])
    full_duration = project.project_duration(doc)
    if full_duration <= 0:
        raise RenderError("主轨为空，无法渲染")
    start = max(0.0, float(export.get("start") or 0))
    end = float(export.get("end") or 0)
    if end <= start:
        end = full_duration
    end = min(end, full_duration)
    duration = max(0.05, end - start)
    tracks, audio_solo = _track_maps(doc)
    ctx = {"width": width, "height": height, "fps": fps, "duration": duration,
           "sampleRate": 48000}

    cmd = [config.FFMPEG, "-hide_banner", "-loglevel", "warning", "-nostdin", "-y"]
    if start > 0.001:
        cmd += ["-ss", _f(start), "-t", _f(duration)]
    cmd += ["-i", str(base_path)]
    index = 1

    overlay_inputs: list[tuple[int, dict, float, float, float, float]] = []
    if want_video:
        for item in _ordered_by_track(doc.get("overlays") or [], "video", doc):
            if not _visible(item, tracks, "video"):
                continue
            item_duration = max(0.02, float(item["duration"]))
            for part_start, part_end in _slice_bounds(item, item_duration):
                abs_start = float(item["start"]) + part_start
                abs_end = float(item["start"]) + part_end
                local_start = max(abs_start, start)
                local_end = min(abs_end, end)
                if local_end - local_start < 0.03:
                    continue
                try:
                    src = media.resolve_source(item["src"])
                except media.BadPath as exc:
                    raise RenderError(f"叠加素材不存在：{item['src']}") from exc
                visible = local_end - local_start
                seek = max(0.0, local_start - abs_start)
                if item["kind"] == "image":
                    # 单帧输入 + overlay 的 repeatlast 足以覆盖可见区间。
                    # 用 -loop 1 再 EOF 会触发 filter graph 重建并让最终编码卡死（实测停在 83%）。
                    cmd += ["-framerate", str(fps), "-i", str(src)]
                else:
                    cmd += ["-ss", _f(float(item["in"]) + seek), "-t", _f(visible), "-i", str(src)]
                overlay_inputs.append((index, item, part_start, part_end, local_start, local_end))
                index += 1

    audio_inputs: list[tuple[int, dict, float, float, float, float]] = []
    if want_audio:
        for item in doc.get("audios") or []:
            track = tracks.get(item.get("trackId")) or {}
            if track.get("muted"):
                continue
            if audio_solo and not track.get("solo"):
                continue
            if not probe_has_audio(item["src"]):
                raise RenderError(f"音频素材没有音轨：{item['src']}")
            item_duration = max(0.02, float(item["duration"]))
            for part_start, part_end in _slice_bounds(item, item_duration):
                abs_start = float(item["start"]) + part_start
                abs_end = float(item["start"]) + part_end
                local_start = max(abs_start, start)
                local_end = min(abs_end, end)
                if local_end - local_start < 0.03:
                    continue
                try:
                    src = media.resolve_source(item["src"])
                except media.BadPath as exc:
                    raise RenderError(f"音频素材不存在：{item['src']}") from exc
                speed = float(item.get("speed") or 1)
                visible = local_end - local_start
                seek = max(0.0, local_start - abs_start)
                source_span = visible * speed
                if item.get("loop"):
                    cmd += ["-stream_loop", "-1", "-ss", _f(float(item["in"]) + seek * speed),
                            "-t", _f(source_span), "-i", str(src)]
                else:
                    cmd += ["-ss", _f(float(item["in"]) + seek * speed), "-t", _f(source_span),
                            "-i", str(src)]
                audio_inputs.append((index, item, part_start, part_end, local_start, local_end))
                index += 1

    chapters = None
    chapter_index = None
    if want_video and doc.get("markers"):
        chapters = _write_chapters(doc, work_dir, start, duration)
        if chapters:
            chapter_index = index
            cmd += ["-i", str(chapters)]
            index += 1

    text_files = _write_text_files(doc, work_dir) if want_video else {}

    chain: list[str] = []
    last_video = None
    if want_video:
        base_filters = _grade_filters(doc.get("grade") or {})
        # 不要在这里 setpts：叠加/字幕阶段可能因色彩元数据变化重建 filter graph，
        # setpts(STARTPTS) 会随重建把时间戳重置为 0，导致输出提前结束（实测 10s 截成 6.9s）。
        base_filters += ["format=yuv420p"]
        chain.append(f"[0:v]{','.join(base_filters)}[vbase]")
        last_video = "vbase"
        font = config.find_font()

        for order, (src_index, item, part_start, part_end, local_start, local_end) in enumerate(overlay_inputs):
            label = f"ov{order}"
            t = (part_start + part_end) / 2
            concrete = _sample_item(item, t, "overlay")
            blend = concrete.get("blend") or "normal"
            full_frame = blend != "normal" and abs(float(concrete.get("x", 0.5)) - 0.5) < 1e-3 \
                and abs(float(concrete.get("y", 0.5)) - 0.5) < 1e-3 \
                and abs(float(concrete.get("rotate") or 0)) < 0.01
            of: list[str] = []
            if full_frame:
                of.append(f"scale={width}:{height}:force_original_aspect_ratio=increase")
                of.append(f"crop={width}:{height}")
            else:
                target_w = _even(width * float(concrete.get("scale") or 1))
                of.append(f"scale={target_w}:-2")
            of.append("format=rgba")
            angle = float(concrete.get("rotate") or 0)
            if abs(angle) > 0.01:
                of.append(f"rotate={angle:.3f}*PI/180:c=none:ow=rotw(iw):oh=roth(ih)")
            of += _crop_filters(concrete.get("crop") or {}, width, height)
            fx, _alpha = effects.video_filters(concrete.get("effects") or [], 0.0, ctx)
            of += fx
            of += _mask_filters(concrete.get("mask") or {}, width, height)
            opacity = max(0.0, min(1.0, float(concrete.get("opacity") or 1)))
            if opacity < 0.999:
                of.append(f"colorchannelmixer=aa={opacity:.3f}")
            of.append(f"setpts=PTS-STARTPTS+{_f(local_start - start)}/TB")
            chain.append(f"[{src_index}:v]{','.join(of)}[{label}]")
            nxt = f"v{order + 1}"
            if full_frame:
                chain.append(f"[{last_video}]format=gbrp[gb{order}]")
                chain.append(f"[{label}]format=gbrp[go{order}]")
                chain.append(f"[gb{order}][go{order}]blend=all_mode={blend}:all_opacity=1[bl{order}]")
                chain.append(f"[bl{order}]format=yuv420p[{nxt}]")
            else:
                fx_x = float(concrete.get("x", 0.5))
                fx_y = float(concrete.get("y", 0.5))
                # 图片只有一帧，必须 repeat 才能撑满可见区间；视频结束则透传主画面。
                eof = "repeat:repeatlast=1" if item["kind"] == "image" else "pass"
                chain.append(
                    f"[{last_video}][{label}]overlay=x='{fx_x:.4f}*main_w-overlay_w/2':"
                    f"y='{fx_y:.4f}*main_h-overlay_h/2':"
                    f"enable='between(t,{_f(local_start - start)},{_f(local_end - start)})':"
                    f"eof_action={eof}:shortest=0[{nxt}]"
                )
            last_video = nxt

        for order, item in enumerate(_ordered_by_track(doc.get("texts") or [], "text", doc)):
            if not _visible(item, tracks, "text") or item["id"] not in text_files:
                continue
            if not font:
                raise RenderError("找不到可用的字体文件，无法渲染字幕")
            item_duration = max(0.02, float(item["duration"]))
            for part_index, (part_start, part_end) in enumerate(_slice_bounds(item, item_duration)):
                abs_start = float(item["start"]) + part_start
                abs_end = float(item["start"]) + part_end
                local_start = max(abs_start, start)
                local_end = min(abs_end, end)
                if local_end - local_start < 0.03:
                    continue
                t = (part_start + part_end) / 2
                concrete = _sample_item(item, t, "text")
                color = str(concrete.get("color") or "#ffffff").lstrip("#")
                alpha = max(0.0, min(1.0, float(concrete.get("opacity") or 1)))
                df = [
                    f"fontfile='{font}'",
                    f"textfile='{text_files[item['id']]}'",
                    f"fontsize={int(concrete.get('size') or 64)}",
                    f"fontcolor=0x{color}@{alpha:.3f}" if alpha < 0.999 else f"fontcolor=0x{color}",
                    "borderw=" + str(int(concrete.get("outline") if concrete.get("outline") is not None else 3)),
                    "bordercolor=black@0.75",
                    f"x=(w*{float(concrete.get('x', 0.5)):.4f})-(text_w/2)",
                    f"y=(h*{float(concrete.get('y', 0.8)):.4f})-(text_h/2)",
                    f"enable='between(t,{_f(local_start - start)},{_f(local_end - start)})'",
                ]
                shadow = int(concrete.get("shadow") or 0)
                if shadow > 0:
                    df += ["shadowcolor=black@0.65", f"shadowx={shadow}", f"shadowy={shadow}"]
                if concrete.get("bgEnabled") and concrete.get("bg"):
                    bg = str(concrete["bg"]).lstrip("#")
                    bg_alpha = max(0.0, min(1.0, float(concrete.get("bgAlpha") or 0.55)))
                    df += ["box=1", f"boxcolor=0x{bg}@{bg_alpha:.3f}", "boxborderw=18"]
                nxt = f"vt{order}_{part_index}"
                chain.append(f"[{last_video}]drawtext={':'.join(df)}[{nxt}]")
                last_video = nxt
        chain.append(f"[{last_video}]format=yuv420p[vout]")

    if want_audio:
        master = float(doc.get("masterVolume") or 1)
        chain.append(f"[0:a]asetpts=PTS-STARTPTS,volume={master:.3f},"
                     f"aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a0]")
        mix_labels = ["a0"]
        for order, (src_index, item, part_start, part_end, local_start, local_end) in enumerate(audio_inputs):
            label = f"a{order + 1}"
            t = (part_start + part_end) / 2
            concrete = _sample_item(item, t, "audio")
            speed = float(concrete.get("speed") or 1)
            track = tracks.get(item.get("trackId")) or {}
            track_volume = float(track.get("volume") if track.get("volume") is not None else 1)
            volume = 0.0 if concrete.get("muted") else float(concrete.get("volume") or 1) * track_volume
            visible = local_end - local_start
            ads = ["asetpts=PTS-STARTPTS"]
            ads += atempo_chain(speed)
            # 这里不能用 atrim 截断：ffmpeg 7.1 下 atrim + overlay + 最终编码会在
            # 截断点附近死锁（实测 10s 工程停在 7.0s、83%）。改用时间窗音量门静音尾部。
            ads += [f"volume={volume:.3f}"]
            ads += effects.audio_filters(concrete.get("effects") or [], 0.0, ctx)
            pan = float(concrete.get("pan") or 0)
            if abs(pan) > 0.01:
                left = 1.0 - max(0.0, pan)
                right = 1.0 + min(0.0, pan)
                ads.append(f"pan=stereo|c0={left:.3f}*c0|c1={right:.3f}*c1")
            item_duration = max(0.02, float(concrete.get("duration") or 1))
            abs_start = float(item["start"]) + part_start
            abs_end = float(item["start"]) + part_end
            played = max(0.0, local_start - abs_start)
            fade_in = min(float(concrete.get("fadeIn") or 0), item_duration / 2)
            fade_out = min(float(concrete.get("fadeOut") or 0), item_duration / 2)
            if fade_in > 0.01 and played <= 0.01:
                ads.append(f"afade=t=in:st=0:d={fade_in:.3f}")
            if fade_out > 0.01 and local_end >= abs_end - 0.02:
                start_at = max(0.0, visible - fade_out)
                ads.append(f"afade=t=out:st={start_at:.3f}:d={fade_out:.3f}")
            delay = max(0.0, local_start - start)
            ads.append(f"adelay={int(delay * 1000)}:all=1")
            ads.append(f"volume=volume='if(between(t,{delay:.3f},{delay + visible:.3f}),1,0)':eval=frame")
            ads += ["aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo"]
            chain.append(f"[{src_index}:a]{','.join(ads)}[{label}]")
            mix_labels.append(label)
        if len(mix_labels) == 1:
            chain.append("[a0]alimiter=limit=0.95[aout]")
        else:
            labels = "".join(f"[{m}]" for m in mix_labels)
            chain.append(
                f"{labels}amix=inputs={len(mix_labels)}:duration=first:dropout_transition=0:normalize=0,"
                "alimiter=limit=0.95[aout]"
            )

    cmd += ["-filter_complex", ";".join(chain)]
    if want_video:
        cmd += ["-map", "[vout]"]
    if want_audio:
        cmd += ["-map", "[aout]"]
    if chapter_index is not None:
        cmd += ["-map_chapters", str(chapter_index), "-map_metadata", str(chapter_index)]
    # ffmetadata 输入会被 mp4 复用器写成 bin_data 轨，显式禁用数据流。
    cmd += ["-dn"]

    if want_video:
        vcodec = fmt["vcodec"]
        if vcodec == "libx264":
            cmd += ["-c:v", "libx264", "-preset", str(export.get("preset", "medium")),
                    "-crf", str(int(export.get("crf", 20))), "-pix_fmt", "yuv420p"]
        elif vcodec == "libvpx-vp9":
            cmd += ["-c:v", "libvpx-vp9", "-crf", str(int(export.get("crf", 20))), "-b:v", "0",
                    "-deadline", "good", "-cpu-used", "2", "-pix_fmt", "yuv420p"]
        elif vcodec == "mpeg4":
            cmd += ["-c:v", "mpeg4", "-q:v", str(_qscale(export.get("crf", 20))), "-pix_fmt", "yuv420p"]
        elif vcodec == "wmv2":
            cmd += ["-c:v", "wmv2", "-q:v", str(_qscale(export.get("crf", 20))), "-pix_fmt", "yuv420p"]
        elif vcodec == "libtheora":
            cmd += ["-c:v", "libtheora", "-q:v", "7", "-pix_fmt", "yuv420p"]
        elif vcodec == "mpeg2video":
            cmd += ["-c:v", "mpeg2video", "-q:v", str(_qscale(export.get("crf", 20))), "-pix_fmt", "yuv420p"]
        elif vcodec == "gif":
            cmd += ["-c:v", "gif", "-loop", "0", "-r", str(min(fps, 12))]
        else:
            raise RenderError(f"未知视频编码器：{vcodec}")

    if want_audio:
        acodec = fmt["acodec"]
        bitrate = f"{int(str(export.get('audioBitrate', '192k')).rstrip('k'))}k"
        cmd += ["-c:a", acodec]
        if acodec in {"aac", "libmp3lame", "libopus", "wmav2", "ac3", "mp2"}:
            cmd += ["-b:a", bitrate]
        elif acodec == "libvorbis":
            cmd += ["-q:a", "5"]
        cmd += ["-ar", "48000", "-ac", "2"]
    if kind == "audio":
        cmd += ["-vn"]
    elif kind == "gif":
        cmd += ["-an"]
    cmd += ["-f", fmt["muxer"]]
    if fmt.get("faststart"):
        cmd += ["-movflags", "+faststart"]
    cmd += ["-t", _f(duration), "-max_muxing_queue_size", "4096", str(out_path)]
    return cmd


def _qscale(crf) -> int:
    try:
        value = int(crf)
    except (TypeError, ValueError):
        value = 20
    return max(2, min(10, round((value - 12) / 3)))


_PROBE_AUDIO: dict[str, bool] = {}


def probe_has_audio(rel: str) -> bool:
    if rel in _PROBE_AUDIO:
        return _PROBE_AUDIO[rel]
    try:
        meta = media.probe_media(media.resolve_source(rel))
    except (OSError, media.BadPath):
        meta = {}
    value = bool(meta.get("hasAudio"))
    _PROBE_AUDIO[rel] = value
    return value


def plan_render(doc: dict, task_id: str) -> RenderPlan:
    if not doc.get("main"):
        raise RenderError("主轨还没有任何片段，请先把视频加入主轨")
    doc = json.loads(json.dumps(doc, ensure_ascii=False))
    for clip in doc["main"]:
        src = config.INPUT_ROOT / clip["src"]
        if not src.is_file():
            continue
        meta = media.probe_media(src)
        src_duration = meta.get("duration")
        if src_duration and float(clip["out"]) > float(src_duration):
            clip["out"] = round(max(float(clip["in"]) + 0.05, float(src_duration) - 0.02), 3)
        clip["duration"] = project.clip_duration(clip)
    duration = project.project_duration(doc)
    if duration <= 0.05:
        raise RenderError("工程时长太短，无法渲染")
    if duration > 12 * 3600:
        raise RenderError("工程时长超过 12 小时，请拆分后再渲染")
    needs_final = bool(doc.get("overlays") or doc.get("audios") or doc.get("texts")
                       or doc.get("markers"))
    work_dir = config.WORK_DIR / task_id
    work_dir.mkdir(parents=True, exist_ok=True)
    segments: list[SegmentPlan] = []
    total_main = 0.0
    durations: list[float] = []
    transitions: list[dict | None] = []
    for clip_index, clip in enumerate(doc["main"]):
        src = config.INPUT_ROOT / clip["src"]
        if not src.is_file():
            raise RenderError(f"源视频不存在：{clip['src']}")
        try:
            meta = media.probe_media(src)
        except OSError:
            meta = {}
        if not meta.get("hasVideo"):
            raise RenderError(f"素材没有视频画面：{clip['src']}")
        clip_duration = project.clip_duration(clip)
        durations.append(clip_duration)
        transitions.append(clip.get("transition") if clip_index > 0 else None)
        total_main += clip_duration
        for part_index, (part_start, part_end) in enumerate(_slice_bounds(clip, clip_duration)):
            sampled = _sample_item(clip, (part_start + part_end) / 2, "main")
            speed = float(clip.get("speed") or 1)
            sampled["in"] = round(float(clip["in"]) + part_start * speed, 3)
            sampled["out"] = round(float(clip["in"]) + part_end * speed, 3)
            sampled["_fadeIn"] = clip.get("fadeIn") if part_start <= 0.001 else 0
            sampled["_fadeOut"] = clip.get("fadeOut") if part_end >= clip_duration - 0.001 else 0
            segments.append(SegmentPlan(
                index=len(segments),
                clip_index=clip_index,
                part_index=part_index,
                clip=sampled,
                duration=part_end - part_start,
                path=work_dir / f"seg_{len(segments):04d}.mp4",
                has_audio=bool(meta.get("hasAudio")),
                src_duration=meta.get("duration"),
            ))
    return RenderPlan(doc=doc, duration=duration, segments=segments,
                      needs_final=needs_final, total_main=total_main,
                      clip_durations=durations, transitions=transitions)


def plan_assembly(plan: RenderPlan, work_dir: Path) -> tuple[list[Path], list[list[str]]]:
    """把每个主轨片段的分段拼接成片段文件，返回片段路径与待执行命令。"""
    grouped: list[list[Path]] = [[] for _ in plan.clip_durations]
    for segment in plan.segments:
        grouped[segment.clip_index].append(segment.path)
    clip_paths: list[Path] = []
    commands: list[list[str]] = []
    for clip_index, parts in enumerate(grouped):
        if len(parts) == 1:
            clip_paths.append(parts[0])
            continue
        target = work_dir / f"clip_{clip_index:04d}.mp4"
        target.unlink(missing_ok=True)
        commands.append(build_concat_cmd(parts, work_dir, target))
        clip_paths.append(target)
    return clip_paths, commands


def output_target(export: dict) -> Path:
    directory = config.OUTPUT_ROOT
    if export.get("subdir"):
        directory = directory / export["subdir"]
        target = directory.resolve()
        if config.OUTPUT_ROOT.resolve() not in target.parents and target != config.OUTPUT_ROOT.resolve():
            raise RenderError("导出子目录越界")
    directory.mkdir(parents=True, exist_ok=True)
    fmt = formats.get(export.get("format"))
    filename = media.sanitize_filename(export.get("filename") or f"剪辑{fmt['ext']}", f"剪辑{fmt['ext']}")
    if not filename.lower().endswith(fmt["ext"].lower()):
        filename = f"{os.path.splitext(filename)[0]}{fmt['ext']}"
    if export.get("overwrite"):
        return directory / filename
    return media.unique_path(directory, filename)


def _replace_across_devices(source: Path, target: Path) -> None:
    temp = target.parent / f".{target.name}.part-{os.getpid()}-{time.time_ns()}"
    try:
        shutil.copyfile(source, temp)
        os.replace(temp, target)
        source.unlink(missing_ok=True)
    finally:
        temp.unlink(missing_ok=True)


def finalize_output(temp_path: Path, export: dict) -> Path:
    target = output_target(export)
    target.parent.mkdir(parents=True, exist_ok=True)
    if export.get("overwrite"):
        try:
            os.replace(temp_path, target)
        except OSError as exc:
            if exc.errno != errno.EXDEV:
                raise
            _replace_across_devices(temp_path, target)
        return target
    while True:
        if not target.exists():
            try:
                os.replace(temp_path, target)
            except OSError as exc:
                if exc.errno != errno.EXDEV:
                    raise
                _replace_across_devices(temp_path, target)
            return target
        target = media.unique_path(target.parent, target.name)


def cleanup_work(task_id: str) -> None:
    shutil.rmtree(config.WORK_DIR / task_id, ignore_errors=True)
