"""媒体库：目录浏览、ffprobe 探测、缩略图、路径安全。"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import config, db

THUMB_LOCK = threading.Semaphore(2)
_THUMB_GUARD = threading.Lock()


class BadPath(Exception):
    pass


def _within(root: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def resolve_input(rel: str, must_exist: bool = True) -> Path:
    rel = (rel or "").replace("\\", "/").strip()
    if rel.startswith("/") or rel.startswith("~"):
        raise BadPath("路径必须是相对于 /input 的相对路径")
    if any(part == ".." for part in rel.split("/")):
        raise BadPath("路径不能包含 ..")
    target = (config.INPUT_ROOT / rel).resolve()
    if not _within(config.INPUT_ROOT, target):
        raise BadPath("路径越界")
    if must_exist and not target.exists():
        raise BadPath("文件或目录不存在")
    return target


def resolve_output(rel: str, must_exist: bool = True) -> Path:
    rel = (rel or "").replace("\\", "/").strip()
    if rel.startswith("/") or rel.startswith("~"):
        raise BadPath("路径必须是相对于 /output 的相对路径")
    if any(part == ".." for part in rel.split("/")):
        raise BadPath("路径不能包含 ..")
    target = (config.OUTPUT_ROOT / rel).resolve()
    if not _within(config.OUTPUT_ROOT, target):
        raise BadPath("路径越界")
    if must_exist and not target.exists():
        raise BadPath("文件不存在")
    return target


def rel_of(path: Path) -> str:
    return path.resolve().relative_to(config.INPUT_ROOT.resolve()).as_posix()


def resolve_builtin(rel: str, must_exist: bool = True) -> Path:
    rel = (rel or "").removeprefix("builtin/").replace("\\", "/").strip()
    if rel.startswith("/") or any(part == ".." for part in rel.split("/")):
        raise BadPath("内置素材路径非法")
    target = (config.BUILTIN_ROOT / rel).resolve()
    if not _within(config.BUILTIN_ROOT, target):
        raise BadPath("内置素材路径越界")
    if must_exist and not target.is_file():
        raise BadPath("内置素材不存在")
    return target


def resolve_source(rel: str, must_exist: bool = True) -> Path:
    if (rel or "").startswith("builtin/"):
        return resolve_builtin(rel, must_exist)
    return resolve_input(rel, must_exist)


def source_rel(path: Path) -> str:
    resolved = path.resolve()
    if _within(config.INPUT_ROOT, resolved):
        return resolved.relative_to(config.INPUT_ROOT.resolve()).as_posix()
    if _within(config.BUILTIN_ROOT, resolved):
        return "builtin/" + resolved.relative_to(config.BUILTIN_ROOT.resolve()).as_posix()
    raise BadPath("素材不在素材库内")


def kind_of(name: str) -> str:
    ext = Path(name).suffix.lower()
    if ext in config.VIDEO_EXT:
        return "video"
    if ext in config.IMAGE_EXT:
        return "image"
    if ext in config.AUDIO_EXT:
        return "audio"
    return "other"


def is_media(name: str) -> bool:
    return kind_of(name) != "other"


def sanitize_filename(name: str, fallback: str = "未命名") -> str:
    name = (name or "").replace("\\", "/").split("/")[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()
    name = name.lstrip(".")
    if not name:
        name = fallback
    if len(name) > 160:
        stem, ext = os.path.splitext(name)
        name = stem[:150] + ext[:8]
    return name


def unique_path(directory: Path, filename: str) -> Path:
    """同名时追加 (1)、(2)…… 永不覆盖。"""
    directory.mkdir(parents=True, exist_ok=True)
    candidate = directory / filename
    if not candidate.exists():
        return candidate
    stem, ext = os.path.splitext(filename)
    index = 1
    while True:
        candidate = directory / f"{stem} ({index}){ext}"
        if not candidate.exists():
            return candidate
        index += 1


def ffprobe_json(path: Path) -> dict:
    cmd = [
        config.FFPROBE, "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=40)
    except (subprocess.TimeoutExpired, OSError):
        return {}
    if proc.returncode != 0:
        return {}
    try:
        return json.loads(proc.stdout.decode("utf-8", "replace") or "{}")
    except json.JSONDecodeError:
        return {}


def _fraction(value: str | None) -> float:
    if not value:
        return 0.0
    try:
        if "/" in value:
            num, den = value.split("/", 1)
            return float(num) / float(den) if float(den) else 0.0
        return float(value)
    except (ValueError, ZeroDivisionError):
        return 0.0


def probe_media(path: Path, use_cache: bool = True) -> dict:
    try:
        st = path.stat()
    except OSError:
        return {"kind": kind_of(path.name), "error": "无法读取文件"}
    try:
        rel = source_rel(path)
    except BadPath:
        rel = str(path)
    if use_cache:
        cached = db.get_media_meta(rel, st.st_mtime, st.st_size)
        if cached is not None:
            return cached

    kind = kind_of(path.name)
    meta: dict = {"kind": kind, "size": st.st_size, "duration": None, "width": None,
                  "height": None, "hasAudio": False, "hasVideo": False, "fps": None,
                  "codec": "", "bitrate": None}
    info = ffprobe_json(path)
    if info:
        fmt = info.get("format") or {}
        try:
            meta["duration"] = round(float(fmt.get("duration")), 3)
        except (TypeError, ValueError):
            meta["duration"] = None
        try:
            meta["bitrate"] = int(fmt.get("bit_rate") or 0) or None
        except (TypeError, ValueError):
            meta["bitrate"] = None
        for stream in info.get("streams") or []:
            codec_type = stream.get("codec_type")
            if codec_type == "video" and not meta["hasVideo"]:
                # 跳过封面图流
                if stream.get("disposition", {}).get("attached_pic"):
                    continue
                meta["hasVideo"] = True
                meta["width"] = int(stream.get("width") or 0) or None
                meta["height"] = int(stream.get("height") or 0) or None
                meta["codec"] = stream.get("codec_name") or ""
                meta["fps"] = round(_fraction(stream.get("avg_frame_rate")) or _fraction(stream.get("r_frame_rate")), 3) or None
                rotation = 0
                for side in stream.get("side_data_list") or []:
                    try:
                        rotation = int(float(side.get("rotation") or 0))
                    except (TypeError, ValueError):
                        rotation = 0
                if rotation:
                    meta["rotation"] = rotation
            elif codec_type == "audio":
                meta["hasAudio"] = True
                meta.setdefault("audioCodec", stream.get("codec_name") or "")
        if meta["duration"] is None and meta["hasVideo"]:
            meta["duration"] = None
    else:
        meta["error"] = "ffprobe 无法解析该文件"
    if meta["kind"] == "image" and not meta["duration"]:
        meta["duration"] = None
    db.put_media_meta(rel, st.st_mtime, st.st_size, meta)
    return meta


def list_dir(rel: str, probe_limit: int = 60) -> dict:
    base = resolve_input(rel or "")
    if not base.is_dir():
        raise BadPath("不是目录")
    entries = []
    try:
        children = sorted(base.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except OSError as exc:
        raise BadPath(f"无法读取目录：{exc}") from exc
    for child in children:
        try:
            if child.is_symlink() and not _within(config.INPUT_ROOT, child.resolve()):
                continue
            st = child.stat()
            is_dir = child.is_dir()
            name = child.name
            if not is_dir and not is_media(name):
                continue
            if name.startswith(".") and name != ".keep":
                continue
            item = {
                "name": name,
                "path": child.relative_to(config.INPUT_ROOT).as_posix(),
                "type": "dir" if is_dir else "file",
                "kind": "dir" if is_dir else kind_of(name),
                "size": 0 if is_dir else st.st_size,
                "mtime": st.st_mtime,
                "meta": None,
            }
            entries.append(item)
        except OSError:
            continue

    files = [e for e in entries if e["type"] == "file" and e["kind"] != "other"]
    for item in files[: max(0, probe_limit)]:
        try:
            item["meta"] = probe_media(config.INPUT_ROOT / item["path"])
        except OSError:
            item["meta"] = {"kind": item["kind"], "error": "无法读取"}
    parent = ""
    if rel:
        parent = str(Path(rel).parent.as_posix())
        if parent == ".":
            parent = ""
    return {"cwd": rel, "parent": parent, "entries": entries}


def thumb_path(rel: str) -> Path:
    path = resolve_input(rel)
    st = path.stat()
    key = hashlib.sha1(f"{rel}|{st.st_mtime_ns}|{st.st_size}".encode("utf-8")).hexdigest()[:24]
    return config.THUMB_DIR / f"{key}.jpg"


def make_thumb(rel: str) -> Path | None:
    path = resolve_input(rel)
    kind = kind_of(path.name)
    if kind == "audio":
        return None
    out = thumb_path(rel)
    if out.is_file() and out.stat().st_size > 0:
        return out
    meta = probe_media(path)
    duration = meta.get("duration") or 0
    seek = 0.0
    if kind == "video" and duration:
        seek = min(max(0.5, duration * 0.1), max(0.5, duration - 0.5))
    tmp = out.with_suffix(".part.jpg")
    with THUMB_LOCK:
        if out.is_file() and out.stat().st_size > 0:
            return out
        cmd = [
            config.FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
        ]
        if kind == "video":
            cmd += ["-ss", f"{seek:.3f}"]
        cmd += ["-i", str(path), "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4", str(tmp)]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=60)
        except (subprocess.TimeoutExpired, OSError):
            return None
        if proc.returncode != 0 or not tmp.is_file() or tmp.stat().st_size == 0:
            tmp.unlink(missing_ok=True)
            return None
        os.replace(tmp, out)
    return out


def probe_many(rels: list[str]) -> dict[str, dict]:
    result: dict[str, dict] = {}

    def work(rel: str) -> None:
        try:
            result[rel] = probe_media(resolve_input(rel))
        except (BadPath, OSError):
            result[rel] = {"error": "文件不存在"}

    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(work, rels[:200]))
    return result


def output_entries() -> list[dict]:
    items: list[dict] = []
    if not config.OUTPUT_ROOT.is_dir():
        return items
    for child in sorted(config.OUTPUT_ROOT.rglob("*"), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True):
        if not child.is_file() or child.name.startswith("."):
            continue
        try:
            st = child.stat()
        except OSError:
            continue
        items.append({
            "name": child.name,
            "path": child.relative_to(config.OUTPUT_ROOT).as_posix(),
            "size": st.st_size,
            "mtime": st.st_mtime,
        })
        if len(items) >= 200:
            break
    return items


def content_type(name: str) -> str:
    ext = Path(name).suffix.lower()
    return {
        ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
        ".mkv": "video/x-matroska", ".webm": "video/webm", ".avi": "video/x-msvideo",
        ".flv": "video/x-flv", ".wmv": "video/x-ms-wmv", ".ogv": "video/ogg",
        ".mpg": "video/mpeg", ".mpeg": "video/mpeg", ".ts": "video/mp2t",
        ".vob": "video/mpeg", ".m2ts": "video/mp2t", ".mts": "video/mp2t",
        ".3gp": "video/3gpp",
        ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
        ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg",
        ".opus": "audio/ogg", ".wma": "audio/x-ms-wma", ".aiff": "audio/aiff",
        ".aif": "audio/aiff", ".ac3": "audio/ac3", ".alac": "audio/mp4",
        ".m4b": "audio/mp4", ".oga": "audio/ogg", ".mka": "audio/x-matroska",
        ".caf": "audio/x-caf",
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
        ".avif": "image/avif",
    }.get(ext, "application/octet-stream")


def file_state(rel: str) -> dict:
    path = resolve_input(rel)
    st = path.stat()
    return {"path": rel, "size": st.st_size, "mtime": st.st_mtime, "kind": kind_of(path.name)}


# ------------------------------------------------------------ 音频波形

_WAVE_LOCK = threading.Lock()


def waveform_peaks(path: Path, buckets: int = 900, start: float = 0.0,
                   duration: float = 0.0) -> list[float]:
    """抽取单声道峰值序列（0..1），带磁盘缓存，供时间线画波形。"""
    buckets = max(16, min(2000, int(buckets)))
    cache_dir = config.DATA_DIR / "waveforms"
    cache_dir.mkdir(parents=True, exist_ok=True)
    try:
        stat = path.stat()
        stamp = f"{path.resolve()}:{int(stat.st_mtime)}:{stat.st_size}"
    except OSError:
        return []
    key = hashlib.sha1(
        f"{stamp}:{buckets}:{round(start, 3)}:{round(duration, 3)}".encode("utf-8")).hexdigest()
    cache = cache_dir / f"{key}.json"
    if cache.is_file():
        try:
            return json.loads(cache.read_text("utf-8"))
        except (OSError, ValueError):
            pass
    cmd = [config.FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin"]
    if start > 0:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", str(path)]
    if duration > 0:
        cmd += ["-t", f"{duration:.3f}"]
    cmd += ["-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return []
    if proc.returncode != 0 or not proc.stdout:
        return []
    import array
    samples = array.array("h")
    raw = proc.stdout[: len(proc.stdout) // 2 * 2]
    samples.frombytes(raw)
    if not samples:
        return []
    size = max(1, len(samples) // buckets)
    peaks: list[float] = []
    for index in range(0, len(samples), size):
        chunk = samples[index:index + size]
        peaks.append(round(max(abs(min(chunk)), abs(max(chunk))) / 32768.0, 4))
    with _WAVE_LOCK:
        try:
            tmp = cache.with_suffix(".tmp")
            tmp.write_text(json.dumps(peaks), "utf-8")
            os.replace(tmp, cache)
        except OSError:
            pass
    return peaks
