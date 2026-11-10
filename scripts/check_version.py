#!/usr/bin/env python3
"""检查 VERSION、compose、Dockerfile、.env.example、前端 fallback 是否一致。"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    problems = []
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        problems.append(f"VERSION 不是 x.y.z：{version!r}")

    checks = [
        ("docker-compose.yml", rf"APP_VERSION:-{re.escape(version)}\b"),
        ("docker-compose.yml", rf"image: cinecut:\$\{{APP_VERSION:-{re.escape(version)}\}}"),
        ("Dockerfile", rf"ARG APP_VERSION={re.escape(version)}\b"),
        (".env.example", rf"APP_VERSION={re.escape(version)}\b"),
        ("app/static/index.html", rf'<span id="versionText">v{re.escape(version)}</span>'),
        ("README.md", rf"当前版本：\*\*{re.escape(version)}\*\*"),
    ]
    for filename, pattern in checks:
        text = (ROOT / filename).read_text(encoding="utf-8")
        if not re.search(pattern, text):
            problems.append(f"{filename} 未同步 {version}（期望 /{pattern}/）")
    env_file = ROOT / ".env"
    if env_file.exists() and re.search(r"^APP_VERSION=", env_file.read_text(encoding="utf-8"), re.MULTILINE):
        if not re.search(rf"^APP_VERSION={re.escape(version)}$", env_file.read_text(encoding="utf-8"), re.MULTILINE):
            problems.append(f".env 未同步 {version}")

    if problems:
        print("版本检查失败：")
        for item in problems:
            print(" -", item)
        return 1
    print(f"CineCut 版本一致：{version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
