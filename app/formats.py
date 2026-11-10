"""导出格式注册表。

每种格式绑定容器、编码器与少量额外参数；渲染层只读取这里，
前端通过 /api/config 的 formats 列表展示，避免前后端各维护一份。
"""
from __future__ import annotations

from typing import Any


FORMATS: dict[str, dict[str, Any]] = {
    # ---------------------------------------------------------- 视频容器
    "mp4": {
        "label": "MP4", "group": "视频", "ext": ".mp4", "muxer": "mp4",
        "kind": "video", "vcodec": "libx264", "acodec": "aac",
        "description": "H.264 + AAC，兼容性最好", "quality": True,
        "faststart": True,
    },
    "mkv": {
        "label": "MKV", "group": "视频", "ext": ".mkv", "muxer": "matroska",
        "kind": "video", "vcodec": "libx264", "acodec": "aac",
        "description": "H.264 + AAC，Matroska 容器", "quality": True,
    },
    "mov": {
        "label": "MOV", "group": "视频", "ext": ".mov", "muxer": "mov",
        "kind": "video", "vcodec": "libx264", "acodec": "aac",
        "description": "H.264 + AAC，QuickTime 容器", "quality": True,
        "faststart": True,
    },
    "m4v": {
        "label": "M4V", "group": "视频", "ext": ".m4v", "muxer": "ipod",
        "kind": "video", "vcodec": "libx264", "acodec": "aac",
        "description": "H.264 + AAC，iPod/Apple 兼容", "quality": True,
        "faststart": True,
    },
    "avi": {
        "label": "AVI", "group": "视频", "ext": ".avi", "muxer": "avi",
        "kind": "video", "vcodec": "mpeg4", "acodec": "libmp3lame",
        "description": "MPEG-4 Part 2 + MP3，老播放器兼容", "quality": True,
        "qscale": True,
    },
    "flv": {
        "label": "FLV", "group": "视频", "ext": ".flv", "muxer": "flv",
        "kind": "video", "vcodec": "libx264", "acodec": "aac",
        "description": "H.264 + AAC，Flash 容器", "quality": True,
    },
    "webm": {
        "label": "WebM", "group": "视频", "ext": ".webm", "muxer": "webm",
        "kind": "video", "vcodec": "libvpx-vp9", "acodec": "libopus",
        "description": "VP9 + Opus，网页友好", "quality": True,
        "vp9": True,
    },
    "ts": {
        "label": "TS", "group": "视频", "ext": ".ts", "muxer": "mpegts",
        "kind": "video", "vcodec": "libx264", "acodec": "aac",
        "description": "H.264 + AAC，MPEG-TS 流", "quality": True,
    },
    "wmv": {
        "label": "WMV", "group": "视频", "ext": ".wmv", "muxer": "asf",
        "kind": "video", "vcodec": "wmv2", "acodec": "wmav2",
        "description": "WMV2 + WMA2，Windows Media", "quality": True,
        "qscale": True,
    },
    "ogv": {
        "label": "OGV", "group": "视频", "ext": ".ogv", "muxer": "ogg",
        "kind": "video", "vcodec": "libtheora", "acodec": "libvorbis",
        "description": "Theora + Vorbis，开放容器", "quality": True,
        "theora": True,
    },
    "gif": {
        "label": "GIF", "group": "动图", "ext": ".gif", "muxer": "gif",
        "kind": "gif", "vcodec": "gif", "acodec": None,
        "description": "动态 GIF，无声音，最高 12fps", "quality": False,
    },
    "mpg": {
        "label": "MPG", "group": "视频", "ext": ".mpg", "muxer": "mpeg",
        "kind": "video", "vcodec": "mpeg2video", "acodec": "mp2",
        "description": "MPEG-2 + MP2，老式光盘/电视兼容", "quality": True,
        "qscale": True,
    },
    "vob": {
        "label": "VOB", "group": "视频", "ext": ".vob", "muxer": "vob",
        "kind": "video", "vcodec": "mpeg2video", "acodec": "mp2",
        "description": "MPEG-2 PS / DVD VOB", "quality": True,
        "qscale": True,
    },
    "m2ts": {
        "label": "M2TS", "group": "视频", "ext": ".m2ts", "muxer": "mpegts",
        "kind": "video", "vcodec": "libx264", "acodec": "aac",
        "description": "H.264 + AAC，蓝光/摄像机传输流", "quality": True,
    },
    "mts": {
        "label": "MTS", "group": "视频", "ext": ".mts", "muxer": "mpegts",
        "kind": "video", "vcodec": "libx264", "acodec": "aac",
        "description": "H.264 + AAC，AVCHD 传输流", "quality": True,
    },
    "3gp": {
        "label": "3GP", "group": "视频", "ext": ".3gp", "muxer": "3gp",
        "kind": "video", "vcodec": "libx264", "acodec": "aac",
        "description": "H.264 + AAC，手机/3GPP 兼容", "quality": True,
    },
    # ---------------------------------------------------------- 纯音频
    "mp3": {
        "label": "MP3", "group": "音频", "ext": ".mp3", "muxer": "mp3",
        "kind": "audio", "vcodec": None, "acodec": "libmp3lame",
        "description": "MP3，192 kbps", "quality": False,
    },
    "m4a": {
        "label": "M4A", "group": "音频", "ext": ".m4a", "muxer": "ipod",
        "kind": "audio", "vcodec": None, "acodec": "aac",
        "description": "AAC，192 kbps", "quality": False,
    },
    "aac": {
        "label": "AAC", "group": "音频", "ext": ".aac", "muxer": "adts",
        "kind": "audio", "vcodec": None, "acodec": "aac",
        "description": "裸 AAC/ADTS，192 kbps", "quality": False,
    },
    "flac": {
        "label": "FLAC", "group": "音频", "ext": ".flac", "muxer": "flac",
        "kind": "audio", "vcodec": None, "acodec": "flac",
        "description": "FLAC 无损音频", "quality": False,
    },
    "wav": {
        "label": "WAV", "group": "音频", "ext": ".wav", "muxer": "wav",
        "kind": "audio", "vcodec": None, "acodec": "pcm_s16le",
        "description": "PCM 16-bit WAV，无损未压缩", "quality": False,
    },
    "ogg": {
        "label": "OGG", "group": "音频", "ext": ".ogg", "muxer": "ogg",
        "kind": "audio", "vcodec": None, "acodec": "libvorbis",
        "description": "Vorbis 音频", "quality": False,
    },
    "opus": {
        "label": "OPUS", "group": "音频", "ext": ".opus", "muxer": "opus",
        "kind": "audio", "vcodec": None, "acodec": "libopus",
        "description": "Opus 音频，160 kbps", "quality": False,
    },
    "wma": {
        "label": "WMA", "group": "音频", "ext": ".wma", "muxer": "asf",
        "kind": "audio", "vcodec": None, "acodec": "wmav2",
        "description": "WMA2 音频", "quality": False,
    },
    "aiff": {
        "label": "AIFF", "group": "音频", "ext": ".aiff", "muxer": "aiff",
        "kind": "audio", "vcodec": None, "acodec": "pcm_s16be",
        "description": "PCM 16-bit AIFF，无损未压缩", "quality": False,
    },
    "alac": {
        "label": "ALAC", "group": "音频", "ext": ".m4a", "muxer": "ipod",
        "kind": "audio", "vcodec": None, "acodec": "alac",
        "description": "Apple Lossless 音频", "quality": False,
    },
    "ac3": {
        "label": "AC3", "group": "音频", "ext": ".ac3", "muxer": "ac3",
        "kind": "audio", "vcodec": None, "acodec": "ac3",
        "description": "Dolby Digital AC-3 音频", "quality": False,
    },
    "m4b": {
        "label": "M4B", "group": "音频", "ext": ".m4b", "muxer": "ipod",
        "kind": "audio", "vcodec": None, "acodec": "aac",
        "description": "AAC 有声书 M4B", "quality": False,
    },
    "oga": {
        "label": "OGA", "group": "音频", "ext": ".oga", "muxer": "ogg",
        "kind": "audio", "vcodec": None, "acodec": "libvorbis",
        "description": "Ogg Vorbis 音频", "quality": False,
    },
    "mka": {
        "label": "MKA", "group": "音频", "ext": ".mka", "muxer": "matroska",
        "kind": "audio", "vcodec": None, "acodec": "flac",
        "description": "Matroska 无损音频（FLAC）", "quality": False,
    },
    "caf": {
        "label": "CAF", "group": "音频", "ext": ".caf", "muxer": "caf",
        "kind": "audio", "vcodec": None, "acodec": "pcm_s16le",
        "description": "Apple Core Audio PCM", "quality": False,
    },
}

DEFAULT_FORMAT = "mp4"
EXTENSIONS = {meta["ext"].lower() for meta in FORMATS.values()}


def normalize(key: str | None) -> str:
    return key if key in FORMATS else DEFAULT_FORMAT


def get(key: str | None) -> dict[str, Any]:
    resolved = normalize(key)
    return {"key": resolved, **FORMATS[resolved]}


def is_audio(key: str | None) -> bool:
    return get(key)["kind"] == "audio"


def is_gif(key: str | None) -> bool:
    return get(key)["kind"] == "gif"


def has_video(key: str | None) -> bool:
    return get(key)["kind"] in {"video", "gif"}


def list_for_client() -> list[dict[str, Any]]:
    return [
        {
            "key": key,
            "label": meta["label"],
            "group": meta["group"],
            "ext": meta["ext"],
            "kind": meta["kind"],
            "description": meta["description"],
            "quality": meta["quality"],
            "hasVideo": meta["kind"] in {"video", "gif"},
            "hasAudio": meta["kind"] != "gif",
        }
        for key, meta in FORMATS.items()
    ]
