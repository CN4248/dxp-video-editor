"""SQLite 持久化：工程、任务、日志、媒体缓存、键值状态。

单连接 + RLock。HTTP 线程与渲染线程都通过这里的函数访问，避免跨线程裸用连接。
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import threading
import time
import uuid
from typing import Any, Iterable

from . import config

_LOCK = threading.RLock()
_CONN: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    doc TEXT NOT NULL,
    created REAL NOT NULL,
    updated REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    title TEXT NOT NULL,
    doc TEXT NOT NULL,
    export TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    progress REAL NOT NULL DEFAULT 0,
    stage TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    output TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created REAL NOT NULL,
    started REAL,
    finished REAL,
    sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    ts REAL NOT NULL,
    line TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media_cache (
    path TEXT PRIMARY KEY,
    mtime REAL NOT NULL,
    size INTEGER NOT NULL,
    meta TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_task ON logs(task_id, id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, sort);
"""


def init() -> None:
    global _CONN
    config.ensure_dirs()
    with _LOCK:
        if _CONN is not None:
            return
        conn = sqlite3.connect(config.DB_PATH, check_same_thread=False, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.executescript(SCHEMA)
        conn.commit()
        _CONN = conn


def _conn() -> sqlite3.Connection:
    if _CONN is None:
        init()
    assert _CONN is not None
    return _CONN


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _snapshot_payload(project_id: str, name: str, doc: dict, stamp: float) -> dict:
    return {
        "format": "cinecut-project",
        "formatVersion": 1,
        "app": "CineCut",
        "appVersion": config.APP_VERSION,
        "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime(stamp)),
        "project": {"id": project_id, "name": name, "doc": doc, "updated": stamp},
    }


def _write_snapshot(project_id: str, name: str, doc: dict, stamp: float) -> None:
    """把工程同时落一份可读的 .cinecut.json 到 /data/projects，便于备份与迁移。"""
    try:
        directory = config.PROJECT_DIR
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"{project_id}.cinecut.json"
        temp = target.with_name(f"{target.name}.{os.getpid()}.{time.time_ns()}.tmp")
        temp.write_text(json.dumps(_snapshot_payload(project_id, name, doc, stamp),
                                   ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temp, target)
    except OSError as exc:
        # 数据库已保存时，快照失败不应把保存结果变成 500；在服务日志里留下提示。
        print(f"[CineCut] 工程快照写入失败 {project_id}: {exc}", file=sys.stderr)


def now() -> float:
    return time.time()


# ---------------------------------------------------------------- projects

def list_projects() -> list[dict]:
    with _LOCK:
        rows = _conn().execute("SELECT id, name, created, updated FROM projects ORDER BY updated DESC").fetchall()
        return [dict(r) for r in rows]


def get_project(project_id: str) -> dict | None:
    with _LOCK:
        row = _conn().execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if not row:
            return None
        item = dict(row)
        item["doc"] = json.loads(item["doc"])
        return item


def create_project(name: str, doc: dict) -> dict:
    project_id = new_id("prj")
    stamp = now()
    with _LOCK:
        _conn().execute(
            "INSERT INTO projects (id, name, doc, created, updated) VALUES (?, ?, ?, ?, ?)",
            (project_id, name, json.dumps(doc, ensure_ascii=False), stamp, stamp),
        )
        _conn().commit()
    _write_snapshot(project_id, name, doc, stamp)
    return {"id": project_id, "name": name, "doc": doc, "created": stamp, "updated": stamp}


def save_project(project_id: str, name: str, doc: dict) -> bool:
    stamp = now()
    with _LOCK:
        cur = _conn().execute(
            "UPDATE projects SET name = ?, doc = ?, updated = ? WHERE id = ?",
            (name, json.dumps(doc, ensure_ascii=False), stamp, project_id),
        )
        _conn().commit()
        saved = cur.rowcount > 0
    if saved:
        _write_snapshot(project_id, name, doc, stamp)
    return saved


def delete_project(project_id: str) -> bool:
    with _LOCK:
        cur = _conn().execute("DELETE FROM projects WHERE id = ?", (project_id,))
        _conn().commit()
        deleted = cur.rowcount > 0
    if deleted:
        (config.PROJECT_DIR / f"{project_id}.cinecut.json").unlink(missing_ok=True)
    return deleted


# ---------------------------------------------------------------- tasks

def _task_row(row: sqlite3.Row, with_doc: bool = False) -> dict:
    item = {
        "id": row["id"],
        "projectId": row["project_id"],
        "title": row["title"],
        "export": json.loads(row["export"]) if row["export"] else {},
        "status": row["status"],
        "progress": row["progress"],
        "stage": row["stage"],
        "message": row["message"],
        "output": row["output"],
        "error": row["error"],
        "created": row["created"],
        "started": row["started"],
        "finished": row["finished"],
        "sort": row["sort"],
    }
    if with_doc:
        item["doc"] = json.loads(row["doc"])
    return item


def list_tasks(with_doc: bool = False) -> list[dict]:
    with _LOCK:
        rows = _conn().execute("SELECT * FROM tasks ORDER BY sort ASC, created ASC").fetchall()
        return [_task_row(r, with_doc) for r in rows]


def get_task(task_id: str, with_doc: bool = True) -> dict | None:
    with _LOCK:
        row = _conn().execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return _task_row(row, with_doc) if row else None


def create_task(project_id: str | None, title: str, doc: dict, export: dict) -> dict:
    task_id = new_id("tsk")
    stamp = now()
    with _LOCK:
        row = _conn().execute("SELECT COALESCE(MAX(sort), 0) AS m FROM tasks").fetchone()
        sort = int(row["m"]) + 1
        _conn().execute(
            "INSERT INTO tasks (id, project_id, title, doc, export, status, created, sort) "
            "VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)",
            (task_id, project_id, title, json.dumps(doc, ensure_ascii=False),
             json.dumps(export, ensure_ascii=False), stamp, sort),
        )
        _conn().commit()
    return get_task(task_id)  # type: ignore[return-value]


def update_task(task_id: str, **fields: Any) -> None:
    if not fields:
        return
    allowed = {"status", "progress", "stage", "message", "output", "error", "started", "finished", "title", "sort"}
    pairs = [(k, v) for k, v in fields.items() if k in allowed]
    if not pairs:
        return
    sql = "UPDATE tasks SET " + ", ".join(f"{k} = ?" for k, _ in pairs) + " WHERE id = ?"
    with _LOCK:
        _conn().execute(sql, [v for _, v in pairs] + [task_id])
        _conn().commit()


def delete_task(task_id: str) -> None:
    with _LOCK:
        _conn().execute("DELETE FROM tasks WHERE id = ?", (task_id,))
        _conn().execute("DELETE FROM logs WHERE task_id = ?", (task_id,))
        _conn().commit()


def delete_tasks(task_ids: Iterable[str]) -> None:
    ids = list(task_ids)
    if not ids:
        return
    marks = ",".join("?" for _ in ids)
    with _LOCK:
        _conn().execute(f"DELETE FROM tasks WHERE id IN ({marks})", ids)
        _conn().execute(f"DELETE FROM logs WHERE task_id IN ({marks})", ids)
        _conn().commit()


def next_queued_task() -> dict | None:
    with _LOCK:
        row = _conn().execute(
            "SELECT * FROM tasks WHERE status = 'queued' ORDER BY sort ASC, created ASC LIMIT 1"
        ).fetchone()
        return _task_row(row, True) if row else None


def claim_task(task_id: str) -> bool:
    with _LOCK:
        cur = _conn().execute(
            "UPDATE tasks SET status = 'running', started = ?, stage = '准备素材' "
            "WHERE id = ? AND status = 'queued'",
            (now(), task_id),
        )
        _conn().commit()
        return cur.rowcount > 0


def tasks_by_status(statuses: Iterable[str]) -> list[dict]:
    items = list(statuses)
    if not items:
        return []
    marks = ",".join("?" for _ in items)
    with _LOCK:
        rows = _conn().execute(
            f"SELECT * FROM tasks WHERE status IN ({marks}) ORDER BY sort ASC", items
        ).fetchall()
    return [_task_row(r) for r in rows]


def delete_tasks_by_status(statuses: Iterable[str]) -> list[str]:
    items = list(statuses)
    if not items:
        return []
    marks = ",".join("?" for _ in items)
    with _LOCK:
        rows = _conn().execute(f"SELECT id FROM tasks WHERE status IN ({marks})", items).fetchall()
        ids = [r["id"] for r in rows]
        if ids:
            _conn().execute(f"DELETE FROM tasks WHERE status IN ({marks})", items)
            _conn().execute(f"DELETE FROM logs WHERE task_id IN ({','.join('?' for _ in ids)})", ids)
            _conn().commit()
        return ids


def has_running_task() -> bool:
    with _LOCK:
        row = _conn().execute("SELECT COUNT(*) AS c FROM tasks WHERE status = 'running'").fetchone()
        return bool(row and row["c"])


def mark_interrupted_tasks() -> list[str]:
    """服务启动时把上次中断的 running 任务置为 paused，保留进度与分段缓存。"""
    with _LOCK:
        rows = _conn().execute("SELECT id FROM tasks WHERE status = 'running'").fetchall()
        ids = [r["id"] for r in rows]
        if ids:
            for task_id in ids:
                _conn().execute(
                    "UPDATE tasks SET status = 'paused', stage = '已中断', "
                    "message = '服务重启导致渲染中断，点击继续可复用已完成片段' WHERE id = ?",
                    (task_id,),
                )
            _conn().commit()
        return ids


def reset_running_to_failed(message: str) -> None:
    """备用：把僵尸 running 标记失败（当前主流程使用 paused）。"""
    with _LOCK:
        _conn().execute(
            "UPDATE tasks SET status = 'failed', error = ?, finished = ? WHERE status = 'running'",
            (message, now()),
        )
        _conn().commit()


# ---------------------------------------------------------------- logs

def add_log(task_id: str, line: str, ts: float | None = None) -> dict:
    stamp = ts or now()
    with _LOCK:
        cur = _conn().execute(
            "INSERT INTO logs (task_id, ts, line) VALUES (?, ?, ?)",
            (task_id, stamp, line),
        )
        _conn().commit()
        log_id = int(cur.lastrowid)
    return {"id": log_id, "taskId": task_id, "ts": stamp, "line": line}


def list_logs(limit: int = 400, after_id: int = 0, task_id: str | None = None) -> list[dict]:
    limit = max(1, min(limit, 3000))
    sql = "SELECT * FROM logs WHERE id > ?"
    params: list[Any] = [after_id]
    if task_id:
        sql += " AND task_id = ?"
        params.append(task_id)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    with _LOCK:
        rows = _conn().execute(sql, params).fetchall()
    return [
        {"id": r["id"], "taskId": r["task_id"], "ts": r["ts"], "line": r["line"]}
        for r in reversed(rows)
    ]


def clear_logs(task_id: str | None = None) -> None:
    with _LOCK:
        if task_id:
            _conn().execute("DELETE FROM logs WHERE task_id = ?", (task_id,))
        else:
            _conn().execute("DELETE FROM logs")
        _conn().commit()


# ---------------------------------------------------------------- media cache

def get_media_meta(path: str, mtime: float, size: int) -> dict | None:
    with _LOCK:
        row = _conn().execute("SELECT * FROM media_cache WHERE path = ?", (path,)).fetchone()
    if not row:
        return None
    if abs(float(row["mtime"]) - float(mtime)) > 0.001 or int(row["size"]) != int(size):
        return None
    try:
        return json.loads(row["meta"])
    except json.JSONDecodeError:
        return None


def put_media_meta(path: str, mtime: float, size: int, meta: dict) -> None:
    with _LOCK:
        _conn().execute(
            "INSERT INTO media_cache (path, mtime, size, meta) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size, meta = excluded.meta",
            (path, mtime, size, json.dumps(meta, ensure_ascii=False)),
        )
        _conn().commit()


# ---------------------------------------------------------------- kv

def get_kv(key: str, default: str = "") -> str:
    with _LOCK:
        row = _conn().execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_kv(key: str, value: str) -> None:
    with _LOCK:
        _conn().execute(
            "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        _conn().commit()
