import {
  S, activeMain, clamp, clipDuration, mainDuration, on, orderedByTrack, setPlayhead,
} from './store.js';
import { $, fmtTime, icon, mediaUrl } from './ui.js';

const POOL = () => $('#mediaPool');

class PreviewEngine {
  constructor() {
    this.videos = new Map();
    this.images = new Map();
    this.audios = new Map();
    this.raf = 0;
    this.drawRaf = 0;
    this.direction = 1;
    this.playWall = 0;
    this.playBase = 0;
    this.lastDraw = 0;
    this.stage = null;
    this.canvas = null;
    this.ctx = null;
    this.hold = null;
  }

  init() {
    this.stage = $('#stage');
    this.canvas = $('#previewCanvas');
    this.ctx = this.canvas.getContext('2d');
    $('#playBtn').addEventListener('click', () => this.toggle());
    // 点击预览画面也可以暂停/继续（播放器常见操作）。
    this.stage.addEventListener('click', () => this.toggle());
    $('#stopBtn').addEventListener('click', () => { this.pause(); setPlayhead(0); });
    $('#muteBtn').addEventListener('click', () => {
      S.muted = !S.muted;
      this.updateTransport();
      this.syncMedia(true);
    });
    const scrub = $('#scrub');
    scrub.addEventListener('input', () => {
      this.pause();
      setPlayhead(Number(scrub.value));
    });
    for (const event of ['doc', 'project']) on(event, () => this.onDoc());
    on('playhead', ({ time, source }) => {
      if (!S.playing) {
        this.pauseMedia();
        this.seekMedia(time);
        this.drawSoon();
      } else if (source !== 'preview') {
        this.playBase = time;
        this.playWall = performance.now();
        this.syncMedia(true);
      }
      this.updateTransport();
    });
    on('selection', () => this.drawSoon());
    const observer = new ResizeObserver(() => { this.layout(); this.drawSoon(); });
    observer.observe(this.stage);
    window.addEventListener('resize', () => { this.layout(); this.drawSoon(); });
    this.layout();
    this.updateTransport();
    this.drawSoon();
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); });
  }

  onDoc() {
    this.cleanupMedia();
    this.layout();
    const duration = mainDuration();
    if (S.playhead > duration) setPlayhead(duration);
    const doc = S.doc;
    if (doc) {
      $('#canvasBadge').textContent = `${doc.canvas.width} × ${doc.canvas.height}`;
      $('#fpsBadge').textContent = `${doc.canvas.fps} fps`;
    }
    $('#stageEmpty').classList.toggle('hidden', !!(doc && doc.main.length));
    this.updateTransport();
    this.drawSoon();
  }

  duration() {
    return mainDuration();
  }

  toggle() {
    if (S.playing) this.pause();
    else this.play();
  }

  play(direction = 1) {
    const duration = this.duration();
    if (!S.doc || duration <= 0.02) return;
    const dir = direction < 0 ? -1 : 1;
    if (dir > 0 && S.playhead >= duration - 0.02) setPlayhead(0);
    if (dir < 0 && S.playhead <= 0.02) setPlayhead(duration);
    S.playing = true;
    this.direction = dir;
    this.playWall = performance.now();
    this.playBase = S.playhead;
    this.updateTransport();
    this.syncMedia(true);
    const loop = (now) => {
      if (!S.playing) return;
      const time = this.playBase + this.direction * ((now - this.playWall) / 1000);
      if (this.direction > 0 && time >= duration) {
        this.pause();
        setPlayhead(duration);
        return;
      }
      if (this.direction < 0 && time <= 0) {
        this.pause();
        setPlayhead(0);
        return;
      }
      setPlayhead(time, 'preview');
      if (this.direction < 0) {
        this.pauseMedia();
        this.seekMedia(time, true);
      } else {
        this.syncMedia(false);
      }
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(loop);
  }

  pause() {
    if (!S.playing) {
      this.pauseMedia();
      return;
    }
    S.playing = false;
    this.direction = 1;
    cancelAnimationFrame(this.raf);
    this.pauseMedia();
    this.seekMedia(S.playhead, true);
    this.updateTransport();
    this.drawSoon();
  }

  updateTransport() {
    const duration = this.duration();
    // 只在实际状态变化时替换按钮 DOM。播放中每帧 setPlayhead 都会调用这里，
    // 若每帧重写 innerHTML，真实鼠标的 mousedown/mouseup 可能落在不同节点上，
    // 浏览器就不会合成 click，表现为“播放后点暂停没反应”。
    const playState = S.playing ? 'pause' : 'play';
    if (this._playState !== playState) {
      this._playState = playState;
      $('#playBtn').innerHTML = icon(playState);
      $('#playBtn').title = S.playing ? '暂停 (空格)' : '播放 (空格)';
    }
    const muteState = S.muted ? 'volume-x' : 'volume';
    if (this._muteState !== muteState) {
      this._muteState = muteState;
      $('#muteBtn').innerHTML = icon(muteState);
    }
    $('#timeNow').textContent = fmtTime(S.playhead, 1);
    $('#timeTotal').textContent = fmtTime(duration, 1);
    const fps = Math.max(1, Number(S.doc?.canvas.fps) || 30);
    const frame = Math.round(S.playhead * fps);
    const totalFrames = Math.round(duration * fps);
    const frameReadout = $('#frameReadout');
    if (frameReadout) frameReadout.textContent = `F ${frame} / ${totalFrames}`;
    const scrub = $('#scrub');
    scrub.max = String(Math.max(0.01, duration));
    if (document.activeElement !== scrub) scrub.value = String(S.playhead);
    scrub.disabled = duration <= 0;
    $('#tlDuration').textContent = fmtTime(duration, 1);
    const badge = $('#stageBadge');
    if (badge) badge.textContent = `${fmtTime(S.playhead, 2)} / ${fmtTime(duration, 2)}`;
  }

  layout() {
    if (!this.stage || !this.canvas) return;
    const rect = this.stage.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const doc = S.doc;
    const aspect = doc ? doc.canvas.width / doc.canvas.height : 16 / 9;
    const availW = rect.width - 26;
    const availH = rect.height - 22;
    let dispW = availW;
    let dispH = dispW / aspect;
    if (dispH > availH) {
      dispH = availH;
      dispW = dispH * aspect;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(320, Math.round(dispW * dpr));
    const height = Math.max(180, Math.round(dispH * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.canvas.style.width = `${Math.round(dispW)}px`;
    this.canvas.style.height = `${Math.round(dispH)}px`;
    this.pixelWidth = width;
    this.pixelHeight = height;
  }

  drawSoon() {
    if (this.drawRaf) return;
    this.drawRaf = requestAnimationFrame(() => {
      this.drawRaf = 0;
      this.draw();
    });
  }

  draw() {
    if (!this.ctx || !this.canvas) return;
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const doc = S.doc;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (!doc || !doc.main.length) {
      ctx.restore();
      return;
    }
    const t = clamp(S.playhead, 0, Math.max(0, mainDuration()));
    const active = activeMain(t);
    if (active) {
      const video = this.getMainVideo(active.clip);
      if (video && video.readyState >= 2) {
        const grade = doc.grade || {};
        const brightness = Math.max(0, 1 + Number(grade.brightness || 0));
        const contrast = Math.max(0, Number(grade.contrast || 1));
        const saturation = Math.max(0, Number(grade.saturation || 1));
        const hue = Number(grade.hue || 0);
        const filters = [];
        if (Math.abs(brightness - 1) > 0.01) filters.push(`brightness(${brightness})`);
        if (Math.abs(contrast - 1) > 0.01) filters.push(`contrast(${contrast})`);
        if (Math.abs(saturation - 1) > 0.01) filters.push(`saturate(${saturation})`);
        if (Math.abs(hue) > 0.5) filters.push(`hue-rotate(${hue}deg)`);
        if (filters.length) ctx.filter = filters.join(' ');
        this.drawMainClip(video, active.clip, W, H);
        ctx.filter = 'none';
        this.drawGrade(active.clip, W, H, grade);
        if (active.clip.mosaic) this.drawMosaic(active.clip, W, H);
        if (!S.playing) this.rememberFrame(W, H);
      } else if (this.hold) {
        // 定位/拖动播放头时浏览器会短暂把 readyState 降到 2 以下；
        // 保留上一帧，避免每秒黑屏一闪。切换片段时也先显示上一段最后一帧。
        ctx.drawImage(this.hold, 0, 0, W, H);
      }
    }
    for (const item of orderedByTrack(doc.overlays || [], 'video', doc)) {
      if (t < item.start || t >= item.start + item.duration) continue;
      const media = item.kind === 'image' ? this.getImage(item.src) : this.getOverlayVideo(item);
      if (!media) continue;
      const ready = item.kind === 'image' ? media.complete && media.naturalWidth : media.readyState >= 2;
      if (!ready) continue;
      this.drawOverlay(media, item, W, H);
    }
    for (const item of orderedByTrack(doc.texts || [], 'text', doc)) {
      if (t < item.start || t >= item.start + item.duration) continue;
      this.drawText(ctx, item, W, H, doc);
    }
    ctx.restore();
  }

  rememberFrame(W, H) {
    if (!this.hold) this.hold = document.createElement('canvas');
    if (this.hold.width !== W || this.hold.height !== H) {
      this.hold.width = W;
      this.hold.height = H;
    }
    const hctx = this.hold.getContext('2d');
    if (!hctx) return;
    hctx.clearRect(0, 0, W, H);
    hctx.drawImage(this.canvas, 0, 0);
  }

  drawMainClip(media, clip, W, H) {
    const ctx = this.ctx;
    const sw = media.videoWidth || media.naturalWidth || 1;
    const sh = media.videoHeight || media.naturalHeight || 1;
    const angle = ((Number(clip.rotate) || 0) * Math.PI) / 180;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const rotatedW = sw * cos + sh * sin;
    const rotatedH = sw * sin + sh * cos;
    const scale = Number(clip.scale) || 1;
    const boxW = W * scale;
    const boxH = H * scale;
    let factor;
    if (clip.fit === 'cover') factor = Math.max(boxW / rotatedW, boxH / rotatedH);
    else factor = Math.min(boxW / rotatedW, boxH / rotatedH);
    ctx.save();
    if (clip.fit === 'cover') {
      ctx.beginPath();
      ctx.rect(W / 2 - boxW / 2, H / 2 - boxH / 2, boxW, boxH);
      ctx.clip();
    }
    ctx.translate(W / 2, H / 2);
    ctx.rotate(angle);
    ctx.scale(clip.flipH ? -1 : 1, clip.flipV ? -1 : 1);
    const dw = sw * factor;
    const dh = sh * factor;
    ctx.drawImage(media, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  drawGrade(clip, W, H, grade) {
    const ctx = this.ctx;
    const temperature = Math.max(-1, Math.min(1, Number(grade.temperature) || 0));
    if (Math.abs(temperature) > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'soft-light';
      const alpha = Math.min(0.55, Math.abs(temperature) * 0.65);
      ctx.fillStyle = temperature > 0
        ? `rgba(255,164,84,${alpha})`
        : `rgba(88,148,255,${alpha})`;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    const vignette = Math.max(0, Math.min(1, Number(grade.vignette) || 0));
    if (vignette > 0.02) {
      const gradient = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32,
        W / 2, H / 2, Math.max(W, H) * 0.72);
      gradient.addColorStop(0, 'rgba(0,0,0,0)');
      gradient.addColorStop(1, `rgba(0,0,0,${Math.min(0.82, 0.25 + vignette * 0.6)})`);
      ctx.save();
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  drawMosaic(clip, W, H) {
    const x = Math.max(0, Math.round(Number(clip.mosaicX ?? 0.25) * W));
    const y = Math.max(0, Math.round(Number(clip.mosaicY ?? 0.25) * H));
    const w = Math.max(2, Math.min(W - x, Math.round(Number(clip.mosaicW ?? 0.5) * W)));
    const h = Math.max(2, Math.min(H - y, Math.round(Number(clip.mosaicH ?? 0.5) * H)));
    const block = Math.max(2, Math.min(64, Number(clip.mosaicBlock) || 16));
    const mode = clip.mosaicMode || 'pixel';
    const ctx = this.ctx;
    if (mode === 'black') {
      ctx.save();
      ctx.fillStyle = '#000';
      ctx.fillRect(x, y, w, h);
      ctx.restore();
      return;
    }
    if (!this.mosaicBuffer) this.mosaicBuffer = document.createElement('canvas');
    const buffer = this.mosaicBuffer;
    if (mode === 'blur') {
      if (buffer.width !== w || buffer.height !== h) {
        buffer.width = w;
        buffer.height = h;
      }
      const bctx = buffer.getContext('2d');
      bctx.clearRect(0, 0, w, h);
      bctx.drawImage(this.canvas, x, y, w, h, 0, 0, w, h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.filter = `blur(${Math.max(1, block / 2)}px)`;
      ctx.drawImage(buffer, x, y, w, h);
      ctx.filter = 'none';
      ctx.restore();
      return;
    }
    const sw = Math.max(1, Math.round(w / block));
    const sh = Math.max(1, Math.round(h / block));
    if (buffer.width !== sw || buffer.height !== sh) {
      buffer.width = sw;
      buffer.height = sh;
    }
    const bctx = buffer.getContext('2d');
    bctx.imageSmoothingEnabled = false;
    bctx.clearRect(0, 0, sw, sh);
    bctx.drawImage(this.canvas, x, y, w, h, 0, 0, sw, sh);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buffer, 0, 0, sw, sh, x, y, w, h);
    ctx.restore();
  }

  drawOverlay(media, item, W, H) {
    const ctx = this.ctx;
    const sw = media.videoWidth || media.naturalWidth || 1;
    const sh = media.videoHeight || media.naturalHeight || 1;
    const width = W * (Number(item.scale) || 0.3);
    const height = width * (sh / sw);
    ctx.save();
    ctx.globalAlpha = clamp(Number(item.opacity ?? 1), 0, 1);
    ctx.translate((Number(item.x) || 0.5) * W, (Number(item.y) || 0.5) * H);
    ctx.rotate(((Number(item.rotate) || 0) * Math.PI) / 180);
    ctx.drawImage(media, -width / 2, -height / 2, width, height);
    ctx.restore();
  }

  drawText(ctx, item, W, H, doc) {
    const sx = W / doc.canvas.width;
    const size = Math.max(8, Number(item.size) * sx);
    const lines = String(item.text).split('\n');
    const lineHeight = size * 1.25;
    const x = (Number(item.x) || 0.5) * W;
    const y = (Number(item.y) || 0.5) * H;
    ctx.save();
    ctx.font = `${item.bold ? 700 : 500} ${size}px "Noto Sans CJK SC", "WenQuanYi Micro Hei", "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (item.bg) {
      let maxWidth = 0;
      for (const line of lines) maxWidth = Math.max(maxWidth, ctx.measureText(line).width);
      const padX = size * 0.42;
      const padY = size * 0.28;
      const boxW = maxWidth + padX * 2;
      const boxH = lines.length * lineHeight + padY * 2;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      this.roundRect(ctx, x - boxW / 2, y - boxH / 2, boxW, boxH, size * 0.16);
      ctx.fill();
    }
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = Math.max(2, size * 0.055);
    ctx.fillStyle = item.color || '#ffffff';
    lines.forEach((line, index) => {
      const lineY = y - ((lines.length - 1) * lineHeight) / 2 + index * lineHeight;
      ctx.strokeText(line, x, lineY);
      ctx.fillText(line, x, lineY);
    });
    ctx.restore();
  }

  roundRect(ctx, x, y, w, h, radius) {
    const r = Math.min(radius, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------------------------------------------------------- 媒体池

  poolVideo(key, src, muted) {
    if (this.videos.has(key)) {
      const cached = this.videos.get(key);
      if (cached.dataset.src !== src) {
        cached.dataset.src = src;
        cached.src = mediaUrl(src);
        cached.load();
      }
      cached.muted = muted;
      return cached;
    }
    const video = document.createElement('video');
    video.dataset.src = src;
    video.src = mediaUrl(src);
    video.preload = 'auto';
    video.playsInline = true;
    video.muted = muted;
    video.addEventListener('loadeddata', () => this.drawSoon());
    video.addEventListener('seeked', () => { this.pumpSeek(video); this.drawSoon(); });
    POOL().appendChild(video);
    this.videos.set(key, video);
    return video;
  }

  getMainVideo(clip) {
    return this.poolVideo(`main:${clip.id}`, clip.src, false);
  }

  getOverlayVideo(item) {
    return this.poolVideo(`overlay:${item.id}`, item.src, true);
  }

  getImage(src) {
    if (this.images.has(src)) return this.images.get(src);
    const image = new Image();
    image.src = mediaUrl(src);
    image.addEventListener('load', () => this.drawSoon());
    this.images.set(src, image);
    return image;
  }

  getAudio(item) {
    const key = `audio:${item.id}`;
    if (this.audios.has(key)) {
      const cached = this.audios.get(key);
      if (cached.dataset.src !== item.src) {
        cached.dataset.src = item.src;
        cached.src = mediaUrl(item.src);
      }
      return cached;
    }
    const audio = new Audio(mediaUrl(item.src));
    audio.dataset.src = item.src;
    audio.preload = 'auto';
    audio.addEventListener('seeked', () => this.pumpSeek(audio));
    POOL().appendChild(audio);
    this.audios.set(key, audio);
    return audio;
  }

  cleanupMedia() {
    if (!S.doc) return;
    const videoKeys = new Set();
    S.doc.main.forEach((clip) => videoKeys.add(`main:${clip.id}`));
    S.doc.overlays.filter((item) => item.kind === 'video').forEach((item) => videoKeys.add(`overlay:${item.id}`));
    for (const [key, video] of this.videos) {
      if (!videoKeys.has(key)) {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
        this.videos.delete(key);
      }
    }
    const audioKeys = new Set(S.doc.audios.map((item) => `audio:${item.id}`));
    for (const [key, audio] of this.audios) {
      if (!audioKeys.has(key)) {
        audio.pause();
        audio.remove();
        this.audios.delete(key);
      }
    }
  }

  syncMedia(force) {
    if (!S.doc) return;
    if (this.direction < 0) {
      this.pauseMedia();
      this.seekMedia(S.playhead, true);
      return;
    }
    const t = S.playhead;
    const duration = mainDuration();
    const active = activeMain(t);
    for (const [key, video] of this.videos) {
      if (key.startsWith('main:')) {
        const clipId = key.slice(5);
        const clip = S.doc.main.find((entry) => entry.id === clipId);
        const isActive = active && active.clip.id === clipId && t < duration - 0.001;
        if (!clip || !isActive) {
          video.pause();
          continue;
        }
        const desired = Number(clip.in) + (t - active.start) * (Number(clip.speed) || 1);
        video.playbackRate = clamp(Number(clip.speed) || 1, 0.25, 4);
        video.muted = Boolean(S.muted || clip.audioDetached);
        video.volume = video.muted ? 0 : clamp(Number(clip.volume ?? 1) * (Number(S.doc.masterVolume ?? 1)), 0, 1);
        if (S.playing) {
          if (force || Math.abs(video.currentTime - desired) > 0.25) video.currentTime = Math.max(0, desired);
          if (video.paused) video.play().catch(() => {});
        } else {
          video.pause();
          this.scheduleSeek(video, desired, force);
        }
      } else {
        const overlayId = key.slice(8);
        const item = (S.doc.overlays || []).find((entry) => entry.id === overlayId);
        const isActive = item && t >= item.start && t < item.start + item.duration;
        if (!item || !isActive) {
          video.pause();
          continue;
        }
        const desired = Number(item.in) + (t - item.start);
        video.muted = true;
        if (S.playing) {
          if (force || Math.abs(video.currentTime - desired) > 0.25) video.currentTime = Math.max(0, desired);
          if (video.paused) video.play().catch(() => {});
        } else {
          video.pause();
          this.scheduleSeek(video, desired, force);
        }
      }
    }
    for (const item of S.doc.audios || []) {
      const audio = this.getAudio(item);
      const activeAudio = t >= item.start && t < item.start + item.duration;
      const speed = clamp(Number(item.speed) || 1, 0.25, 4);
      audio.loop = Boolean(item.loop);
      audio.playbackRate = speed;
      audio.muted = Boolean(S.muted || item.muted);
      audio.volume = audio.muted ? 0 : clamp(Number(item.volume) * (Number(S.doc.masterVolume ?? 1)), 0, 1);
      if (!activeAudio || !S.playing) {
        audio.pause();
        if (!S.playing && activeAudio) {
          this.scheduleSeek(audio, Number(item.in) + (t - item.start) * speed, force);
        }
        continue;
      }
      let desired = Number(item.in) + (t - item.start) * speed;
      if (audio.loop && Number.isFinite(audio.duration) && audio.duration > 0.1) {
        const span = Math.max(0.1, audio.duration - Number(item.in));
        desired = Number(item.in) + ((t - item.start) * speed) % span;
      }
      if (force || Math.abs(audio.currentTime - desired) > 0.3) audio.currentTime = Math.max(0, desired);
      if (audio.paused) audio.play().catch(() => {});
    }
  }

  pauseMedia() {
    for (const video of this.videos.values()) video.pause();
    for (const audio of this.audios.values()) audio.pause();
  }

  // 拖动播放头时 pointermove 每秒可触发几十次 seek；直接连续写 currentTime 会让解码器
  // 不停取消/重启 seek，表现为预览卡顿。这里每个 <video> 只允许一个 seek 在飞，
  // 期间只记录最新目标，seeked 后再补最后一跳。
  scheduleSeek(video, target, force = false) {
    const state = video.__seek || (video.__seek = { target: null, busy: false });
    const next = Math.max(0, target);
    if (force) {
      state.target = null;
      if (Math.abs(video.currentTime - next) <= 0.005 && !video.seeking) {
        state.busy = false;
        return;
      }
      state.busy = true;
      video.currentTime = next;
      return;
    }
    if (!state.busy && Math.abs(video.currentTime - next) <= 0.04) return;
    state.target = next;
    if (!state.busy) {
      state.busy = true;
      video.currentTime = state.target;
      state.target = null;
    }
  }

  pumpSeek(video) {
    const state = video.__seek;
    if (!state) return;
    state.busy = false;
    if (state.target == null) return;
    const next = state.target;
    state.target = null;
    if (Math.abs(video.currentTime - next) <= 0.02) return;
    state.busy = true;
    video.currentTime = next;
  }

  seekMedia(time, force = false) {
    if (!S.doc) return;
    const active = activeMain(time);
    for (const [key, video] of this.videos) {
      if (key.startsWith('main:')) {
        const clip = S.doc.main.find((entry) => entry.id === key.slice(5));
        if (clip && active && active.clip.id === clip.id) {
          const desired = Number(clip.in) + (time - active.start) * (Number(clip.speed) || 1);
          this.scheduleSeek(video, desired, force);
        }
      } else {
        const item = (S.doc.overlays || []).find((entry) => entry.id === key.slice(8));
        if (item && time >= item.start && time < item.start + item.duration) {
          const desired = Number(item.in) + (time - item.start);
          this.scheduleSeek(video, desired, force);
        }
      }
    }
    for (const item of S.doc.audios || []) {
      const audio = this.getAudio(item);
      if (time >= item.start && time < item.start + item.duration) {
        const speed = clamp(Number(item.speed) || 1, 0.25, 4);
        this.scheduleSeek(audio, Number(item.in) + (time - item.start) * speed, force);
      }
    }
  }
}

export const preview = new PreviewEngine();
