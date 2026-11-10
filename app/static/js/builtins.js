import {
  S, mainDuration, mutate, newId, select, selectionItems, targetTrack,
} from './store.js';
import { toast } from './ui.js';

export const BUILTIN_CATS = [
  { id: 'filters', label: '滤镜' },
  { id: 'subtitles', label: '字幕模板' },
  { id: 'stickers', label: '视频贴图' },
  { id: 'audio', label: '音频素材' },
  { id: 'effects', label: '马赛克特效' },
];

let loading = null;

export async function loadBuiltinManifest(force = false) {
  if (S.builtin && !force) return S.builtin;
  if (!loading || force) {
    loading = fetch('/builtin/manifest.json', { cache: 'no-cache' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        S.builtin = data;
        return data;
      })
      .finally(() => { loading = null; });
  }
  return loading;
}

export function builtinItem(category, id) {
  return (S.builtin?.[category] || []).find((entry) => entry.id === id) || null;
}

function startAt(preferred) {
  if (Number.isFinite(preferred)) return Math.max(0, preferred);
  const total = mainDuration();
  return total > 0 ? Math.min(S.playhead, Math.max(0, total - 0.6)) : S.playhead;
}

export function applyFilter(item) {
  if (!item) return;
  mutate(() => {
    S.doc.grade = {
      brightness: 0, contrast: 1, saturation: 1, hue: 0,
      temperature: 0, vignette: 0,
      ...item.grade,
    };
  }, `builtin-filter-${item.id}`);
  toast(`已应用滤镜：${item.name}`, 'ok');
}

export function addSubtitleTemplate(item, options = {}) {
  if (!item) return null;
  const style = item.style || {};
  const start = startAt(options.start);
  const remaining = mainDuration() - start;
  const text = {
    id: newId('t'),
    trackId: options.trackId || targetTrack('text')?.id,
    text: style.text || '字幕',
    start,
    duration: Math.max(0.6, Math.min(3, remaining > 0.2 ? remaining : 3)),
    x: Number.isFinite(options.x) ? options.x : 0.5,
    y: Number(style.y ?? 0.82),
    size: Number(style.size) || 48,
    color: style.color || '#ffffff',
    bg: Boolean(style.bg),
    bold: Boolean(style.bold),
  };
  mutate(() => { S.doc.texts.push(text); }, `builtin-subtitle-${item.id}`);
  select('text', text.id);
  toast(`已添加字幕模板：${item.name}`, 'ok');
  return text;
}

export function addSticker(item, options = {}) {
  if (!item) return null;
  const start = startAt(options.start);
  const overlay = {
    id: newId('o'),
    kind: 'image',
    trackId: options.trackId || targetTrack('video')?.id,
    src: `builtin/${item.file}`,
    in: 0,
    start,
    duration: 4,
    x: Number(item.x ?? 0.5),
    y: Number(item.y ?? 0.5),
    scale: Number(item.scale) || 0.25,
    rotate: 0,
    opacity: 1,
  };
  mutate(() => { S.doc.overlays.push(overlay); }, `builtin-sticker-${item.id}`);
  select('overlay', overlay.id);
  toast(`已添加贴图：${item.name}`, 'ok');
  return overlay;
}

export function addBuiltinAudio(item, options = {}) {
  if (!item) return null;
  const start = startAt(options.start);
  const remaining = mainDuration() - start;
  const limit = remaining > 0.1 ? remaining : item.duration;
  const audio = {
    id: newId('a'),
    trackId: options.trackId || targetTrack('audio')?.id,
    src: `builtin/${item.file}`,
    in: 0,
    start,
    duration: Math.max(0.2, Math.min(item.duration, limit)),
    volume: 0.7,
    muted: false,
    speed: 1,
    fadeIn: 0.05,
    fadeOut: 0.15,
    loop: false,
    linkedMainId: null,
  };
  mutate(() => { S.doc.audios.push(audio); }, `builtin-audio-${item.id}`);
  select('audio', audio.id);
  toast(`已添加音频：${item.name}`, 'ok');
  return audio;
}

export function applyMosaicEffect(item, options = {}) {
  if (!item) return 0;
  let targets = options.items;
  if (!targets) {
    targets = selectionItems().filter((entry) => entry.kind === 'main');
  }
  targets = (targets || []).filter((entry) => entry.kind === 'main');
  if (!targets.length) {
    toast('请先选中主轨上的视频片段，再应用特效', 'err');
    return 0;
  }
  mutate(() => {
    for (const { item: clip } of targets) {
      clip.mosaic = true;
      clip.mosaicMode = item.mode || 'pixel';
      clip.mosaicBlock = Number(item.block) || 16;
      clip.mosaicX = Number(item.x ?? 0.25);
      clip.mosaicY = Number(item.y ?? 0.25);
      clip.mosaicW = Number(item.w ?? 0.5);
      clip.mosaicH = Number(item.h ?? 0.5);
    }
  }, `builtin-effect-${item.id}`);
  toast(`已应用：${item.name}${targets.length > 1 ? `（${targets.length} 个片段）` : ''}，可在右侧属性微调区域`, 'ok');
  return targets.length;
}

export function clearMosaic() {
  const targets = selectionItems().filter((entry) => entry.kind === 'main');
  if (!targets.length) return 0;
  mutate(() => {
    for (const { item } of targets) item.mosaic = false;
  }, 'clear-mosaic');
  toast('已关闭选中片段的马赛克/遮挡', 'ok');
  return targets.length;
}

export async function handleBuiltinDrop(payload, context = {}) {
  const manifest = S.builtin || await loadBuiltinManifest();
  const category = payload.category;
  const item = (manifest[category] || []).find((entry) => entry.id === payload.id);
  if (!item) {
    toast('没有找到这个内置素材', 'err');
    return null;
  }
  const track = context.track || null;
  const start = Number.isFinite(context.start) ? context.start : S.playhead;
  if (category === 'filters') {
    applyFilter(item);
    return item;
  }
  if (category === 'subtitles') {
    return addSubtitleTemplate(item, { start, trackId: track?.type === 'text' ? track.id : undefined });
  }
  if (category === 'stickers') {
    return addSticker(item, { start, trackId: track?.type === 'video' ? track.id : undefined });
  }
  if (category === 'audio') {
    return addBuiltinAudio(item, { start, trackId: track?.type === 'audio' ? track.id : undefined });
  }
  if (category === 'effects') {
    const items = context.targetClip
      ? [{ kind: 'main', item: context.targetClip }]
      : undefined;
    return applyMosaicEffect(item, { items });
  }
  return null;
}
