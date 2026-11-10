"""持久任务队列与 FFmpeg 执行器。

- 单队列、可配置并发（默认 1 个 worker）。
- 暂停：队列暂停只影响“是否开始新任务”；单个运行中任务用 SIGSTOP 冻结 ffmpeg。
- 终止：杀死进程组并标记 canceled。
- 容器重启：running -> paused，已编码分段保留，继续时跳过。
"""
from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import threading
import time
import traceback
from collections import deque
from pathlib import Path

from . import config, db, formats, media, project, render


class TaskCanceled(Exception):
    pass


class Events:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subs: list[queue.Queue] = []

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=400)
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)

    def emit(self, event: str, data: dict) -> None:
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait({"event": event, "data": data})
            except queue.Full:
                pass


def task_public(task: dict) -> dict:
    item = {k: task.get(k) for k in (
        "id", "projectId", "title", "export", "status", "progress", "stage",
        "message", "output", "error", "created", "started", "finished",
    )}
    doc = task.get("doc") or {}
    item["duration"] = project.project_duration(doc) if doc else 0
    return item


class TaskManager:
    def __init__(self, events: Events) -> None:
        self.events = events
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._queue_paused = db.get_kv("queue_paused", "0") == "1"
        self._active: dict[str, dict] = {}
        self._active_lock = threading.Lock()
        self._progress_at: dict[str, float] = {}
        self._threads: list[threading.Thread] = []
        self._workers = max(1, config.MAX_CONCURRENT_RENDERS)

    # ------------------------------------------------------------ lifecycle

    def start(self) -> None:
        interrupted = db.mark_interrupted_tasks()
        for task_id in interrupted:
            self.log(task_id, "服务重启：任务已安全暂停，已完成的分段会保留。")
        for index in range(self._workers):
            thread = threading.Thread(target=self._worker_loop, name=f"render-{index}", daemon=True)
            thread.start()
            self._threads.append(thread)

    def shutdown(self) -> None:
        self._stop.set()
        self._wake.set()
        with self._active_lock:
            active = list(self._active.items())
        # 先落盘“已中断”，确保优雅停机时任务不会被误标为 canceled。
        for task_id, item in active:
            item["stopping"] = True
            db.update_task(task_id, status="paused", stage="已中断",
                           message="服务停止导致渲染中断，已完成的分段会保留，可继续渲染")
        for task_id, item in active:
            item["stop"] = True
            item["paused"] = False
            proc = item.get("proc")
            if proc and proc.poll() is None:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGCONT)
                except (ProcessLookupError, PermissionError):
                    pass
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    pass

    @property
    def queue_paused(self) -> bool:
        return self._queue_paused

    def set_queue_paused(self, paused: bool) -> bool:
        self._queue_paused = bool(paused)
        db.set_kv("queue_paused", "1" if paused else "0")
        if not paused:
            self._wake.set()
        self.events.emit("queue", {"paused": self._queue_paused})
        return self._queue_paused

    def queue_state(self) -> dict:
        tasks = db.list_tasks()
        counts: dict[str, int] = {}
        for task in tasks:
            counts[task["status"]] = counts.get(task["status"], 0) + 1
        return {"paused": self._queue_paused, "counts": counts, "workers": self._workers}

    # ------------------------------------------------------------ logging

    def log(self, task_id: str, line: str) -> None:
        line = str(line).replace("\r", "").strip()
        if not line:
            return
        entry = db.add_log(task_id, line[:4000])
        self.events.emit("log", entry)

    def _emit_task(self, task_id: str) -> None:
        task = db.get_task(task_id, with_doc=False)
        if task:
            self.events.emit("task", task_public(task))

    def _update(self, task_id: str, **fields) -> None:
        db.update_task(task_id, **fields)
        self._emit_task(task_id)

    def _set_progress(self, task_id: str, value: float, stage: str | None = None,
                      force: bool = False) -> None:
        value = max(0.0, min(99.5, float(value)))
        stamp = time.time()
        if not force and stamp - self._progress_at.get(task_id, 0) < 0.45:
            return
        self._progress_at[task_id] = stamp
        fields = {"progress": round(value, 2)}
        if stage:
            fields["stage"] = stage
        db.update_task(task_id, **fields)
        self._emit_task(task_id)

    # ------------------------------------------------------------ worker

    def _worker_loop(self) -> None:
        while not self._stop.is_set():
            if self._queue_paused:
                self._wake.wait(1.0)
                self._wake.clear()
                continue
            task = db.next_queued_task()
            if not task:
                self._wake.wait(1.5)
                self._wake.clear()
                continue
            if not db.claim_task(task["id"]):
                continue
            task = db.get_task(task["id"]) or task
            self._emit_task(task["id"])
            try:
                self._run_task(task)
            except Exception:  # 防御：任何漏网异常都不能杀死 worker
                self.log(task["id"], "internal error:\n" + traceback.format_exc())
                try:
                    self._update(task["id"], status="failed", message="内部错误",
                                 error="internal error", finished=db.now())
                except Exception:
                    pass

    def _active_item(self, task_id: str) -> dict | None:
        with self._active_lock:
            return self._active.get(task_id)

    def _check(self, task_id: str) -> None:
        item = self._active_item(task_id)
        if not item:
            return
        if item["stop"]:
            raise TaskCanceled()
        while item["paused"] and not item["stop"]:
            item["wake"].wait(0.4)
        if item["stop"]:
            raise TaskCanceled()

    def _run_ffmpeg(self, task_id: str, cmd: list[str], duration: float,
                    on_fraction=None, label: str = "") -> None:
        item = self._active_item(task_id)
        if not item:
            raise TaskCanceled()
        full = cmd[:1] + ["-progress", "pipe:1", "-nostats"] + cmd[1:]
        try:
            proc = subprocess.Popen(
                full, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace", bufsize=1,
                start_new_session=True,
            )
        except OSError as exc:
            raise render.RenderError(f"无法启动 ffmpeg：{exc}") from exc
        item["proc"] = proc
        # 关闭“暂停/终止”与 Popen 之间的竞态窗口
        if item["stop"]:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                proc.terminate()
        elif item["paused"]:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGSTOP)
            except (ProcessLookupError, PermissionError):
                pass

        errors: deque[str] = deque(maxlen=40)

        def read_stderr() -> None:
            assert proc.stderr is not None
            for raw in proc.stderr:
                line = raw.rstrip()
                if line:
                    errors.append(line)
                    self.log(task_id, line)

        err_thread = threading.Thread(target=read_stderr, daemon=True)
        err_thread.start()

        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.strip()
            if not line:
                continue
            if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
                try:
                    seconds = float(line.split("=", 1)[1]) / 1_000_000
                except (ValueError, IndexError):
                    continue
                if on_fraction and duration > 0:
                    on_fraction(min(1.0, seconds / duration))
            elif line == "progress=end" and on_fraction:
                on_fraction(1.0)
        returncode = proc.wait()
        err_thread.join(timeout=5)
        for stream in (proc.stdout, proc.stderr):
            try:
                stream.close()
            except (AttributeError, ValueError, OSError):
                pass
        item["proc"] = None
        item["paused"] = False
        if item["stop"]:
            raise TaskCanceled()
        if returncode != 0:
            tail = errors[-1] if errors else "无错误输出"
            raise render.RenderError(f"ffmpeg 退出码 {returncode}：{tail}")
        if label:
            self.log(task_id, f"完成：{label}")

    def _cancel_active(self, task_id: str) -> None:
        item = self._active_item(task_id)
        if not item:
            return
        item["stop"] = True
        item["paused"] = False
        item["wake"].set()
        proc = item.get("proc")
        if proc and proc.poll() is None:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGCONT)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                try:
                    proc.terminate()
                except OSError:
                    pass

    # ------------------------------------------------------------ run a task

    def _run_task(self, task: dict) -> None:
        task_id = task["id"]
        doc = task["doc"]
        export = task["export"]
        started = time.time()
        with self._active_lock:
            self._active[task_id] = {"proc": None, "paused": False, "stop": False,
                                     "wake": threading.Event(), "started": started}
        work_dir = config.WORK_DIR / task_id
        work_dir.mkdir(parents=True, exist_ok=True)
        try:
            current = db.get_task(task_id, with_doc=False)
            if not current or current.get("status") != "running":
                self.log(task_id, "任务在开始前被暂停或终止，跳过本次渲染。")
                return
            self.log(task_id, f"任务开始：{task['title']}")
            export_fmt = formats.get(export.get("format"))
            plan = render.plan_render(doc, task_id)
            # 分段直出只适用于 MP4；其它容器/编码统一走最终编码。
            if export_fmt["key"] != "mp4":
                plan.needs_final = True
            if float(export.get("start") or 0) > 0 or float(export.get("end") or 0) > 0:
                plan.needs_final = True
            doc = plan.doc
            self._update(task_id, stage="准备素材", progress=0, started=db.now(), message="")
            self.log(task_id, f"主轨 {len(plan.segments)} 段，总时长 {plan.duration:.2f}s，画布 "
                              f"{doc['canvas']['width']}x{doc['canvas']['height']}@{doc['canvas']['fps']}fps")
            self.log(task_id, f"导出格式：{export_fmt['label']}（{export_fmt['description']}），"
                              + ("分段 → 拼接 → 最终编码（支持断点续渲）"
                                 if plan.needs_final else "分段直出 → 无损拼接（支持断点续渲）"))

            if plan.needs_final:
                seg_crf, seg_preset, seg_grade = 14, "veryfast", False
            else:
                seg_crf = int(export.get("crf", 20))
                seg_preset = export.get("preset", "medium")
                seg_grade = True

            done_duration = 0.0
            for seg in plan.segments:
                if seg.path.is_file() and seg.path.stat().st_size > 2000:
                    done_duration += seg.duration
            weight = 0.6 if plan.needs_final else 0.995
            if done_duration > 0:
                initial = done_duration / max(plan.total_main, 0.01) * weight * 100
                self._set_progress(task_id, initial, stage="复用已完成分段", force=True)
                self.log(task_id, f"发现已完成分段 {done_duration:.2f}s，继续时将跳过。")

            for seg in plan.segments:
                self._check(task_id)
                if seg.path.is_file() and seg.path.stat().st_size > 2000:
                    continue
                tmp = seg.path.with_name(seg.path.stem + ".part.mp4")
                tmp.unlink(missing_ok=True)
                self._update(task_id, stage=f"编码片段 {seg.index + 1}/{len(plan.segments)}",
                             message=f"{seg.clip['src'].split('/')[-1]} · {seg.duration:.1f}s")
                self.log(task_id, f"[{seg.index + 1}/{len(plan.segments)}] 编码 {seg.clip['src']} "
                                  f"({seg.duration:.2f}s)")
                cmd = render.build_segment_cmd(
                    seg.clip, doc, seg.duration, tmp, seg_crf, seg_preset, seg_grade, seg.has_audio
                )

                def fraction(frac: float, _seg=seg, _base=done_duration) -> None:
                    current = _base + frac * _seg.duration
                    value = current / max(plan.total_main, 0.01) * weight * 100
                    self._set_progress(task_id, value, stage=f"编码片段 {_seg.index + 1}/{len(plan.segments)}")

                self._run_ffmpeg(task_id, cmd, seg.duration, fraction,
                                 label=f"片段 {seg.index + 1}")
                if not tmp.is_file() or tmp.stat().st_size < 500:
                    raise render.RenderError(f"片段 {seg.index + 1} 编码结果为空")
                os.replace(tmp, seg.path)
                done_duration += seg.duration

            self._check(task_id)
            self._update(task_id, stage="拼接片段", message="正在无损拼接主轨")
            self.log(task_id, "拼接主轨片段…")
            if plan.needs_final:
                base_path = work_dir / "base.mp4"
            else:
                base_path = work_dir / "final_direct.mp4"
            base_path.unlink(missing_ok=True)
            clip_paths, clip_cmds = render.plan_assembly(plan, work_dir)
            for clip_cmd in clip_cmds:
                self._run_ffmpeg(task_id, clip_cmd, 0, None, label="片段拼接")
            has_transition = any(plan.transitions[index] for index in range(1, len(plan.clip_durations)))
            if has_transition:
                self.log(task_id, "应用片段转场（xfade/acrossfade）…")
                xfade_cmd = render.build_xfade_cmd(
                    clip_paths, plan.transitions, plan.clip_durations, base_path,
                    int(doc["canvas"]["fps"]))
                self._run_ffmpeg(task_id, xfade_cmd, 0, None, label="转场合成")
            elif len(clip_paths) == 1:
                os.replace(clip_paths[0], base_path)
            else:
                concat_cmd = render.build_concat_cmd(clip_paths, work_dir, base_path)
                self._run_ffmpeg(task_id, concat_cmd, 0, None, label="主轨拼接")
            if not base_path.is_file():
                raise render.RenderError("拼接结果不存在")

            if plan.needs_final:
                self._set_progress(task_id, 62, stage="叠加与混音", force=True)
                self._check(task_id)
                self._update(task_id, stage="叠加与混音", message="叠加素材 / 字幕 / 混音")
                self.log(task_id, "合成叠加层、字幕与音轨（最终编码）…")
                final_path = work_dir / "final.mp4"
                final_path.unlink(missing_ok=True)
                final_cmd = render.build_final_cmd(doc, base_path, work_dir, final_path, export)

                def final_fraction(frac: float) -> None:
                    self._set_progress(task_id, 60 + frac * 38, stage="叠加与混音")

                self._run_ffmpeg(task_id, final_cmd, plan.duration, final_fraction, label="最终合成")
                produced = final_path
            else:
                produced = base_path

            self._check(task_id)
            self._set_progress(task_id, 99, stage="写入文件", force=True)
            self._update(task_id, stage="写入文件", message="正在写入导出目录")
            target = render.finalize_output(produced, export)
            rel = target.relative_to(config.OUTPUT_ROOT).as_posix()
            elapsed = time.time() - started
            self.log(task_id, f"✅ 导出完成：/output/{rel}（{elapsed:.1f}s，"
                              f"{target.stat().st_size / 1048576:.1f} MB）")
            self._update(task_id, status="done", progress=100, stage="已完成",
                         message=f"已导出 {rel}", output=rel, finished=db.now(), error="")
            render.cleanup_work(task_id)
        except TaskCanceled:
            status = (db.get_task(task_id, with_doc=False) or {}).get("status")
            if status not in {"canceled", "paused"}:
                self._update(task_id, status="canceled", stage="已终止", message="任务已终止",
                             finished=db.now())
                self.log(task_id, "任务已终止。")
        except render.RenderError as exc:
            status = (db.get_task(task_id, with_doc=False) or {}).get("status")
            if status == "canceled":
                return
            self.log(task_id, f"❌ 渲染失败：{exc}")
            self._update(task_id, status="failed", stage="失败", message=str(exc)[:500],
                         error=str(exc)[:2000], finished=db.now())
        except Exception as exc:  # noqa: BLE001
            if (db.get_task(task_id, with_doc=False) or {}).get("status") == "canceled":
                return
            self.log(task_id, "❌ 未预期错误：\n" + traceback.format_exc())
            self._update(task_id, status="failed", stage="失败", message=str(exc)[:500],
                         error=str(exc)[:2000], finished=db.now())
        finally:
            with self._active_lock:
                self._active.pop(task_id, None)
            self._progress_at.pop(task_id, None)

    # ------------------------------------------------------------ API actions

    def enqueue(self, project_id: str | None, title: str, doc: dict, export: dict) -> dict:
        task = db.create_task(project_id, title[:120], doc, export)
        self.events.emit("task", task_public(db.get_task(task["id"], with_doc=False) or task))
        self._wake.set()
        return task

    def pause(self, task_id: str) -> tuple[bool, str]:
        task = db.get_task(task_id, with_doc=False)
        if not task:
            return False, "任务不存在"
        if task["status"] == "queued":
            self._update(task_id, status="paused", stage="队列中暂停", message="已从队列暂停，继续后重新排队")
            self.log(task_id, "任务已在队列中暂停。")
            return True, "已暂停"
        if task["status"] == "running":
            item = self._active_item(task_id)
            if item:
                item["paused"] = True
                proc = item.get("proc")
                if proc and proc.poll() is None:
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGSTOP)
                    except (ProcessLookupError, PermissionError) as exc:
                        return False, f"无法暂停进程：{exc}"
            self._update(task_id, status="paused", stage="已暂停", message="编码进程已冻结")
            self.log(task_id, "编码已暂停（进程冻结）。")
            return True, "已暂停"
        if task["status"] == "paused":
            return True, "已经是暂停状态"
        return False, "当前状态不可暂停"

    def resume(self, task_id: str) -> tuple[bool, str]:
        task = db.get_task(task_id, with_doc=False)
        if not task:
            return False, "任务不存在"
        if task["status"] != "paused":
            return False, "只有暂停的任务可以继续"
        item = self._active_item(task_id)
        if item:
            item["paused"] = False
            item["wake"].set()
            proc = item.get("proc")
            if proc and proc.poll() is None:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGCONT)
                except (ProcessLookupError, PermissionError) as exc:
                    return False, f"无法继续进程：{exc}"
            self._update(task_id, status="running", stage="继续编码", message="")
            self.log(task_id, "继续编码。")
            return True, "已继续"
        self._update(task_id, status="queued", progress=task["progress"], stage="重新排队",
                     message="将从已完成的分段继续", finished=None)
        self.log(task_id, "任务重新排队，继续时会复用已完成分段。")
        self._wake.set()
        return True, "已重新排队"

    def stop(self, task_id: str) -> tuple[bool, str]:
        task = db.get_task(task_id, with_doc=False)
        if not task:
            return False, "任务不存在"
        if task["status"] not in {"queued", "running", "paused"}:
            return False, "当前状态不可终止"
        self._cancel_active(task_id)
        self._update(task_id, status="canceled", stage="已终止", message="任务被手动终止",
                     finished=db.now())
        self.log(task_id, "收到终止指令。")
        return True, "已终止"

    def retry(self, task_id: str) -> tuple[bool, str]:
        task = db.get_task(task_id, with_doc=False)
        if not task:
            return False, "任务不存在"
        if task["status"] not in {"failed", "canceled"}:
            return False, "只有失败或已终止的任务可以重试"
        self._update(task_id, status="queued", progress=0, stage="等待重试", message="",
                     error="", finished=None)
        self.log(task_id, "任务重新排队重试，已完成的分段会复用。")
        self._wake.set()
        return True, "已加入队列"

    def remove(self, task_id: str) -> tuple[bool, str]:
        task = db.get_task(task_id, with_doc=False)
        if not task:
            return False, "任务不存在"
        if task["status"] in {"running", "paused", "queued"}:
            if task["status"] == "paused" and not self._active_item(task_id):
                pass
            else:
                return False, "请先终止任务再删除"
        render.cleanup_work(task_id)
        db.delete_task(task_id)
        self.events.emit("task_deleted", {"id": task_id})
        return True, "已删除"

    def batch(self, ids: list[str], action: str) -> dict:
        handler = {
            "pause": self.pause,
            "resume": self.resume,
            "stop": self.stop,
            "retry": self.retry,
        }.get(action)
        if not handler:
            return {"ok": False, "error": f"不支持的操作：{action}"}
        results = []
        for task_id in ids[:200]:
            ok, message = handler(task_id)
            results.append({"id": task_id, "ok": ok, "message": message})
        return {"ok": True, "results": results}

    def clear_completed(self) -> int:
        ids = db.delete_tasks_by_status(["done"])
        for task_id in ids:
            render.cleanup_work(task_id)
            self.events.emit("task_deleted", {"id": task_id})
        return len(ids)

    def retry_failed(self) -> int:
        tasks = db.tasks_by_status(["failed"])
        count = 0
        for task in tasks:
            ok, _ = self.retry(task["id"])
            count += 1 if ok else 0
        return count

    def clear_all(self) -> int:
        """删除全部任务：先终止运行中的任务，再清空记录与工作目录。"""
        tasks = db.list_tasks(with_doc=False)
        for task in tasks:
            if task["status"] in {"running", "queued", "paused"}:
                try:
                    self.stop(task["id"])
                except Exception:  # noqa: BLE001 - 单个任务失败不应阻断整体清理
                    pass
        ids = [task["id"] for task in tasks]
        for task_id in ids:
            render.cleanup_work(task_id)
            db.delete_task(task_id)
            self.events.emit("task_deleted", {"id": task_id})
        if ids:
            self.log("queue", f"已删除全部 {len(ids)} 条任务记录。")
        return len(ids)

    def remove_finished(self) -> int:
        ids = db.delete_tasks_by_status(["done", "failed", "canceled"])
        for task_id in ids:
            render.cleanup_work(task_id)
            self.events.emit("task_deleted", {"id": task_id})
        return len(ids)
