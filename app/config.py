"""CineCut 运行配置：全部来自环境变量，便于 Docker 部署。"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

APP_NAME = "CineCut"


def _read_app_version() -> str:
    env_value = os.environ.get("APP_VERSION", "").strip()
    if env_value:
        return env_value
    root = Path(__file__).resolve().parent.parent
    for candidate in (root / "VERSION", Path("/app/VERSION")):
        try:
            value = candidate.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if value:
            return value
    return "1.1.0"


APP_VERSION = _read_app_version()


def _path(env: str, default: str) -> Path:
    raw = os.environ.get(env, default)
    return Path(raw).expanduser().resolve()


INPUT_ROOT = _path("INPUT_ROOT", "/input")
OUTPUT_ROOT = _path("OUTPUT_ROOT", "/output")
DATA_DIR = _path("DATA_DIR", "/data")
WORK_DIR = DATA_DIR / "work"
THUMB_DIR = DATA_DIR / "thumbs"
PROJECT_DIR = DATA_DIR / "projects"
BUILTIN_ROOT = Path(__file__).resolve().parent / "static" / "builtin"
DB_PATH = DATA_DIR / "app.db"

PORT = int(os.environ.get("PORT", "3873"))
HOST = os.environ.get("HOST", "0.0.0.0")
TZ = os.environ.get("TZ", "Asia/Shanghai")

ACCESS_PASSWORD = os.environ.get("ACCESS_PASSWORD", "")
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "8192")) * 1024 * 1024
MAX_CONCURRENT_RENDERS = max(1, int(os.environ.get("MAX_CONCURRENT_RENDERS", "1")))

FFMPEG = os.environ.get("FFMPEG_BIN") or shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = os.environ.get("FFPROBE_BIN") or shutil.which("ffprobe") or "ffprobe"

# 画布尺寸范围（宽/高都会被 clamp 到偶数）
MIN_CANVAS = 320
MAX_CANVAS = 8192
MAX_MAIN_CLIPS = 300
MAX_OVERLAYS = 100
MAX_AUDIO_CLIPS = 50
MAX_TEXTS = 100

VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".ts", ".mts", ".m2ts",
             ".flv", ".wmv", ".mpg", ".mpeg", ".ogv", ".vob", ".m2ts", ".mts", ".3gp"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma",
             ".aiff", ".aif", ".m4b", ".oga", ".mka", ".caf"}
MEDIA_EXT = VIDEO_EXT | IMAGE_EXT | AUDIO_EXT

_FONT_CANDIDATES = [
    "/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def find_font() -> str:
    override = os.environ.get("FONT_FILE", "")
    if override and Path(override).is_file():
        return override
    for candidate in _FONT_CANDIDATES:
        if Path(candidate).is_file():
            return candidate
    # 兜底：不同发行版的字体目录不一致，按名称优先级扫描。
    fonts_root = Path("/usr/share/fonts")
    if fonts_root.is_dir():
        preferred: list[Path] = []
        fallback: list[Path] = []
        for path in fonts_root.rglob("*"):
            if path.suffix.lower() not in {".ttf", ".ttc", ".otf"}:
                continue
            name = path.name.lower()
            if "wqy" in name or "noto" in name and "cjk" in name:
                preferred.append(path)
            else:
                fallback.append(path)
        for path in preferred + fallback:
            return str(path)
    return ""


def ensure_dirs() -> None:
    for directory in (INPUT_ROOT, OUTPUT_ROOT, DATA_DIR, WORK_DIR, THUMB_DIR, PROJECT_DIR):
        directory.mkdir(parents=True, exist_ok=True)


def public_config() -> dict:
    return {
        "app": APP_NAME,
        "version": APP_VERSION,
        "inputRoot": str(INPUT_ROOT),
        "outputRoot": str(OUTPUT_ROOT),
        "port": PORT,
        "maxUploadMB": MAX_UPLOAD_BYTES // (1024 * 1024),
        "ffmpeg": FFMPEG,
        "font": find_font(),
        "timezone": TZ,
        "password": bool(ACCESS_PASSWORD),
        "maxConcurrentRenders": MAX_CONCURRENT_RENDERS,
    }
