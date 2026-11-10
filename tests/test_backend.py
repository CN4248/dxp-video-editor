"""CineCut 后端集成测试。

运行：python3 -m unittest discover -s tests -v
依赖本机 ffmpeg/ffprobe；测试媒体在 tests/.testdata 内现场生成。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TMP = ROOT / "tests" / ".testdata"
if TMP.exists():
    shutil.rmtree(TMP)
for name in ("input", "output", "data"):
    (TMP / name).mkdir(parents=True, exist_ok=True)

os.environ["INPUT_ROOT"] = str(TMP / "input")
os.environ["OUTPUT_ROOT"] = str(TMP / "output")
os.environ["DATA_DIR"] = str(TMP / "data")
os.environ["PORT"] = "39873"
os.environ["FONT_FILE"] = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"
sys.path.insert(0, str(ROOT))

from app import config, db, media, project, render, server  # noqa: E402
from app.tasks import Events, TaskManager, task_public  # noqa: E402

FFMPEG = config.FFMPEG


def run(cmd: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise AssertionError(f"命令失败：{' '.join(cmd)}\n{proc.stderr[-3000:]}")
    return proc


def make_fixtures() -> None:
    input_dir = TMP / "input"
    if (input_dir / "clip_a.mp4").exists():
        return
    run([
        FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=4",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-shortest",
        str(input_dir / "clip_a.mp4"),
    ])
    run([
        FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=360x640:rate=30:duration=2",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-pix_fmt", "yuv420p", "-an",
        str(input_dir / "clip_b.mp4"),
    ])
    run([
        FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "smptebars=size=320x240:duration=1",
        "-frames:v", "1", str(input_dir / "overlay.png"),
    ])
    run([
        FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=6",
        "-c:a", "libmp3lame", "-b:a", "96k", str(input_dir / "bgm.mp3"),
    ])


def probe(path: Path) -> dict:
    proc = subprocess.run([
        config.FFPROBE, "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ], capture_output=True, text=True)
    return json.loads(proc.stdout or "{}")


class ProjectTests(unittest.TestCase):
    def test_sanitize_and_duration(self) -> None:
        doc = project.sanitize_doc({
            "name": "  ",
            "canvas": {"width": 99999, "height": 777, "fps": 999},
            "main": [{"src": "clip_a.mp4", "in": -5, "out": 5, "speed": 2}],
            "overlays": [{"src": "../etc/passwd", "kind": "image"}],
            "texts": [{"text": "hi", "size": 9999, "color": "red"}],
        })
        self.assertEqual(doc["canvas"], {"width": 8192, "height": 776, "fps": 120})
        self.assertEqual(doc["main"][0]["in"], 0)
        self.assertEqual(doc["main"][0]["speed"], 2)
        self.assertAlmostEqual(project.project_duration(doc), 2.5)
        self.assertEqual(doc["overlays"], [])
        self.assertEqual(doc["texts"][0]["color"], "#ffffff")
        self.assertEqual(doc["texts"][0]["size"], 400)
        self.assertTrue(doc["name"])

    def test_grade_mosaic_and_audio_defaults(self) -> None:
        doc = project.sanitize_doc({
            "name": "调色与遮挡",
            "main": [{
                "src": "clip_a.mp4", "in": 0, "out": 1, "mosaic": True,
                "mosaicMode": "blur", "mosaicBlock": 999, "mosaicX": -1,
            }],
            "audios": [{"src": "bgm.mp3", "start": 0, "duration": 1, "muted": True,
                        "linkedOverlayId": "o_linked"}],
            "grade": {"temperature": 9, "vignette": -2},
        })
        clip = doc["main"][0]
        self.assertTrue(clip["mosaic"])
        self.assertEqual(clip["mosaicMode"], "blur")
        self.assertEqual(clip["mosaicBlock"], 64)
        self.assertEqual(clip["mosaicX"], 0)
        self.assertEqual(doc["grade"]["temperature"], 1)
        self.assertEqual(doc["grade"]["vignette"], 0)
        self.assertTrue(doc["audios"][0]["muted"])
        self.assertEqual(doc["audios"][0]["linkedOverlayId"], "o_linked")
        bogus = project.sanitize_doc({"main": [{
            "src": "clip_a.mp4", "in": 0, "out": 1, "mosaicMode": "rainbow",
        }]})
        self.assertEqual(bogus["main"][0]["mosaicMode"], "pixel")

    def test_export_options(self) -> None:
        doc = project.default_doc("测试")
        export = project.export_options({"filename": "../../evil", "subdir": "../a/b", "crf": 99, "preset": "bogus"}, doc)
        self.assertEqual(export["filename"], "evil.mp4")
        self.assertEqual(export["subdir"], "a/b")
        self.assertEqual(export["crf"], 40)
        self.assertEqual(export["preset"], "medium")
        self.assertFalse(export["overwrite"])

    def test_custom_tracks_and_assignment(self) -> None:
        doc = project.sanitize_doc({
            "name": "轨道测试",
            "canvas": {"width": 640, "height": 360},
            "tracks": [
                {"id": "trk_vtop", "type": "video", "name": "画中画"},
                {"id": "trk_vbase", "type": "video", "name": "底图"},
                {"id": "trk_audio", "type": "audio", "name": "对白"},
                {"id": "trk_text", "type": "text", "name": "标题"},
            ],
            "overlays": [
                {"src": "overlay.png", "kind": "image", "start": 0, "duration": 2,
                 "trackId": "trk_vtop"},
                {"src": "overlay.png", "kind": "image", "start": 0, "duration": 2,
                 "trackId": "trk_vbase"},
                {"src": "overlay.png", "kind": "image", "start": 0, "duration": 2,
                 "trackId": "trk_missing"},
            ],
            "audios": [{"src": "bgm.mp3", "start": 0, "duration": 2, "trackId": "trk_audio"}],
            "texts": [{"text": "标题", "start": 0, "duration": 2, "trackId": "trk_text"}],
        })
        self.assertEqual(doc["name"], "轨道测试")
        self.assertEqual([track["name"] for track in doc["tracks"]],
                         ["画中画", "底图", "对白", "标题"])
        self.assertEqual(doc["overlays"][0]["trackId"], "trk_vtop")
        self.assertEqual(doc["overlays"][1]["trackId"], "trk_vbase")
        self.assertEqual(doc["overlays"][2]["trackId"], "trk_vtop")
        self.assertEqual(doc["audios"][0]["trackId"], "trk_audio")
        self.assertEqual(doc["texts"][0]["trackId"], "trk_text")
        ordered = render._ordered_by_track(doc["overlays"], "video", doc)
        self.assertEqual(ordered[0]["trackId"], "trk_vbase")

    def test_default_tracks_exist(self) -> None:
        doc = project.sanitize_doc({"name": "默认轨道"})
        self.assertEqual([track["type"] for track in doc["tracks"]], ["video", "audio", "text"])

    def test_export_formats_and_extensions(self) -> None:
        doc = project.default_doc("格式")
        for key, ext in [("mp4", ".mp4"), ("mkv", ".mkv"), ("avi", ".avi"),
                         ("gif", ".gif"), ("mp3", ".mp3"), ("flac", ".flac"),
                         ("wav", ".wav"), ("ogg", ".ogg"), ("mov", ".mov"),
                         ("webm", ".webm"), ("m4a", ".m4a")]:
            export = project.export_options({"format": key, "filename": "成片.mp4"}, doc)
            self.assertEqual(export["format"], key)
            self.assertTrue(export["filename"].endswith(ext), export["filename"])
        self.assertEqual(project.export_options({"format": "bogus"}, doc)["format"], "mp4")
        self.assertEqual(project.export_options({"format": "mp3", "filename": "only-name"}, doc)["filename"],
                         "only-name.mp3")

    def test_unique_names(self) -> None:
        folder = TMP / "names"
        folder.mkdir(exist_ok=True)
        (folder / "movie.mp4").write_text("x")
        target = media.unique_path(folder, "movie.mp4")
        self.assertEqual(target.name, "movie (1).mp4")
        target.write_text("y")
        self.assertEqual(media.unique_path(folder, "movie.mp4").name, "movie (2).mp4")


class RenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        make_fixtures()
        config.ensure_dirs()
        db.init()

    def test_full_render_pipeline(self) -> None:
        doc = project.sanitize_doc({
            "name": "集成测试",
            "canvas": {"width": 640, "height": 360, "fps": 30},
            "main": [
                {"src": "clip_a.mp4", "in": 0.5, "out": 3.5, "speed": 2, "rotate": 90,
                 "scale": 0.8, "volume": 0.8, "fadeIn": 0.2, "fadeOut": 0.2},
                {"src": "clip_b.mp4", "in": 0, "out": 2, "fit": "cover"},
            ],
            "overlays": [
                {"kind": "image", "src": "overlay.png", "start": 0.5, "duration": 1.5,
                 "scale": 0.25, "x": 0.2, "y": 0.2, "opacity": 0.8, "rotate": 10},
            ],
            "audios": [
                {"src": "bgm.mp3", "start": 0.5, "duration": 2, "volume": 0.4, "fadeIn": 0.3},
            ],
            "texts": [
                {"text": "测试字幕\n第二行", "start": 0.2, "duration": 2, "size": 30, "bg": True},
            ],
            "grade": {"brightness": 0.05, "contrast": 1.1, "saturation": 1.2},
        })
        task_id = "unittest_full"
        plan = render.plan_render(doc, task_id)
        self.assertTrue(plan.needs_final)
        self.assertEqual(len(plan.segments), 2)
        self.assertAlmostEqual(plan.duration, 3.5, places=2)

        work = config.WORK_DIR / task_id
        work.mkdir(parents=True, exist_ok=True)
        export = {"crf": 24, "preset": "ultrafast", "audioBitrate": 128}
        for seg in plan.segments:
            cmd = render.build_segment_cmd(seg.clip, plan.doc, seg.duration, seg.path,
                                           14, "ultrafast", False, seg.has_audio)
            run(cmd)
            self.assertGreater(seg.path.stat().st_size, 1000)

        base = work / "base.mp4"
        run(render.build_concat_cmd([s.path for s in plan.segments], work, base))
        final = work / "final.mp4"
        run(render.build_final_cmd(plan.doc, base, work, final, export))
        info = probe(final)
        video = next(stream for stream in info["streams"] if stream["codec_type"] == "video")
        self.assertEqual((video["width"], video["height"]), (640, 360))
        self.assertTrue(any(stream["codec_type"] == "audio" for stream in info["streams"]))
        duration = float(info["format"]["duration"])
        self.assertGreater(duration, 3.3)
        self.assertLess(duration, 3.9)

    def test_grade_and_mosaic_modes_commands(self) -> None:
        base = {
            "name": "滤镜与遮挡命令",
            "canvas": {"width": 640, "height": 360, "fps": 24},
            "grade": {"brightness": 0.04, "contrast": 1.1, "saturation": 1.2,
                      "hue": 6, "temperature": 0.35, "vignette": 0.6},
            "main": [{
                "src": "clip_a.mp4", "in": 0, "out": 1, "mosaic": True,
                "mosaicMode": "blur", "mosaicBlock": 24,
                "mosaicX": 0.2, "mosaicY": 0.2, "mosaicW": 0.5, "mosaicH": 0.5,
            }],
        }
        doc = project.sanitize_doc(base)
        plan = render.plan_render(doc, "unittest_mosaic_blur")
        seg = plan.segments[0]
        cmd = render.build_segment_cmd(seg.clip, plan.doc, seg.duration, seg.path,
                                       30, "ultrafast", True, seg.has_audio)
        text = " ".join(cmd)
        self.assertIn("colorbalance=", text)
        self.assertIn("vignette=angle=", text)
        self.assertIn("gblur=sigma=", text)
        run(cmd)
        self.assertGreater(seg.path.stat().st_size, 1000)

        black = project.sanitize_doc(dict(base, main=[{
            "src": "clip_a.mp4", "in": 0, "out": 1, "mosaic": True,
            "mosaicMode": "black", "mosaicX": 0.1, "mosaicY": 0.1,
            "mosaicW": 0.3, "mosaicH": 0.3,
        }]))
        black_plan = render.plan_render(black, "unittest_mosaic_black")
        black_seg = black_plan.segments[0]
        black_cmd = render.build_segment_cmd(black_seg.clip, black_plan.doc, black_seg.duration,
                                             black_seg.path, 30, "ultrafast", False,
                                             black_seg.has_audio)
        self.assertIn("drawbox=", " ".join(black_cmd))

        pixel = project.sanitize_doc(dict(base, main=[{
            "src": "clip_a.mp4", "in": 0, "out": 1, "mosaic": True,
            "mosaicMode": "pixel", "mosaicBlock": 12,
        }]))
        pixel_plan = render.plan_render(pixel, "unittest_mosaic_pixel")
        pixel_seg = pixel_plan.segments[0]
        pixel_cmd = render.build_segment_cmd(pixel_seg.clip, pixel_plan.doc, pixel_seg.duration,
                                             pixel_seg.path, 30, "ultrafast", False,
                                             pixel_seg.has_audio)
        self.assertIn("flags=neighbor", " ".join(pixel_cmd))

    def test_no_audio_source_gets_silent_track(self) -> None:
        doc = project.sanitize_doc({
            "name": "静音测试",
            "canvas": {"width": 360, "height": 640, "fps": 24},
            "main": [{"src": "clip_b.mp4", "in": 0, "out": 1.5, "fit": "contain"}],
        })
        plan = render.plan_render(doc, "unittest_silent")
        self.assertFalse(plan.needs_final)
        seg = plan.segments[0]
        run(render.build_segment_cmd(seg.clip, plan.doc, seg.duration, seg.path,
                                     28, "ultrafast", True, seg.has_audio))
        info = probe(seg.path)
        self.assertTrue(any(stream["codec_type"] == "audio" for stream in info["streams"]))
        video = next(stream for stream in info["streams"] if stream["codec_type"] == "video")
        self.assertEqual((video["width"], video["height"]), (360, 640))


class BuiltinManifestTests(unittest.TestCase):
    def test_manifest_assets_and_ids(self) -> None:
        root = ROOT / "app" / "static" / "builtin"
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        for category in ("filters", "subtitles", "stickers", "audio", "effects"):
            self.assertIn(category, manifest)
        self.assertGreaterEqual(len(manifest["filters"]), 18)
        self.assertGreaterEqual(len(manifest["subtitles"]), 12)
        self.assertGreaterEqual(len(manifest["stickers"]), 14)
        self.assertGreaterEqual(len(manifest["audio"]), 12)
        self.assertGreaterEqual(len(manifest["effects"]), 7)
        for category, items in manifest.items():
            ids = [item["id"] for item in items]
            self.assertEqual(len(ids), len(set(ids)), f"{category} 存在重复 id")
        for item in manifest["filters"]:
            grade = item["grade"]
            for key in ("brightness", "contrast", "saturation", "hue"):
                self.assertIn(key, grade)
            self.assertIn("temperature", grade)
            self.assertIn("vignette", grade)
        for item in manifest["stickers"]:
            self.assertTrue((root / item["file"]).is_file(), item["file"])
        for item in manifest["audio"]:
            self.assertTrue((root / item["file"]).is_file(), item["file"])
            self.assertGreater(item["duration"], 0)
        for item in manifest["effects"]:
            self.assertIn(item["mode"], {"pixel", "blur", "black"})
            self.assertGreaterEqual(item["block"], 2)

    def test_builtin_media_resolves(self) -> None:
        config.ensure_dirs()
        for rel in ("builtin/stickers/new.png", "builtin/audio/click.wav"):
            path = media.resolve_source(rel)
            self.assertTrue(path.is_file(), rel)

class VersionTests(unittest.TestCase):
    def test_version_files_consistent(self) -> None:
        version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
        self.assertEqual(config.APP_VERSION, version)
        compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        env_example = (ROOT / ".env.example").read_text(encoding="utf-8")
        index = (ROOT / "app" / "static" / "index.html").read_text(encoding="utf-8")
        self.assertIn(f"APP_VERSION:-{version}", compose)
        self.assertIn(f"image: cinecut:${{APP_VERSION:-{version}}}", compose)
        self.assertIn(f"ARG APP_VERSION={version}", dockerfile)
        self.assertIn(f"APP_VERSION={version}", env_example)
        self.assertIn(f'<span id="versionText">v{version}</span>', index)
        proc = subprocess.run([sys.executable, str(ROOT / "scripts" / "check_version.py")],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)


class CrossDeviceTests(unittest.TestCase):
    def test_finalize_across_devices(self) -> None:
        target_root = Path("/dev/shm/cinecut-unittest")
        if not target_root.parent.is_dir():
            self.skipTest("没有 /dev/shm")
        target_root.mkdir(parents=True, exist_ok=True)
        source = config.DATA_DIR / "cross-device.mp4"
        source.write_bytes(b"cross-device-test")
        old_output = config.OUTPUT_ROOT
        config.OUTPUT_ROOT = target_root
        try:
            if os.stat(source).st_dev == os.stat(target_root).st_dev:
                self.skipTest("测试目录与 /dev/shm 在同一设备，无法制造 EXDEV")
            result = render.finalize_output(source, {
                "filename": "跨设备.mp4", "overwrite": False,
                "subdir": "", "crf": 20, "preset": "veryfast",
            })
            self.assertTrue(result.is_file())
            self.assertEqual(result.read_bytes(), b"cross-device-test")
            self.assertFalse(source.exists())

            source.write_bytes(b"overwrite")
            result2 = render.finalize_output(source, {
                "filename": "跨设备.mp4", "overwrite": True,
                "subdir": "", "crf": 20, "preset": "veryfast",
            })
            self.assertEqual(result2.read_bytes(), b"overwrite")
            self.assertFalse(source.exists())
        finally:
            config.OUTPUT_ROOT = old_output
            shutil.rmtree(target_root, ignore_errors=True)


class TaskManagerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        make_fixtures()
        config.ensure_dirs()
        db.init()
        cls.events = Events()
        cls.manager = TaskManager(cls.events)
        cls.manager.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.manager.shutdown()
        time.sleep(0.5)

    def wait_status(self, task_id: str, statuses: set[str], timeout: float = 90) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            task = db.get_task(task_id, with_doc=False)
            if task and task["status"] in statuses:
                return task
            time.sleep(0.25)
        raise AssertionError(f"任务未进入 {statuses}：{db.get_task(task_id, with_doc=False)}")

    def test_direct_render_and_naming(self) -> None:
        doc = project.sanitize_doc({
            "name": "队列命名",
            "canvas": {"width": 320, "height": 180, "fps": 24},
            "main": [{"src": "clip_a.mp4", "in": 0, "out": 1}],
        })
        export = {"filename": "queue-name.mp4", "subdir": "auto", "overwrite": False,
                  "crf": 28, "preset": "ultrafast", "audioBitrate": 96}
        first = self.manager.enqueue(None, "命名一", doc, export)
        task = self.wait_status(first["id"], {"done", "failed"})
        self.assertEqual(task["status"], "done", task.get("error"))
        self.assertEqual(task["output"], "auto/queue-name.mp4")
        second = self.manager.enqueue(None, "命名二", doc, export)
        task2 = self.wait_status(second["id"], {"done", "failed"})
        self.assertEqual(task2["status"], "done", task2.get("error"))
        self.assertEqual(task2["output"], "auto/queue-name (1).mp4")
        self.assertTrue((config.OUTPUT_ROOT / task2["output"]).is_file())
        self.assertFalse((config.WORK_DIR / first["id"]).exists())

    def test_audio_and_gif_export_tasks(self) -> None:
        doc = project.sanitize_doc({
            "name": "格式任务",
            "canvas": {"width": 320, "height": 180, "fps": 24},
            "main": [{"src": "clip_a.mp4", "in": 0, "out": 1}],
        })
        audio_task = self.manager.enqueue(None, "MP3", doc, {
            "format": "mp3", "filename": "format-audio", "crf": 28, "preset": "ultrafast",
        })
        audio = self.wait_status(audio_task["id"], {"done", "failed"})
        self.assertEqual(audio["status"], "done", audio.get("error"))
        self.assertEqual(audio["output"], "format-audio.mp3")
        audio_info = probe(config.OUTPUT_ROOT / audio["output"])
        self.assertEqual({stream["codec_type"] for stream in audio_info["streams"]}, {"audio"})
        self.assertEqual(audio_info["streams"][0]["codec_name"], "mp3")

        gif_task = self.manager.enqueue(None, "GIF", doc, {
            "format": "gif", "filename": "format-gif", "crf": 28, "preset": "ultrafast",
        })
        gif = self.wait_status(gif_task["id"], {"done", "failed"})
        self.assertEqual(gif["status"], "done", gif.get("error"))
        self.assertEqual(gif["output"], "format-gif.gif")
        self.assertTrue((config.OUTPUT_ROOT / gif["output"]).is_file())

    def test_pause_resume_and_stop(self) -> None:
        template = {"src": "clip_a.mp4", "in": 0, "out": 4, "speed": 1}
        doc = project.sanitize_doc({
            "name": "暂停测试",
            "canvas": {"width": 320, "height": 180, "fps": 24},
            "main": [dict(template, id=f"m_pause_{i}") for i in range(5)],
        })
        task = self.manager.enqueue(None, "暂停测试", doc, {
            "filename": "pause-test.mp4", "crf": 28, "preset": "veryslow",
        })
        self.wait_status(task["id"], {"running"}, timeout=15)
        time.sleep(1.2)
        ok, _ = self.manager.pause(task["id"])
        self.assertTrue(ok)
        paused = self.wait_status(task["id"], {"paused"})
        progress = paused["progress"]
        time.sleep(1.2)
        still = db.get_task(task["id"], with_doc=False)
        self.assertAlmostEqual(still["progress"], progress, delta=0.01)
        ok, _ = self.manager.resume(task["id"])
        self.assertTrue(ok)
        self.wait_status(task["id"], {"running"}, timeout=10)
        ok, _ = self.manager.stop(task["id"])
        self.assertTrue(ok)
        stopped = self.wait_status(task["id"], {"canceled"}, timeout=10)
        self.assertEqual(stopped["status"], "canceled")

    def test_clear_all_tasks(self) -> None:
        doc = project.sanitize_doc({
            "name": "全部清理", "canvas": {"width": 320, "height": 180},
            "main": [{"src": "clip_a.mp4", "in": 0, "out": 1}],
        })
        db.create_task(None, "清理一", doc, {"filename": "clean-a.mp4"})
        done = db.create_task(None, "清理二", doc, {"filename": "clean-b.mp4"})
        db.update_task(done["id"], status="done", progress=100.0, output="clean-b.mp4")
        removed = self.manager.clear_all()
        self.assertGreaterEqual(removed, 2)
        self.assertEqual(db.list_tasks(), [])
        self.assertFalse((config.WORK_DIR / done["id"]).exists())

    def test_interrupted_task_marked_paused(self) -> None:
        doc = project.sanitize_doc({
            "name": "中断标记", "canvas": {"width": 320, "height": 180},
            "main": [{"src": "clip_a.mp4", "in": 0, "out": 1}],
        })
        task = db.create_task(None, "中断标记", doc, {"filename": "x.mp4"})
        db.update_task(task["id"], status="running", progress=42.0)
        interrupted = db.mark_interrupted_tasks()
        self.assertIn(task["id"], interrupted)
        row = db.get_task(task["id"], with_doc=False)
        self.assertEqual(row["status"], "paused")
        self.assertIn("服务重启", row["message"])
        db.delete_task(task["id"])


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        make_fixtures()
        cls.httpd = server.create_server()
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{config.PORT}"
        time.sleep(0.4)
        with urllib.request.urlopen(cls.base + "/api/projects", timeout=10) as resp:
            cls.project_id = json.load(resp)["projects"][0]["id"]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.manager.shutdown()
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def get(self, path: str) -> tuple[int, bytes, dict]:
        request = urllib.request.Request(self.base + path)
        try:
            with urllib.request.urlopen(request, timeout=30) as resp:
                return resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read(), dict(exc.headers)

    def post(self, path: str, data: dict | bytes) -> tuple[int, dict]:
        body = data if isinstance(data, bytes) else json.dumps(data).encode()
        request = urllib.request.Request(self.base + path, data=body, method="POST",
                                         headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as resp:
                return resp.status, json.load(resp)
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read() or b"{}")

    def test_config_files_and_media(self) -> None:
        status, body, _ = self.get("/api/config")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["config"]["app"], "CineCut")
        status, body, _ = self.get("/builtin/manifest.json")
        self.assertEqual(status, 200)
        manifest = json.loads(body)
        self.assertGreaterEqual(len(manifest["filters"]), 18)
        status, body, headers = self.get("/builtin/stickers/new.png")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "image/png")
        status, body, _ = self.get("/api/files?path=")
        self.assertEqual(status, 200)
        listing = json.loads(body)
        self.assertTrue(any(entry["name"] == "clip_a.mp4" for entry in listing["entries"]))
        status, body, _ = self.get("/api/files?path=../")
        self.assertEqual(status, 400)
        status, body, headers = self.get("/api/media?path=clip_a.mp4")
        self.assertEqual(status, 200)
        self.assertGreater(int(headers.get("Content-Length", 0)), 1000)

    def test_range_request(self) -> None:
        request = urllib.request.Request(self.base + "/api/media?path=clip_a.mp4",
                                         headers={"Range": "bytes=0-99"})
        with urllib.request.urlopen(request, timeout=10) as resp:
            self.assertEqual(resp.status, 206)
            self.assertEqual(len(resp.read()), 100)
            self.assertIn("bytes 0-99/", resp.headers.get("Content-Range", ""))

    def test_render_export_and_output(self) -> None:
        doc = project.sanitize_doc({
            "name": "接口导出",
            "canvas": {"width": 320, "height": 180, "fps": 24},
            "main": [{"src": "clip_a.mp4", "in": 0, "out": 1}],
        })
        status, payload = self.post("/api/render", {
            "projectId": self.project_id, "doc": doc,
            "export": {"filename": "api-export.mp4", "preset": "ultrafast", "crf": 28},
        })
        self.assertEqual(status, 201)
        task_id = payload["task"]["id"]
        deadline = time.time() + 60
        task = None
        while time.time() < deadline:
            _, body, _ = self.get(f"/api/tasks/{task_id}")
            task = json.loads(body)["task"]
            if task["status"] in {"done", "failed"}:
                break
            time.sleep(0.4)
        self.assertEqual(task["status"], "done", task.get("error"))
        status, body, _ = self.get("/api/output?path=" + task["output"])
        self.assertEqual(status, 200)
        self.assertGreater(len(body), 1000)

    def test_project_manual_save_export_import(self) -> None:
        _, body, _ = self.get(f"/api/projects/{self.project_id}")
        doc = json.loads(body)["project"]["doc"]
        doc["name"] = "另存为测试"
        doc["texts"] = [{
            "id": "t_copy", "text": "工程文件", "start": 0, "duration": 1,
            "x": 0.5, "y": 0.5, "size": 32, "color": "#ffffff",
            "bg": False, "bold": True,
        }]
        status, payload = self.post("/api/projects", {"name": "另存为测试", "doc": doc})
        self.assertEqual(status, 201)
        copy_id = payload["project"]["id"]
        self.assertNotEqual(copy_id, self.project_id)
        snapshot = config.PROJECT_DIR / f"{copy_id}.cinecut.json"
        self.assertTrue(snapshot.is_file())
        saved = json.loads(snapshot.read_text(encoding="utf-8"))
        self.assertEqual(saved["format"], "cinecut-project")
        self.assertEqual(saved["project"]["doc"]["texts"][0]["text"], "工程文件")

        status, export_body, headers = self.get(f"/api/projects/{copy_id}/export")
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers.get("Content-Disposition", ""))
        exported = json.loads(export_body)
        self.assertEqual(exported["project"]["name"], "另存为测试")

        exported["project"]["name"] = "导入测试"
        status, imported = self.post("/api/projects/import", exported)
        self.assertEqual(status, 201)
        self.assertEqual(imported["project"]["name"], "导入测试")
        self.assertTrue((config.PROJECT_DIR / f"{imported['project']['id']}.cinecut.json").is_file())

        status, saved_resp = self.post(f"/api/projects/{copy_id}/save", {"name": "手动保存", "doc": doc})
        self.assertEqual(status, 200)
        self.assertEqual(saved_resp["name"], "手动保存")

    def test_upload_and_traversal(self) -> None:
        image = (TMP / "input" / "overlay.png").read_bytes()
        request = urllib.request.Request(
            self.base + "/api/upload?dir=uploads&name=upload-test.png",
            data=image, method="POST", headers={"Content-Type": "application/octet-stream"})
        with urllib.request.urlopen(request, timeout=20) as resp:
            payload = json.load(resp)
            self.assertEqual(resp.status, 201)
        self.assertTrue((config.INPUT_ROOT / payload["path"]).is_file())
        status, _ = self.post("/api/render", {"doc": {}})
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
