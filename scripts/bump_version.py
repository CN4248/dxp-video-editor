#!/usr/bin/env python3
"""统一更新 CineCut 版本号。

用法：
    python3 scripts/bump_version.py patch
    python3 scripts/bump_version.py minor
    python3 scripts/bump_version.py major
    python3 scripts/bump_version.py 1.2.3
"""
from __future__ import annotations

import datetime
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def current_version() -> str:
    return (ROOT / "VERSION").read_text(encoding="utf-8").strip()


def next_version(raw: str, current: str) -> str:
    if raw in {"major", "minor", "patch"}:
        major, minor, patch = (int(part) for part in current.split("."))
        if raw == "major":
            return f"{major + 1}.0.0"
        if raw == "minor":
            return f"{major}.{minor + 1}.0"
        return f"{major}.{minor}.{patch + 1}"
    if not re.fullmatch(r"\d+\.\d+\.\d+", raw):
        raise ValueError("版本号必须形如 1.2.3，或 major/minor/patch")
    return raw


def replace_file(path: Path, pattern: str, replacement: str) -> None:
    text = path.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if count == 0:
        raise RuntimeError(f"未在 {path.name} 中找到版本位置")
    path.write_text(updated, encoding="utf-8")


def write_changelog(version: str) -> None:
    path = ROOT / "CHANGELOG.md"
    today = datetime.date.today().isoformat()
    section = f"## [{version}] - {today}\n\n### Changed\n\n- （发布前补充本次更新内容）\n\n"
    if not path.exists():
        path.write_text("# Changelog\n\n" + section, encoding="utf-8")
        return
    text = path.read_text(encoding="utf-8")
    if f"## [{version}]" in text:
        return
    if text.startswith("# Changelog"):
        head, rest = text.split("\n", 1)
        path.write_text(head + "\n\n" + section + rest.lstrip("\n"), encoding="utf-8")
    else:
        path.write_text(section + text, encoding="utf-8")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    current = current_version()
    version = next_version(sys.argv[1], current)
    if version == current:
        print(f"版本未变化：{version}")
        return 1

    (ROOT / "VERSION").write_text(version + "\n", encoding="utf-8")
    replace_file(ROOT / "docker-compose.yml", r"APP_VERSION: \$\{APP_VERSION:-[0-9]+\.[0-9]+\.[0-9]+\}",
                 "APP_VERSION: ${APP_VERSION:-" + version + "}")
    replace_file(ROOT / "docker-compose.yml", r"(image: cinecut:\$\{APP_VERSION:-)[0-9]+\.[0-9]+\.[0-9]+", rf"\g<1>{version}")
    replace_file(ROOT / "Dockerfile", r"ARG APP_VERSION=[0-9]+\.[0-9]+\.[0-9]+", f"ARG APP_VERSION={version}")
    replace_file(ROOT / ".env.example", r"APP_VERSION=[0-9]+\.[0-9]+\.[0-9]+", f"APP_VERSION={version}")
    env_file = ROOT / ".env"
    if env_file.exists() and re.search(r"^APP_VERSION=", env_file.read_text(encoding="utf-8"), re.MULTILINE):
        replace_file(env_file, r"APP_VERSION=[0-9]+\.[0-9]+\.[0-9]+", f"APP_VERSION={version}")
    replace_file(ROOT / "app" / "static" / "index.html", r'(<span id="versionText">v)[0-9]+\.[0-9]+\.[0-9]+(</span>)', rf"\g<1>{version}\g<2>")
    replace_file(ROOT / "README.md", r"当前版本：\*\*[0-9]+\.[0-9]+\.[0-9]+\*\*", f"当前版本：**{version}**")
    write_changelog(version)
    print(f"CineCut {current} -> {version}")
    print("请补充 CHANGELOG.md，然后执行 python3 scripts/check_version.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
