#!/usr/bin/env python3
"""生成/刷新内置素材（贴图 PNG / 音效 WAV）并写出 manifest.json。

开发期工具，运行一次即可；产物已提交仓库，运行容器不需要 PIL/numpy。
依赖：Pillow（仅本脚本）+ 系统文泉驿字体。

说明：脚本生成 1.2.0 新增的 14 张贴图与 12 个音效，并保留仓库中已有的
7 张旧贴图/4 个旧音效；manifest 始终按全量清单重写。

    python3 scripts/gen_builtin_assets.py
"""
from __future__ import annotations

import json
import math
import random
import struct
import wave
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BUILTIN = ROOT / "app" / "static" / "builtin"
STICKER_DIR = BUILTIN / "stickers"
AUDIO_DIR = BUILTIN / "audio"
FONT_PATH = "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"
SR = 48000

INK = "#0b1220"
WHITE = "#ffffff"
RED = "#ef4444"
DARK_RED = "#b91c1c"
AMBER = "#f59e0b"
GOLD = "#fbbf24"
BLUE = "#2563eb"
CYAN = "#22d3ee"
GREEN = "#10b981"
PURPLE = "#8b5cf6"
ORANGE = "#f97316"
SLATE = "#1e293b"


def font(size: int, index: int = 0) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(FONT_PATH, size, index=index)
    except OSError:
        return ImageFont.load_default()


def label(draw: ImageDraw.ImageDraw, xy, text, size, fill, anchor="mm", stroke=0,
          stroke_fill=(0, 0, 0, 0)) -> None:
    draw.text(xy, text, font=font(size), fill=fill, anchor=anchor,
              stroke_width=stroke, stroke_fill=stroke_fill)


def rounded(img: Image.Image, box, radius, fill, outline=None, width=1) -> None:
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def shadowed(img: Image.Image, box, radius, fill, blur=10, alpha=110) -> None:
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    x0, y0, x1, y1 = box
    sdraw.rounded_rectangle((x0 + 4, y0 + 7, x1 + 4, y1 + 7), radius=radius,
                            fill=(0, 0, 0, alpha))
    shadow = shadow.filter(ImageFilter.GaussianBlur(blur))
    img.alpha_composite(shadow)
    rounded(img, box, radius, fill)


def heart(draw: ImageDraw.ImageDraw, cx: float, cy: float, size: float, fill) -> None:
    r = size * 0.235
    lobe_y = cy - size * 0.18
    draw.ellipse((cx - size * 0.24 - r, lobe_y - r, cx - size * 0.24 + r,
                  lobe_y + r), fill=fill)
    draw.ellipse((cx + size * 0.24 - r, lobe_y - r, cx + size * 0.24 + r,
                  lobe_y + r), fill=fill)
    draw.polygon([(cx - size * 0.47, cy - size * 0.08),
                  (cx + size * 0.47, cy - size * 0.08),
                  (cx, cy + size * 0.5)], fill=fill)


def star_points(cx: float, cy: float, outer: float, inner: float, points: int = 5):
    result = []
    for index in range(points * 2):
        angle = -math.pi / 2 + index * math.pi / points
        radius = outer if index % 2 == 0 else inner
        result.append((cx + math.cos(angle) * radius, cy + math.sin(angle) * radius))
    return result


# ---------------------------------------------------------------- 贴图

def sticker_like() -> None:
    img = Image.new("RGBA", (460, 170), (0, 0, 0, 0))
    shadowed(img, (15, 18, 445, 155), 34, (239, 68, 68, 255))
    draw = ImageDraw.Draw(img)
    heart(draw, 92, 84, 76, (255, 255, 255, 245))
    label(draw, (295, 86), "点赞", 62, WHITE)
    img.save(STICKER_DIR / "like.png")


