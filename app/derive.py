"""派生素材：冻结帧 / 倒放片段，落盘到 INPUT_ROOT/.derived 供工程直接引用。"""
from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

from . import config, media

DERIVED_DIR = config.INPUT_ROOT / ".derived"
LOCK_SUFFIX = ".lock"


class DeriveError(Exception):
    pass


def _ffmpeg(args: list[str], timeout: int = 180) -> None:
    cmd = [config.FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *args]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise DeriveError("ffmpeg 处理超时") from exc
    if proc.returncode != 0:
        detail = (proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()
        raise DeriveError(detail[-1] if detail else f"ffmpeg 退出码 {proc.returncode}")


def _probe(path: Path) -> dict:
    try:
        return media.probe_media(path)
    except OSError as exc:
        raise DeriveError(f"无法读取素材：{exc}") from exc


def derive(op: str, src: str, time: float, duration: float) -> dict:
    """返回 {path, duration, fps, width, height}；path 为相对 INPUT_ROOT 的路径。"""
    if op not in {"freeze", "reverse"}:
        raise DeriveError("不支持的派生类型")
    source = media.resolve_source(src, must_exist=True)
    meta = _probe(source)
    if not meta.get("hasVideo"):
        raise DeriveError("素材没有视频画面")
    source_len = float(meta.get("duration") or 0)
    start = max(0.0, min(float(time), max(0.0, source_len - 0.05)))
    length = max(0.2, min(float(duration or 3.0), max(0.2, source_len - start)))
    if op == "reverse":
        length = max(0.2, min(float(duration or source_len - start), source_len - start))

    DERIVED_DIR.mkdir(parents=True, exist_ok=True)
    stamp = source.stat().st_mtime_ns
    key = hashlib.sha1(
        f"v3|{op}|{source}|{stamp}|{start:.3f}|{length:.3f}".encode()
    ).hexdigest()[:20]
    target = DERIVED_DIR / f"{op}_{key}.mp4"
    if target.is_file() and target.stat().st_size > 0:
        info = _probe(target)
        return {"path": target.relative_to(config.INPUT_ROOT).as_posix(),
                "duration": round(float(info.get("duration") or length), 3),
                "width": info.get("width"), "height": info.get("height")}

    work = DERIVED_DIR / f".{op}_{key}.part.mp4"
    if op == "freeze":
        frame = DERIVED_DIR / f".{op}_{key}.png"
        _ffmpeg(["-ss", f"{start:.3f}", "-i", str(source), "-frames:v", "1", "-y", str(frame)])
        try:
            _ffmpeg([
                "-loop", "1", "-i", str(frame), "-t", f"{length:.3f}", "-r", "30",
                "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
                "-colorspace", "bt470bg", "-color_primaries", "bt470bg",
                "-color_trc", "bt709", "-color_range", "tv",
                "-movflags", "+faststart", str(work),
            ])
        finally:
            frame.unlink(missing_ok=True)
    else:
        args = ["-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", str(source),
                "-vf", "reverse", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
                "-g", "30", "-keyint_min", "30", "-sc_threshold", "0"]
        if meta.get("hasAudio"):
            args += ["-af", "areverse", "-c:a", "aac", "-b:a", "192k"]
        args += ["-colorspace", "bt470bg", "-color_primaries", "bt470bg",
                 "-color_trc", "bt709", "-color_range", "tv"]
        args += ["-movflags", "+faststart", str(work)]
        _ffmpeg(args)
    work.replace(target)
    info = _probe(target)
    return {"path": target.relative_to(config.INPUT_ROOT).as_posix(),
            "duration": round(float(info.get("duration") or length), 3),
            "width": info.get("width"), "height": info.get("height")}
