"""CineCut HTTP 服务：标准库 http.server + JSON API + SSE 日志流。"""
from __future__ import annotations

import argparse
import base64
import hmac
import json
import mimetypes
import os
import re
import shutil
import signal
import sys
import threading
import time
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import config, db, derive, effects, formats, media, project, render
from .tasks import Events, TaskManager, task_public

STATIC_DIR = Path(__file__).resolve().parent / "static"

ROUTES_GET = re.compile(r"^/api/([a-zA-Z0-9_\-/]+)$")


def json_bytes(payload) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


class HttpError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = f"CineCut/{config.APP_VERSION}"
    protocol_version = "HTTP/1.1"

    manager: TaskManager
    events: Events

    # ------------------------------------------------------------ plumbing

    def log_message(self, fmt: str, *args) -> None:  # noqa: N802
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _authorized(self) -> bool:
        if not config.ACCESS_PASSWORD:
            return True
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(header.split(" ", 1)[1]).decode("utf-8", "replace")
        except (ValueError, TypeError):
            return False
        username, _, password = decoded.partition(":")
        return hmac.compare_digest(username, "cinecut") and hmac.compare_digest(password, config.ACCESS_PASSWORD)

    def _require_auth(self) -> None:
        if self._authorized():
            return
        body = b"Authentication required"
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="CineCut"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        raise ConnectionAbortedError("auth")

    def _send_json(self, payload, status: int = 200) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send_json({"ok": False, "error": message}, status)

    def _read_json(self, limit: int = 8 * 1024 * 1024) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise HttpError(400, "Content-Length 无效")
        if length > limit:
            raise HttpError(413, "请求体过大")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise HttpError(400, "JSON 解析失败")
        if not isinstance(data, dict):
            raise HttpError(400, "请求体必须是对象")
        return data

    def _query(self) -> dict[str, str]:
        query = parse_qs(urlparse(self.path).query, keep_blank_values=True)
        return {key: values[0] for key, values in query.items()}

    def _path(self) -> str:
        return unquote(urlparse(self.path).path)

    # ------------------------------------------------------------ verbs

    def do_GET(self) -> None:  # noqa: N802
        try:
            path = self._path()
            if path == "/healthz":
                self._send_json({"ok": True, "app": config.APP_NAME,
                                 "version": config.APP_VERSION})
                return
            self._require_auth()
            if path.startswith("/api/"):
                self._handle_get_api(path)
            else:
                self._serve_static(path)
        except ConnectionAbortedError:
            pass
        except BrokenPipeError:
            pass
        except HttpError as exc:
            self._error(exc.status, exc.message)
        except media.BadPath as exc:
            self._error(400, str(exc))
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            try:
                self._error(500, f"服务器错误：{exc}")
            except Exception:
                pass

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_POST(self) -> None:  # noqa: N802
        try:
            self._require_auth()
            path = self._path()
            if path == "/api/upload":
                self._handle_upload()
                return
            if not path.startswith("/api/"):
                raise HttpError(404, "not found")
            self._handle_post_api(path)
        except ConnectionAbortedError:
            pass
        except BrokenPipeError:
            pass
        except HttpError as exc:
            self._error(exc.status, exc.message)
        except media.BadPath as exc:
            self._error(400, str(exc))
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            try:
                self._error(500, f"服务器错误：{exc}")
            except Exception:
                pass

    def do_PUT(self) -> None:  # noqa: N802
        try:
            self._require_auth()
            path = self._path()
            match = re.match(r"^/api/projects/([A-Za-z0-9_\-]+)$", path)
            if not match:
                raise HttpError(404, "not found")
            self._save_project(match.group(1))
        except ConnectionAbortedError:
            pass
        except BrokenPipeError:
            pass
        except HttpError as exc:
            self._error(exc.status, exc.message)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            try:
                self._error(500, f"服务器错误：{exc}")
            except Exception:
                pass

    def do_DELETE(self) -> None:  # noqa: N802
        try:
            self._require_auth()
            path = self._path()
            match = re.match(r"^/api/projects/([A-Za-z0-9_\-]+)$", path)
            if match:
                if not db.delete_project(match.group(1)):
                    raise HttpError(404, "工程不存在")
                self._send_json({"ok": True})
                return
            match = re.match(r"^/api/tasks/([A-Za-z0-9_\-]+)$", path)
            if match:
                ok, message = self.manager.remove(match.group(1))
                if not ok:
                    raise HttpError(409, message)
                self._send_json({"ok": True})
                return
            raise HttpError(404, "not found")
        except ConnectionAbortedError:
            pass
        except BrokenPipeError:
            pass
        except HttpError as exc:
            self._error(exc.status, exc.message)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            try:
                self._error(500, f"服务器错误：{exc}")
            except Exception:
                pass

    # ------------------------------------------------------------ GET API

    def _handle_get_api(self, path: str) -> None:
        query = self._query()
        if path == "/api/config":
            cfg = config.public_config()
            cfg["formats"] = formats.list_for_client()
            cfg["effects"] = effects.public_catalog()["effects"]
            cfg["transitions"] = effects.TRANSITIONS
            cfg["blendModes"] = effects.BLEND_MODES
            cfg["easings"] = sorted(effects.EASINGS)
            self._send_json({
                "ok": True,
                "config": cfg,
                "queue": self.manager.queue_state(),
            })
            return
        if path == "/api/waveform":
            raw = query.get("path") or ""
            try:
                target = media.resolve_source(raw, must_exist=True)
                start = max(0.0, float(query.get("start") or 0))
                duration = max(0.0, float(query.get("duration") or 0))
                buckets = int(query.get("buckets") or 900)
            except (media.BadPath, ValueError) as exc:
                raise HttpError(400, str(exc))
            peaks = media.waveform_peaks(target, buckets, start, duration)
            self._send_json({"ok": True, "peaks": peaks, "buckets": len(peaks)})
            return
        if path == "/api/projects":
            self._send_json({"ok": True, "projects": db.list_projects()})
            return
        match = re.match(r"^/api/projects/([A-Za-z0-9_\-]+)/export$", path)
        if match:
            item = db.get_project(match.group(1))
            if not item:
                raise HttpError(404, "工程不存在")
            item["doc"] = project.sanitize_doc(item["doc"], item["name"])
            payload = {
                "format": "cinecut-project",
                "formatVersion": 1,
                "app": "CineCut",
                "appVersion": config.APP_VERSION,
                "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "project": {"id": item["id"], "name": item["name"],
                            "doc": item["doc"], "updated": item["updated"]},
            }
            filename = media.sanitize_filename(f"{item['name']}.cinecut.json", "project.cinecut.json")
            body = json_bytes(payload)
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Disposition", self._attachment_header(filename))
            self.end_headers()
            self.wfile.write(body)
            return
        match = re.match(r"^/api/projects/([A-Za-z0-9_\-]+)$", path)
        if match:
            item = db.get_project(match.group(1))
            if not item:
                raise HttpError(404, "工程不存在")
            item["doc"] = project.sanitize_doc(item["doc"], item["name"])
            self._send_json({"ok": True, "project": item})
            return
        if path == "/api/files":
            rel = query.get("path", "")
            listing = media.list_dir(rel, probe_limit=int(query.get("probe", "60")))
            listing["ok"] = True
            self._send_json(listing)
            return
        if path == "/api/probe":
            rel = query.get("path", "")
            if not rel:
                raise HttpError(400, "缺少 path")
            meta = media.probe_media(media.resolve_input(rel))
            self._send_json({"ok": True, "path": rel, "meta": meta})
            return
        if path == "/api/search":
            term = (query.get("q") or "").strip().lower()
            if not term:
                raise HttpError(400, "缺少 q")
            self._send_json({"ok": True, "results": self._search(term)})
            return
        if path == "/api/thumb":
            rel = query.get("path", "")
            if not rel:
                raise HttpError(400, "缺少 path")
            thumb = media.make_thumb(rel)
            if not thumb:
                raise HttpError(404, "无法生成缩略图")
            data = thumb.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            self.wfile.write(data)
            return
        if path == "/api/media":
            rel = query.get("path", "")
            if not rel:
                raise HttpError(400, "缺少 path")
            self._stream_file(media.resolve_input(rel), media.content_type(rel), download=False)
            return
        if path == "/api/output":
            rel = query.get("path", "")
            if not rel:
                raise HttpError(400, "缺少 path")
            self._stream_file(media.resolve_output(rel), media.content_type(rel),
                              download=query.get("download") == "1")
            return
        if path == "/api/tasks":
            tasks = [task_public(t) for t in db.list_tasks(with_doc=False)]
            self._send_json({"ok": True, "tasks": tasks, "queue": self.manager.queue_state()})
            return
        match = re.match(r"^/api/tasks/([A-Za-z0-9_\-]+)$", path)
        if match:
            task = db.get_task(match.group(1))
            if not task:
                raise HttpError(404, "任务不存在")
            payload = task_public(task)
            payload["doc"] = task.get("doc")
            self._send_json({"ok": True, "task": payload})
            return
        if path == "/api/logs":
            task_id = query.get("task") or None
            limit = int(query.get("limit", "400"))
            after = int(query.get("after", "0"))
            self._send_json({"ok": True, "logs": db.list_logs(limit=limit, after_id=after, task_id=task_id)})
            return
        if path == "/api/events":
            self._serve_events()
            return
        if path == "/api/outputs":
            self._send_json({"ok": True, "entries": media.output_entries()})
            return
        raise HttpError(404, "not found")

    def _search(self, term: str) -> list[dict]:
        results: list[dict] = []
        root = config.INPUT_ROOT
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for name in filenames:
                if term not in name.lower():
                    continue
                if not media.is_media(name) or name.startswith("."):
                    continue
                full = Path(dirpath) / name
                try:
                    rel = full.relative_to(root).as_posix()
                    st = full.stat()
                except (OSError, ValueError):
                    continue
                results.append({
                    "name": name, "path": rel, "type": "file",
                    "kind": media.kind_of(name), "size": st.st_size, "mtime": st.st_mtime,
                    "meta": media.probe_media(full),
                })
                if len(results) >= 120:
                    return results
        return results

    # ------------------------------------------------------------ POST API

    def _handle_post_api(self, path: str) -> None:
        if path == "/api/derive":
            body = self._read_json()
            try:
                result = derive.derive(
                    str(body.get("op") or ""),
                    str(body.get("src") or ""),
                    float(body.get("time") or 0),
                    float(body.get("duration") or 0),
                )
            except derive.DeriveError as exc:
                raise HttpError(400, str(exc))
            self._send_json({"ok": True, **result})
            return
        if path == "/api/projects":
            body = self._read_json(8 * 1024 * 1024)
            name = str(body.get("name") or "未命名工程").strip()[:80] or "未命名工程"
            if body.get("doc") is not None:
                if not isinstance(body["doc"], dict):
                    raise HttpError(400, "doc 必须是对象")
                doc = project.sanitize_doc(body["doc"], name)
                doc["name"] = name
            else:
                doc = project.default_doc(name)
            item = db.create_project(name, doc)
            self._send_json({"ok": True, "project": item}, 201)
            return
        if path == "/api/projects/import":
            body = self._read_json(8 * 1024 * 1024)
            wrapper = body.get("project") if isinstance(body.get("project"), dict) else body
            if wrapper.get("format") and wrapper.get("format") != "cinecut-project":
                raise HttpError(400, "不是 CineCut 工程文件")
            doc_raw = wrapper.get("doc") or body.get("doc")
            if not isinstance(doc_raw, dict):
                raise HttpError(400, "工程文件缺少 doc")
            name = str(wrapper.get("name") or body.get("name") or doc_raw.get("name")
                       or "导入工程").strip()[:80] or "导入工程"
            existing_names = {item["name"] for item in db.list_projects()}
            if name in existing_names:
                base = name
                index = 1
                while f"{base} ({index})" in existing_names:
                    index += 1
                name = f"{base} ({index})"[:80]
            doc = project.sanitize_doc(doc_raw, name)
            doc["name"] = name
            item = db.create_project(name, doc)
            self._send_json({"ok": True, "project": item}, 201)
            return
        match = re.match(r"^/api/projects/([A-Za-z0-9_\-]+)/save$", path)
        if match:
            self._save_project(match.group(1))
            return
        match = re.match(r"^/api/projects/([A-Za-z0-9_\-]+)/duplicate$", path)
        if match:
            source = db.get_project(match.group(1))
            if not source:
                raise HttpError(404, "工程不存在")
            doc = project.sanitize_doc(source["doc"], source["name"])
            name = f"{source['name']} 副本"[:80]
            item = db.create_project(name, doc)
            self._send_json({"ok": True, "project": item}, 201)
            return
        if path == "/api/render":
            self._handle_render()
            return
        if path == "/api/queue":
            body = self._read_json(1024 * 1024)
            action = body.get("action")
            if action == "pause":
                self.manager.set_queue_paused(True)
            elif action == "start":
                self.manager.set_queue_paused(False)
            else:
                raise HttpError(400, "action 必须是 pause 或 start")
            self.manager.log("queue", f"队列已{'暂停' if action == 'pause' else '启动'}。")
            self._send_json({"ok": True, "queue": self.manager.queue_state()})
            return
        if path == "/api/tasks/batch":
            body = self._read_json()
            ids = body.get("ids") or []
            action = body.get("action")
            if not isinstance(ids, list):
                raise HttpError(400, "ids 必须是数组")
            result = self.manager.batch([str(i) for i in ids], str(action))
            self._send_json(result)
            return
        if path == "/api/tasks/clear-completed":
            count = self.manager.clear_completed()
            self._send_json({"ok": True, "removed": count})
            return
        if path == "/api/tasks/retry-failed":
            count = self.manager.retry_failed()
            self._send_json({"ok": True, "retried": count})
            return
        if path == "/api/tasks/clear-all":
            count = self.manager.clear_all()
            self._send_json({"ok": True, "removed": count})
            return
        if path == "/api/tasks/remove-finished":
            count = self.manager.remove_finished()
            self._send_json({"ok": True, "removed": count})
            return
        match = re.match(r"^/api/tasks/([A-Za-z0-9_\-]+)/action$", path)
        if match:
            body = self._read_json(1024 * 1024)
            action = str(body.get("action") or "")
            handler = {
                "pause": self.manager.pause,
                "resume": self.manager.resume,
                "stop": self.manager.stop,
                "retry": self.manager.retry,
            }.get(action)
            if not handler:
                raise HttpError(400, "不支持的 action")
            ok, message = handler(match.group(1))
            if not ok:
                raise HttpError(409, message)
            self._send_json({"ok": True, "message": message})
            return
        raise HttpError(404, "not found")

    @staticmethod
    def _attachment_header(filename: str) -> str:
        from urllib.parse import quote
        ascii_name = filename.encode("ascii", "ignore").decode("ascii") or "project.cinecut.json"
        ascii_name = ascii_name.replace('"', "")
        return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"

    def _save_project(self, project_id: str) -> None:
        body = self._read_json()
        existing = db.get_project(project_id)
        if not existing:
            raise HttpError(404, "工程不存在")
        if not isinstance(body.get("doc"), dict):
            raise HttpError(400, "缺少工程 doc")
        doc = project.sanitize_doc(body["doc"], existing["name"])
        name = str(body.get("name") or doc.get("name") or existing["name"]).strip()[:80] or existing["name"]
        doc["name"] = name
        if not db.save_project(project_id, name, doc):
            raise HttpError(404, "工程不存在")
        self._send_json({"ok": True, "id": project_id, "name": name, "updated": db.now()})

    def _handle_render(self) -> None:
        body = self._read_json()
        project_id = str(body.get("projectId") or "") or None
        if body.get("doc"):
            doc = project.sanitize_doc(body["doc"], "未命名工程")
        elif project_id:
            existing = db.get_project(project_id)
            if not existing:
                raise HttpError(404, "工程不存在")
            doc = project.sanitize_doc(existing["doc"], existing["name"])
        else:
            raise HttpError(400, "需要 doc 或 projectId")
        if not doc.get("main"):
            raise HttpError(400, "主轨为空，请先添加视频片段")
        for clip in doc["main"]:
            if not (config.INPUT_ROOT / clip["src"]).is_file():
                raise HttpError(400, f"源视频不存在：{clip['src']}")
        export = project.export_options(body.get("export"), doc)
        if project_id and body.get("save"):
            db.save_project(project_id, doc.get("name") or "未命名工程", doc)
        name = doc.get("name") or "剪辑"
        title = f"{name} · {export['filename']}"
        task = self.manager.enqueue(project_id, title, doc, export)
        self.manager.log(task["id"], "已加入渲染队列。")
        self._send_json({"ok": True, "task": task_public(task)}, 201)

    # ------------------------------------------------------------ upload

    def _handle_upload(self) -> None:
        query = self._query()
        filename = media.sanitize_filename(query.get("name") or "")
        ext = Path(filename).suffix.lower()
        if ext not in config.MEDIA_EXT:
            raise HttpError(400, "不支持的文件类型")
        dir_rel = (query.get("dir") or "uploads").strip("/")
        try:
            target_dir = media.resolve_input(dir_rel, must_exist=False)
        except media.BadPath as exc:
            raise HttpError(400, str(exc)) from exc
        target_dir.mkdir(parents=True, exist_ok=True)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise HttpError(400, "Content-Length 无效")
        if length <= 0:
            raise HttpError(400, "空文件")
        if length > config.MAX_UPLOAD_BYTES:
            raise HttpError(413, f"文件超过 {config.MAX_UPLOAD_BYTES // 1048576} MB 限制")
        stamp = time.strftime("%Y%m%d_%H%M%S")
        stem = Path(filename).stem[:80]
        filename = f"{stem}_{stamp}{ext}" if not Path(filename).stem.endswith(stamp) else filename
        target = media.unique_path(target_dir, filename)
        temp = target.with_name(target.name + ".uploading")
        received = 0
        try:
            with open(temp, "wb") as handle:
                while received < length:
                    chunk = self.rfile.read(min(1024 * 1024, length - received))
                    if not chunk:
                        break
                    handle.write(chunk)
                    received += len(chunk)
            if received != length:
                raise HttpError(400, "上传中断")
            os.replace(temp, target)
        finally:
            temp.unlink(missing_ok=True)
        rel = target.relative_to(config.INPUT_ROOT).as_posix()
        meta = media.probe_media(target, use_cache=False)
        self.manager.log("upload", f"上传素材：{rel}（{length / 1048576:.1f} MB）")
        self._send_json({"ok": True, "path": rel, "meta": meta}, 201)

    # ------------------------------------------------------------ SSE

    def _serve_events(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        subscription = self.events.subscribe()
        try:
            hello = {"queue": self.manager.queue_state(), "time": time.time()}
            self.wfile.write(f"event: hello\ndata: {json.dumps(hello, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    item = subscription.get(timeout=15)
                except Exception:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                payload = json.dumps(item["data"], ensure_ascii=False)
                self.wfile.write(f"event: {item['event']}\ndata: {payload}\n\n".encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.events.unsubscribe(subscription)
            self.close_connection = True

    # ------------------------------------------------------------ files

    def _serve_static(self, path: str) -> None:
        if path in {"", "/"}:
            path = "/index.html"
        candidate = (STATIC_DIR / path.lstrip("/")).resolve()
        try:
            candidate.relative_to(STATIC_DIR.resolve())
        except ValueError:
            raise HttpError(404, "not found")
        if not candidate.is_file():
            if "." not in Path(path).name:
                candidate = STATIC_DIR / "index.html"
            else:
                raise HttpError(404, "not found")
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        if candidate.suffix == ".js":
            content_type = "text/javascript; charset=utf-8"
        elif candidate.suffix == ".css":
            content_type = "text/css; charset=utf-8"
        data = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _stream_file(self, path: Path, content_type: str, download: bool = False) -> None:
        if not path.is_file():
            raise HttpError(404, "文件不存在")
        size = path.stat().st_size
        start, end = 0, size - 1
        status = 200
        range_header = self.headers.get("Range", "")
        if range_header.startswith("bytes="):
            raw = range_header.split("=", 1)[1].split(",")[0]
            first, _, last = raw.partition("-")
            try:
                if first:
                    start = int(first)
                if last:
                    end = min(int(last), size - 1)
            except ValueError:
                start, end = 0, size - 1
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        if download:
            from urllib.parse import quote
            ascii_name = path.name.encode("ascii", "ignore").decode("ascii") or "video.mp4"
            ascii_name = ascii_name.replace('"', "")
            self.send_header(
                "Content-Disposition",
                f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(path.name)}",
            )
        self.end_headers()
        if self.command == "HEAD":
            return
        try:
            with open(path, "rb") as handle:
                handle.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = handle.read(min(256 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64


def create_server() -> Server:
    config.ensure_dirs()
    db.init()
    if not db.list_projects():
        db.create_project("我的第一个工程", project.default_doc("我的第一个工程"))
    events = Events()
    manager = TaskManager(events)
    manager.start()
    Handler.manager = manager
    Handler.events = events
    httpd = Server((config.HOST, config.PORT), Handler)
    httpd.manager = manager  # type: ignore[attr-defined]
    return httpd


def check() -> int:
    problems = []
    for binary in (config.FFMPEG, config.FFPROBE):
        found = binary if Path(binary).is_file() else shutil.which(binary)
        if not found:
            problems.append(f"缺少可执行文件：{binary}")
    if not config.find_font():
        problems.append("缺少字体文件（字幕需要）")
    for directory in (config.INPUT_ROOT, config.OUTPUT_ROOT, config.DATA_DIR):
        try:
            directory.mkdir(parents=True, exist_ok=True)
            testfile = directory / f".write_test_{os.getpid()}"
            testfile.write_text("ok")
            testfile.unlink()
        except OSError as exc:
            problems.append(f"目录不可写：{directory}（{exc}）")
    print(json.dumps({"ok": not problems, "problems": problems, **config.public_config()},
                     ensure_ascii=False, indent=2))
    return 0 if not problems else 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="CineCut 视频剪辑工坊")
    parser.add_argument("--check", action="store_true", help="自检后退出")
    args = parser.parse_args(argv)
    if args.check:
        return check()
    print(f"CineCut {config.APP_VERSION} 启动中…")
    print(f"  /input  = {config.INPUT_ROOT}")
    print(f"  /output = {config.OUTPUT_ROOT}")
    print(f"  /data   = {config.DATA_DIR}")
    httpd = create_server()
    manager: TaskManager = httpd.manager  # type: ignore[attr-defined]

    def shutdown_handler(signum, frame):  # noqa: ARG001
        print(f"收到信号 {signum}，正在停止…")
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown_handler)
    signal.signal(signal.SIGINT, shutdown_handler)
    print(f"CineCut 已就绪：http://0.0.0.0:{config.PORT}")
    try:
        httpd.serve_forever(poll_interval=0.5)
    finally:
        manager.shutdown()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