def sticker_live() -> None:
    img = Image.new("RGBA", (520, 170), (0, 0, 0, 0))
    shadowed(img, (12, 18, 508, 155), 26, (12, 18, 28, 236), blur=8)
    rounded(img, (12, 18, 508, 155), 26, (12, 18, 28, 236), RED, 5)
    draw = ImageDraw.Draw(img)
    draw.ellipse((34, 66, 76, 108), fill=RED)
    label(draw, (150, 84), "LIVE", 58, RED, stroke=1, stroke_fill=(0, 0, 0, 120))
    label(draw, (380, 87), "直播中", 44, WHITE)
    img.save(STICKER_DIR / "live.png")


def sticker_hot() -> None:
    img = Image.new("RGBA", (480, 170), (0, 0, 0, 0))
    shadowed(img, (14, 18, 466, 155), 34, (249, 115, 22, 255))
    draw = ImageDraw.Draw(img)
    # 火焰
    draw.polygon([(76, 130), (48, 96), (68, 84), (58, 48), (96, 74), (104, 46),
                  (126, 92), (112, 110), (118, 130)], fill=(255, 240, 190, 255))
    label(draw, (310, 86), "热播中", 60, WHITE)
    img.save(STICKER_DIR / "hot.png")


def sticker_hd() -> None:
    img = Image.new("RGBA", (400, 200), (0, 0, 0, 0))
    shadowed(img, (14, 20, 386, 182), 24, (15, 23, 42, 240), blur=8)
    rounded(img, (14, 20, 386, 182), 24, (15, 23, 42, 240), GOLD, 5)
    draw = ImageDraw.Draw(img)
    label(draw, (145, 101), "4K", 92, GOLD)
    draw.line((238, 55, 238, 148), fill=(251, 191, 36, 130), width=3)
    label(draw, (310, 92), "HDR", 36, WHITE)
    label(draw, (310, 132), "ULTRA HD", 19, (148, 163, 184, 255))
    img.save(STICKER_DIR / "hd.png")


def sticker_follow() -> None:
    img = Image.new("RGBA", (500, 170), (0, 0, 0, 0))
    shadowed(img, (14, 18, 486, 155), 32, (37, 99, 235, 255))
    draw = ImageDraw.Draw(img)
    draw.ellipse((42, 48, 116, 122), outline=WHITE, width=7)
    draw.line((79, 64, 79, 106), fill=WHITE, width=7)
    draw.line((58, 85, 100, 85), fill=WHITE, width=7)
    label(draw, (306, 87), "关注", 64, WHITE)
    img.save(STICKER_DIR / "follow.png")


def sticker_share() -> None:
    img = Image.new("RGBA", (480, 170), (0, 0, 0, 0))
    shadowed(img, (14, 18, 466, 155), 32, (13, 148, 136, 255))
    draw = ImageDraw.Draw(img)
    draw.polygon([(52, 92), (104, 58), (104, 126)], fill=WHITE)
    draw.line((100, 92, 172, 92), fill=WHITE, width=12)
    label(draw, (320, 87), "分享", 62, WHITE)
    img.save(STICKER_DIR / "share.png")


def sticker_top1() -> None:
    img = Image.new("RGBA", (440, 220), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.polygon([(30, 44), (410, 44), (386, 116), (410, 188), (30, 188), (54, 116)],
                 fill=(251, 191, 36, 255))
    draw.polygon([(30, 44), (410, 44), (386, 116), (410, 188), (30, 188), (54, 116)],
                 outline=(146, 64, 14, 255), width=4)
    label(draw, (220, 116), "TOP 1", 74, (69, 39, 4, 255))
    img.save(STICKER_DIR / "top1.png")


def sticker_red_circle() -> None:
    img = Image.new("RGBA", (540, 430), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse((30, 30, 510, 410), outline=(239, 68, 68, 245), width=14)
    img.save(STICKER_DIR / "red_circle.png")


def sticker_underline() -> None:
    img = Image.new("RGBA", (640, 130), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    for offset, alpha, width in ((0, 210, 12), (9, 120, 6), (-8, 90, 5)):
        draw.line([(38, 78 + offset), (150, 62 + offset), (300, 74 + offset),
                   (450, 58 + offset), (596, 70 + offset)],
                  fill=(251, 191, 36, alpha), width=width, joint="curve")
    img.save(STICKER_DIR / "underline.png")


def sticker_arrow_white() -> None:
    img = Image.new("RGBA", (520, 260), (0, 0, 0, 0))
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    pts = [(40, 130), (330, 130), (330, 72), (488, 130), (330, 188), (330, 130)]
    sdraw.polygon([(x + 6, y + 9) for x, y in pts], fill=(0, 0, 0, 120))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(7)))
    draw = ImageDraw.Draw(img)
    draw.polygon(pts, fill=(255, 255, 255, 245), outline=(15, 23, 42, 200))
    img.save(STICKER_DIR / "arrow_white.png")


def sticker_speech() -> None:
    img = Image.new("RGBA", (560, 340), (0, 0, 0, 0))
    shadowed(img, (30, 30, 530, 260), 34, (255, 255, 255, 246), blur=12)
    draw = ImageDraw.Draw(img)
    draw.polygon([(120, 250), (150, 318), (208, 252)], fill=(255, 255, 255, 246))
    label(draw, (280, 142), "说点什么", 54, (15, 23, 42, 255))
    img.save(STICKER_DIR / "speech.png")


def sticker_bang() -> None:
    img = Image.new("RGBA", (330, 430), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx, cy = 165, 200
    pts = []
    for index in range(24):
        angle = -math.pi / 2 + index * math.pi / 12
        radius = 150 if index % 2 == 0 else 96
        pts.append((cx + math.cos(angle) * radius, cy + math.sin(angle) * radius))
    draw.polygon(pts, fill=(251, 191, 36, 255), outline=(180, 83, 9, 255))
    label(draw, (cx, cy + 4), "!", 190, (185, 28, 28, 255))
    img.save(STICKER_DIR / "bang.png")


def sticker_star() -> None:
    img = Image.new("RGBA", (320, 320), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.polygon(star_points(160, 160, 142, 60), fill=(251, 191, 36, 255),
                 outline=(180, 83, 9, 255))
    label(draw, (160, 166), "★", 40, (255, 255, 255, 180))
    img.save(STICKER_DIR / "star.png")


def sticker_lower_third_blue() -> None:
    img = Image.new("RGBA", (1000, 260), (0, 0, 0, 0))
    shadowed(img, (12, 18, 988, 242), 18, (15, 23, 42, 232), blur=10)
    draw = ImageDraw.Draw(img)
    draw.rectangle((12, 18, 34, 242), fill=(56, 189, 248, 255))
    draw.rectangle((34, 18, 420, 242), fill=(37, 99, 235, 170))
    label(draw, (72, 96), "姓名 NAME", 62, WHITE, anchor="lm")
    label(draw, (72, 176), "职位 / TITLE", 34, (125, 211, 252, 255), anchor="lm")
    img.save(STICKER_DIR / "lower_third_blue.png")


def make_stickers() -> None:
    STICKER_DIR.mkdir(parents=True, exist_ok=True)
    for fn in (sticker_like, sticker_live, sticker_hot, sticker_hd, sticker_follow,
               sticker_share, sticker_top1, sticker_red_circle, sticker_underline,
               sticker_arrow_white, sticker_speech, sticker_bang, sticker_star,
               sticker_lower_third_blue):
        fn()


# ---------------------------------------------------------------- 音效

def write_wav(name: str, samples: list[float]) -> float:
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    peak = max(1e-9, max(abs(x) for x in samples))
    scale = 0.92 / peak
    frames = b"".join(struct.pack("<h", int(max(-1.0, min(1.0, x * scale)) * 32767))
                      for x in samples)
    with wave.open(str(AUDIO_DIR / name), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes(frames)
    return round(len(samples) / SR, 3)


def env(t: float, attack: float, decay: float, power: float = 1.0) -> float:
    if t < 0:
        return 0.0
    if t < attack:
        return (t / attack) ** 1.5
    return max(0.0, (1.0 - (t - attack) / max(1e-6, decay))) ** power


def synth_pop() -> list[float]:
    out = []
    for index in range(int(SR * 0.18)):
        t = index / SR
        freq = 700 * math.exp(-t * 16) + 180
        out.append(math.sin(2 * math.pi * freq * t) * env(t, 0.004, 0.17, 2.0))
    return out


def synth_notification() -> list[float]:
    out = []
    for index in range(int(SR * 0.9)):
        t = index / SR
        value = 0.0
        if t < 0.32:
            value += math.sin(2 * math.pi * 880 * t) * env(t, 0.006, 0.3, 2.4)
            value += 0.35 * math.sin(2 * math.pi * 1760 * t) * env(t, 0.004, 0.22, 2.6)
        if 0.26 < t:
            tt = t - 0.26
            value += 0.7 * math.sin(2 * math.pi * 1174.7 * tt) * env(tt, 0.006, 0.42, 2.2)
            value += 0.2 * math.sin(2 * math.pi * 2349 * tt) * env(tt, 0.004, 0.3, 2.6)
        out.append(value)
    return out


def synth_swoosh() -> list[float]:
    random.seed(7)
    out = []
    low = 0.0
    for index in range(int(SR * 0.9)):
        t = index / SR
        cutoff = 0.03 + 0.5 * math.sin(math.pi * min(1.0, t / 0.9)) ** 2
        low += cutoff * (random.uniform(-1, 1) - low)
        out.append(low * math.sin(math.pi * min(1.0, t / 0.9)) ** 1.4 * 2.2)
    return out


def synth_riser() -> list[float]:
    random.seed(11)
    out = []
    duration = 2.0
    for index in range(int(SR * duration)):
        t = index / SR
        k = t / duration
        freq = 160 + 1300 * k ** 2
        tone = math.sin(2 * math.pi * freq * t) * 0.35
        noise = random.uniform(-1, 1) * 0.16
        out.append((tone + noise) * (k ** 1.8))
    return out


def synth_glitch() -> list[float]:
    random.seed(13)
    out = [0.0] * int(SR * 0.6)
    for start, length, freq in ((0.0, 0.09, 220), (0.12, 0.06, 880),
                                (0.22, 0.14, 110), (0.42, 0.05, 1320),
                                (0.5, 0.1, 330)):
        begin = int(start * SR)
        for index in range(int(length * SR)):
            tt = index / SR
            value = 1.0 if math.sin(2 * math.pi * freq * tt) >= 0 else -1.0
            out[begin + index] = value * env(tt, 0.002, length, 1.0) * 0.55
    return out


def synth_heartbeat() -> list[float]:
    out = []
    duration = 1.3
    for index in range(int(SR * duration)):
        t = index / SR
        value = 0.0
        for start, amp in ((0.0, 1.0), (0.32, 0.72)):
            tt = t - start
            if 0 <= tt < 0.26:
                freq = 62 * math.exp(-tt * 5) + 34
                value += math.sin(2 * math.pi * freq * tt) * env(tt, 0.008, 0.25, 1.7) * amp
        out.append(value)
    return out


def synth_typing() -> list[float]:
    random.seed(17)
    out = [0.0] * int(SR * 1.2)
    for start in (0.02, 0.16, 0.3, 0.48, 0.63, 0.82, 0.98):
        begin = int(start * SR)
        for index in range(int(0.035 * SR)):
            tt = index / SR
            out[begin + index] += random.uniform(-1, 1) * env(tt, 0.001, 0.035, 2.4) * 0.8
    return out


def synth_camera() -> list[float]:
    random.seed(19)
    out = []
    for index in range(int(SR * 0.35)):
        t = index / SR
        click = math.sin(2 * math.pi * 2400 * t) * env(t, 0.001, 0.035, 2.0)
        noise = random.uniform(-1, 1) * env(t, 0.002, 0.2, 2.2) * 0.3
        out.append((click + noise) * 0.8)
    return out


def synth_bell() -> list[float]:
    out = []
    for index in range(int(SR * 1.6)):
        t = index / SR
        value = (math.sin(2 * math.pi * 1046.5 * t)
                 + 0.45 * math.sin(2 * math.pi * 2093 * t)
                 + 0.2 * math.sin(2 * math.pi * 3139.5 * t))
        out.append(value * env(t, 0.004, 1.55, 2.6))
    return out


def synth_bass_drop() -> list[float]:
    out = []
    duration = 1.6
    for index in range(int(SR * duration)):
        t = index / SR
        freq = 150 * math.exp(-t * 2.4) + 34
        value = math.sin(2 * math.pi * freq * t)
        value += 0.25 * math.sin(2 * math.pi * freq * 2 * t)
        out.append(value * env(t, 0.01, duration, 1.6))
    return out


def synth_applause() -> list[float]:
    random.seed(23)
    out = [0.0] * int(SR * 2.0)
    for start in [random.uniform(0.0, 1.85) for _ in range(70)]:
        begin = int(start * SR)
        length = int(random.uniform(0.02, 0.06) * SR)
        for index in range(length):
            tt = index / SR
            out[begin + index] += (random.uniform(-1, 1) * env(tt, 0.001, 0.05, 2.0)
                                   * random.uniform(0.15, 0.5))
    for index in range(len(out)):
        out[index] *= min(1.0, index / (SR * 0.05)) * min(1.0, (len(out) - index) / (SR * 0.2))
    return out


def synth_countdown() -> list[float]:
    out = [0.0] * int(SR * 1.0)
    for start, freq in ((0.0, 880), (0.34, 880), (0.68, 1320)):
        begin = int(start * SR)
        for index in range(int(0.16 * SR)):
            tt = index / SR
            out[begin + index] = math.sin(2 * math.pi * freq * tt) * env(tt, 0.003, 0.15, 2.0) * 0.8
    return out


def make_audio() -> dict[str, float]:
    makers = {
        "pop.wav": synth_pop,
        "notification.wav": synth_notification,
        "swoosh.wav": synth_swoosh,
        "riser.wav": synth_riser,
        "glitch.wav": synth_glitch,
        "heartbeat.wav": synth_heartbeat,
        "typing.wav": synth_typing,
        "camera.wav": synth_camera,
        "bell.wav": synth_bell,
        "bass_drop.wav": synth_bass_drop,
        "applause.wav": synth_applause,
        "countdown.wav": synth_countdown,
    }
    return {name: write_wav(name, maker()) for name, maker in makers.items()}


# ---------------------------------------------------------------- Manifest

FILTERS = [
    ("original", "原片", "不处理", ["#64748b", "#94a3b8"], 0, 1, 1, 0, 0, 0),
    ("cinema", "电影感", "低饱和高对比", ["#0f172a", "#38bdf8"], 0.02, 1.18, 0.88, -3, -0.08, 0.22),
    ("cool", "冷调", "青蓝夜景", ["#0c4a6e", "#67e8f9"], 0.01, 1.08, 0.9, 16, -0.28, 0.12),
    ("warm", "暖阳", "橙金日光", ["#7c2d12", "#fbbf24"], 0.03, 1.04, 1.08, -12, 0.3, 0.08),
    ("mono", "黑白", "经典单色", ["#111827", "#f3f4f6"], 0, 1.22, 0, 0, 0, 0.18),
    ("vintage", "复古", "褪色胶片", ["#78350f", "#fcd34d"], -0.03, 0.92, 0.72, 20, 0.12, 0.35),
    ("vivid", "鲜艳", "高饱和", ["#be123c", "#22d3ee"], 0.01, 1.1, 1.38, 0, 0, 0),
    ("fade", "褪色", "低对比灰雾", ["#374151", "#d1d5db"], 0.06, 0.82, 0.62, 8, 0.04, 0.1),
    ("night", "夜景", "压暗提蓝", ["#020617", "#1d4ed8"], 0.08, 1.2, 0.78, 10, -0.22, 0.4),
    ("contrast", "高对比", "硬朗层次", ["#000000", "#f8fafc"], 0, 1.35, 1.02, 0, 0, 0.12),
    ("teal_orange", "青橙", "电影青橙", ["#0f766e", "#fb923c"], 0.01, 1.12, 1.16, -6, 0.18, 0.2),
    ("japanese", "日系", "清新明亮", ["#bae6fd", "#fef3c7"], 0.08, 0.92, 0.86, 4, 0.12, 0.06),
    ("nordic", "北欧冷灰", "低饱和冷色", ["#334155", "#cbd5e1"], 0.02, 1.04, 0.58, 4, -0.18, 0.15),
    ("sepia", "棕褐", "怀旧棕调", ["#78350f", "#fde68a"], 0.02, 1.02, 0.32, 28, 0.22, 0.3),
    ("neon", "霓虹", "高饱和高对比", ["#6d28d9", "#22d3ee"], 0.02, 1.2, 1.5, 10, -0.1, 0.2),
    ("dream", "柔光", "低对比梦幻", ["#c4b5fd", "#fbcfe8"], 0.1, 0.88, 1.05, -4, 0.08, 0.05),
    ("noir", "黑色电影", "硬黑对比", ["#020617", "#94a3b8"], -0.02, 1.45, 0, 0, -0.05, 0.45),
    ("sunset", "落日", "暖橙金调", ["#7c2d12", "#fdba74"], 0.03, 1.05, 1.12, -8, 0.32, 0.18),
    ("mint", "薄荷", "清新青绿", ["#0f766e", "#bbf7d0"], 0.02, 1.02, 1.05, 18, -0.12, 0.05),
    ("autumn", "秋日", "金棕低色温", ["#92400e", "#fcd34d"], 0.01, 1.06, 1.1, -18, 0.25, 0.22),
    ("ice", "冰川", "冷蓝通透", ["#0c4a6e", "#e0f2fe"], 0.04, 1.06, 0.8, 6, -0.3, 0.1),
    ("retro", "80 年代", "紫粉复古", ["#6d28d9", "#f472b6"], 0.02, 1.08, 1.22, 12, 0.1, 0.28),
]

SUBTITLES = [
    ("cinema_title", "电影标题", "大字号居中偏下", "在这里输入标题", 76, 0.82, "#ffffff", False, True),
    ("opening", "开场大标题", "超大居中标题", "开场标题", 92, 0.42, "#ffffff", False, True),
    ("documentary", "纪录片", "白字暗底", "纪录片旁白字幕", 48, 0.88, "#f8fafc", True, True),
    ("news", "新闻条", "底部信息条", "新闻标题 / NEWS", 44, 0.9, "#ffffff", True, True),
    ("variety", "综艺", "琥珀色大字", "综艺花字", 64, 0.78, "#fbbf24", True, True),
    ("minimal", "极简字幕", "小字无底框", "极简字幕", 38, 0.92, "#ffffff", False, False),
    ("ending", "片尾卡", "居中标题", "感谢观看", 58, 0.5, "#ffffff", False, True),
    ("chapter", "章节标题", "左上角小标题", "第一章 · 出发", 46, 0.16, "#fbbf24", False, True),
    ("quote", "金句引用", "居中偏下带底框", "把想说的话留在这里", 46, 0.8, "#f8fafc", True, True),
    ("location", "地点时间", "底部小字", "2026 · 上海", 34, 0.94, "#e2e8f0", True, False),
    ("namecard", "人物介绍", "下三分之一", "姓名 / 身份", 42, 0.76, "#ffffff", True, True),
    ("bilingual", "双语字幕", "中英双语", "中文字幕\nEnglish subtitle", 42, 0.88, "#ffffff", True, True),
    ("warning", "警示提示", "红色居中提示", "请注意安全", 46, 0.5, "#f87171", True, True),
    ("countdown", "倒计时", "巨大数字", "3", 120, 0.5, "#fbbf24", False, True),
    ("speaker", "发言人标签", "左上角标签", "发言人：嘉宾", 32, 0.12, "#ffffff", True, True),
    ("date_stamp", "日期戳", "右下角日期", "2026.11.07", 30, 0.92, "#fbbf24", False, True),
]

STICKER_ITEMS = [
    ("new", "NEW 标签", "stickers/new.png", 0.25, 0.78, 0.18),
    ("rec", "REC 录制", "stickers/rec.png", 0.22, 0.18, 0.12),
    ("subscribe", "订阅按钮", "stickers/subscribe.png", 0.3, 0.5, 0.86),
    ("lower_third", "下三分之一条", "stickers/lower_third.png", 0.42, 0.5, 0.78),
    ("cut", "CUT 花字", "stickers/cut.png", 0.28, 0.5, 0.3),
    ("arrow", "箭头 GO", "stickers/arrow.png", 0.22, 0.76, 0.7),
    ("sparkle", "闪光星星", "stickers/sparkle.png", 0.16, 0.68, 0.28),
    ("like", "点赞", "stickers/like.png", 0.25, 0.5, 0.88),
    ("live", "LIVE 直播中", "stickers/live.png", 0.28, 0.5, 0.12),
    ("hot", "热播中", "stickers/hot.png", 0.26, 0.24, 0.88),
    ("hd", "4K HDR 角标", "stickers/hd.png", 0.18, 0.86, 0.16),
    ("follow", "关注按钮", "stickers/follow.png", 0.26, 0.72, 0.88),
    ("share", "分享按钮", "stickers/share.png", 0.24, 0.18, 0.88),
    ("top1", "TOP 1 奖牌", "stickers/top1.png", 0.22, 0.5, 0.22),
    ("red_circle", "重点圈选", "stickers/red_circle.png", 0.3, 0.5, 0.5),
    ("underline", "手绘下划线", "stickers/underline.png", 0.4, 0.5, 0.7),
    ("arrow_white", "白色箭头", "stickers/arrow_white.png", 0.26, 0.5, 0.62),
    ("speech", "对话气泡", "stickers/speech.png", 0.3, 0.5, 0.42),
    ("bang", "感叹号气泡", "stickers/bang.png", 0.18, 0.78, 0.3),
    ("star", "金星", "stickers/star.png", 0.16, 0.82, 0.24),
    ("lower_third_blue", "蓝色人物条", "stickers/lower_third_blue.png", 0.46, 0.5, 0.8),
]

AUDIO_ITEMS = [
    ("ambient", "氛围铺底", "20 秒合成氛围", "audio/ambient.mp3", 20.19),
    ("whoosh", "转场 Whoosh", "1.4 秒噪声扫频", "audio/whoosh.wav", 1.4),
    ("impact", "低频 Impact", "1.2 秒重击", "audio/impact.wav", 1.2),
    ("click", "UI Click", "0.18 秒点击", "audio/click.wav", 0.18),
    ("pop", "气泡 Pop", "轻快短音", "audio/pop.wav", 0.0),
    ("notification", "通知提示", "双音提示", "audio/notification.wav", 0.0),
    ("swoosh", "快速转场", "0.9 秒扫频", "audio/swoosh.wav", 0.0),
    ("riser", "情绪上升", "2 秒渐强", "audio/riser.wav", 0.0),
    ("glitch", "故障 Glitch", "数字故障音", "audio/glitch.wav", 0.0),
    ("heartbeat", "心跳", "低频双拍", "audio/heartbeat.wav", 0.0),
    ("typing", "键盘打字", "机械键盘声", "audio/typing.wav", 0.0),
    ("camera", "相机快门", "拍照咔嚓", "audio/camera.wav", 0.0),
    ("bell", "铃声", "清亮铃音", "audio/bell.wav", 0.0),
    ("bass_drop", "低音下潜", "Bass Drop", "audio/bass_drop.wav", 0.0),
    ("applause", "掌声", "人群鼓掌", "audio/applause.wav", 0.0),
    ("countdown", "倒计时提示", "三声提示音", "audio/countdown.wav", 0.0),
]

EFFECTS = [
    ("mosaic_center", "中央马赛克", "画面中央 50% 像素化", "pixel", 16, 0.25, 0.25, 0.5, 0.5),
    ("mosaic_face", "人像打码", "偏上区域，可再调位置", "pixel", 20, 0.32, 0.16, 0.36, 0.36),
    ("mosaic_strong", "强马赛克", "大块覆盖中央", "pixel", 36, 0.2, 0.2, 0.6, 0.6),
    ("mosaic_full", "全屏马赛克", "整幅画面像素化", "pixel", 28, 0.0, 0.0, 1.0, 1.0),
    ("blur_center", "中央高斯模糊", "柔和虚化中央区域", "blur", 24, 0.25, 0.25, 0.5, 0.5),
    ("blur_face", "人像模糊", "隐私模糊，边缘更自然", "blur", 32, 0.3, 0.14, 0.4, 0.42),
    ("blur_bottom", "底部模糊条", "虚化底部信息区", "blur", 20, 0.0, 0.78, 1.0, 0.22),
    ("black_bar", "黑条遮挡", "纯黑遮挡底部区域", "black", 16, 0.0, 0.78, 1.0, 0.22),
    ("black_face", "黑块遮挡", "纯黑遮挡人像区域", "black", 16, 0.33, 0.18, 0.34, 0.34),
]


def build_manifest(durations: dict[str, float]) -> dict:
    filters = []
    for (fid, name, desc, sw, brightness, contrast, saturation, hue,
         temperature, vignette) in FILTERS:
        filters.append({
            "id": fid, "name": name, "desc": desc, "sw": sw,
            "grade": {
                "brightness": brightness, "contrast": contrast,
                "saturation": saturation, "hue": hue,
                "temperature": temperature, "vignette": vignette,
            },
        })
    subtitles = [{
        "id": sid, "name": name, "desc": desc,
        "style": {"text": text, "size": size, "y": y, "color": color,
                  "bg": bg, "bold": bold},
    } for (sid, name, desc, text, size, y, color, bg, bold) in SUBTITLES]
    stickers = [{
        "id": sid, "name": name, "file": file, "scale": scale, "x": x, "y": y,
    } for (sid, name, file, scale, x, y) in STICKER_ITEMS]
    audio = []
    for (aid, name, desc, file, duration) in AUDIO_ITEMS:
        audio.append({
            "id": aid, "name": name, "desc": desc, "file": file,
            "duration": durations.get(Path(file).name, duration),
        })
    effects = [{
        "id": eid, "name": name, "desc": desc, "mode": mode, "block": block,
        "x": x, "y": y, "w": w, "h": h,
    } for (eid, name, desc, mode, block, x, y, w, h) in EFFECTS]
    return {"filters": filters, "subtitles": subtitles, "stickers": stickers,
            "audio": audio, "effects": effects}


def main() -> None:
    make_stickers()
    durations = make_audio()
    manifest = build_manifest(durations)
    (BUILTIN / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"stickers={len(manifest['stickers'])} audio={len(manifest['audio'])} "
          f"filters={len(manifest['filters'])} subtitles={len(manifest['subtitles'])} "
          f"effects={len(manifest['effects'])}")


if __name__ == "__main__":
    main()
