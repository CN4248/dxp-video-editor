import { api } from './api.js';
import {
  S, activeMain, clamp, clipDuration, firstTrack, mainDuration, mainOffsets,
  mutate, newId, select, selectMany, selectedItem, selectionItems, setPlayhead, targetTrack,
  titleFor, tracksOfType,
} from './store.js';
import { confirmDialog, fmtTime, toast } from './ui.js';

function baseTransform() {
  return { scale: 1, rotate: 0, flipH: false, flipV: false, fit: 'contain', fadeIn: 0, fadeOut: 0 };
}

export async function ensureMeta(entry) {
  if (entry.meta && !entry.meta.error) return entry.meta;
  const cached = S.metaCache.get(entry.path);
  if (cached) return cached;
  const data = await api.get(`/api/probe?path=${encodeURIComponent(entry.path)}`);
  S.metaCache.set(entry.path, data.meta);
  entry.meta = data.meta;
  return data.meta;
}

export async function addMain(entry, options = {}) {
  const meta = await ensureMeta(entry);
  if (!meta.hasVideo) {
    toast('这个素材没有视频画面，不能放入主轨', 'err');
    return null;
  }
  const duration = Number(meta.duration) || 5;
  const clip = {
    id: newId('m'),
    kind: 'video',
    src: entry.path,
    in: 0,
    out: Math.max(0.2, Math.round(duration * 1000) / 1000),
    speed: 1,
    volume: 1,
    muted: false,
    hasAudio: Boolean(meta.hasAudio),
    audioDetached: false,
    ...baseTransform(),
  };
  let start = 0;
  const at = options.time;
  mutate(() => {
    if (Number.isFinite(at)) {
      let index = S.doc.main.length;
      let cursor = 0;
      for (let i = 0; i < S.doc.main.length; i += 1) {
        const length = clipDuration(S.doc.main[i]);
        if (at < cursor + length / 2) { index = i; break; }
        cursor += length;
      }
      S.doc.main.splice(index, 0, clip);
      start = at;
    } else {
      S.doc.main.push(clip);
      start = mainDuration() - clipDuration(clip);
    }
  }, 'add-main');
  select('main', clip.id);
  setPlayhead(start);
  toast(`已加入主轨：${entry.name}`, 'ok');
  return clip;
}

export async function addOverlay(entry, options = {}) {
  const meta = await ensureMeta(entry);
  const isVideo = meta.hasVideo && entry.kind === 'video';
  const sourceDuration = Number(meta.duration) || 4;
  const startAt = Number.isFinite(options.start) ? Math.max(0, options.start) : S.playhead;
  const remaining = Math.max(1, mainDuration() - startAt);
  const duration = isVideo ? Math.min(sourceDuration, Math.max(1.5, Math.min(6, remaining))) : 4;
  const item = {
    id: newId('o'),
    kind: isVideo ? 'video' : 'image',
    trackId: options.trackId || targetTrack('video')?.id,
    src: entry.path,
    in: 0,
    start: Math.min(startAt, Math.max(0, mainDuration() - duration)),
    duration: Math.max(0.2, Math.round(duration * 100) / 100),
    x: 0.5,
    y: 0.5,
    scale: 0.35,
    rotate: 0,
    opacity: 1,
  };
  mutate(() => { S.doc.overlays.push(item); }, 'add-overlay');
  select('overlay', item.id);
  toast(`已加入叠加层：${entry.name}`, 'ok');
  return item;
}

export async function addAudio(entry, options = {}) {
  const meta = await ensureMeta(entry);
  if (!meta.hasAudio) {
    toast('这个素材没有可用的音轨，无法加入音轨', 'err');
    return null;
  }
  const sourceDuration = Number(meta.duration) || 10;
  const startAt = Number.isFinite(options.start) ? Math.max(0, options.start) : S.playhead;
  const remaining = Math.max(0.5, mainDuration() - startAt);
  const duration = Math.min(sourceDuration, Math.max(2, remaining || sourceDuration));
  const item = {
    id: newId('a'),
    trackId: options.trackId || targetTrack('audio')?.id,
    src: entry.path,
    in: 0,
    start: startAt,
    duration: Math.max(0.2, Math.round(duration * 100) / 100),
    volume: 0.6,
    muted: false,
    speed: 1,
    fadeIn: 0,
    fadeOut: 0,
    loop: false,
    linkedMainId: null,
  };
  mutate(() => { S.doc.audios.push(item); }, 'add-audio');
  select('audio', item.id);
  toast(`已加入音轨：${entry.name}`, 'ok');
  return item;
}

export async function addMediaToTrack(entry, track, start) {
  if (!track) return null;
  if (track.type === 'video') {
    if (entry.kind !== 'video' && entry.kind !== 'image') {
      toast('这条视频轨只能放视频或图片素材', 'err');
      return null;
    }
    return addOverlay(entry, { trackId: track.id, start });
  }
  if (track.type === 'audio') {
    return addAudio(entry, { trackId: track.id, start });
  }
  toast('字幕轨请使用下方的字幕模板，或点击「字幕」新建', 'err');
  return null;
}

export async function separateAudio() {
  const mains = selectionItems().filter((entry) => entry.kind === 'main');
  if (!mains.length) {
    toast('请先选中主轨视频片段', 'err');
    return null;
  }
  const offsets = mainOffsets();
  const ready = [];
  for (const { item: clip } of mains) {
    if (clip.audioDetached) continue;
    let meta = S.metaCache.get(clip.src);
    if (!meta) {
      try {
        const data = await api.get(`/api/probe?path=${encodeURIComponent(clip.src)}`);
        meta = data.meta;
        S.metaCache.set(clip.src, meta);
      } catch (error) {
        continue;
      }
    }
    if (clip.hasAudio === false || (meta && meta.hasAudio === false)) continue;
    const offset = offsets.find((entry) => entry.clip.id === clip.id);
    if (!offset) continue;
    ready.push({ clip, offset });
  }
  if (!ready.length) {
    toast('选中片段没有可分离的音轨（或已经分离）', 'err');
    return null;
  }
  const created = [];
  mutate(() => {
    for (const { clip, offset } of ready) {
      const audio = {
        id: newId('a'),
        trackId: firstTrack('audio')?.id,
        src: clip.src,
        in: Number(clip.in) || 0,
        start: offset.start,
        duration: clipDuration(clip),
        volume: Number(clip.volume ?? 1),
        muted: false,
        speed: Number(clip.speed) || 1,
        fadeIn: Number(clip.fadeIn) || 0,
        fadeOut: Number(clip.fadeOut) || 0,
        loop: false,
        linkedMainId: clip.id,
      };
      clip.audioDetached = true;
      clip.muted = true;
      S.doc.audios.push(audio);
      created.push({ kind: 'audio', id: audio.id });
    }
  }, `detach-audio-${ready.map((entry) => entry.clip.id).join('-')}`);
  selectMany(created);
  toast(created.length > 1 ? `已分离 ${created.length} 条音轨` : '已分离音轨，可在音轨轨独立剪辑', 'ok');
  return created[0] ? { kind: 'audio', id: created[0].id } : null;
}

export function addText() {
  const duration = Math.max(0.5, Math.min(3, mainDuration() - S.playhead || 3));
  const item = {
    id: newId('t'),
    trackId: targetTrack('text')?.id,
    text: '双击编辑字幕',
    start: S.playhead,
    duration: Math.min(duration, 3),
    x: 0.5,
    y: 0.82,
    size: Math.max(28, Math.round((S.doc.canvas.height / 1080) * 64)),
    color: '#ffffff',
    bg: false,
    bold: true,
  };
  mutate(() => { S.doc.texts.push(item); }, 'add-text');
  select('text', item.id);
  toast('字幕已添加，在右侧属性里编辑文字', 'ok');
  return item;
}

export function deleteSelected(confirm = false) {
  const items = selectionItems();
  if (!items.length) return false;
  const mainIds = new Set(items.filter((entry) => entry.kind === 'main').map((entry) => entry.item.id));
  const overlayIds = new Set(items.filter((entry) => entry.kind === 'overlay').map((entry) => entry.item.id));
  const audioIds = new Set(items.filter((entry) => entry.kind === 'audio').map((entry) => entry.item.id));
  const textIds = new Set(items.filter((entry) => entry.kind === 'text').map((entry) => entry.item.id));
  mutate(() => {
    if (mainIds.size) S.doc.main = S.doc.main.filter((entry) => !mainIds.has(entry.id));
    if (overlayIds.size) S.doc.overlays = S.doc.overlays.filter((entry) => !overlayIds.has(entry.id));
    if (audioIds.size) S.doc.audios = S.doc.audios.filter((entry) => !audioIds.has(entry.id));
    if (textIds.size) S.doc.texts = S.doc.texts.filter((entry) => !textIds.has(entry.id));
  }, `delete-${items.map((entry) => entry.item.id).join('-')}`);
  select(null);
  setPlayhead(S.playhead);
  if (items.length > 1) toast(`已删除 ${items.length} 个片段`, 'ok', 1800);
  return true;
}

export function duplicateSelected() {
  const items = selectionItems();
  if (!items.length) return null;
  const created = [];
  mutate(() => {
    const mainIds = new Set(items.filter((entry) => entry.kind === 'main').map((entry) => entry.item.id));
    if (mainIds.size) {
      const next = [];
      for (const clip of S.doc.main) {
        next.push(clip);
        if (mainIds.has(clip.id)) {
          const copy = JSON.parse(JSON.stringify(clip));
          copy.id = newId('m');
          if (copy.audioDetached) {
            // 分离后的主轨复制品恢复自带原声，避免复制出无声片段。
            copy.audioDetached = false;
            copy.muted = false;
          }
          next.push(copy);
          created.push({ kind: 'main', id: copy.id });
        }
      }
      S.doc.main = next;
    }
    for (const { kind, item } of items) {
      if (kind === 'main') continue;
      const copy = JSON.parse(JSON.stringify(item));
      copy.id = newId(kind === 'overlay' ? 'o' : kind === 'audio' ? 'a' : 't');
      copy.start = clamp(Number(item.start || 0) + 0.25, 0,
        Math.max(0, mainDuration() - 0.2));
      if (kind === 'overlay') S.doc.overlays.push(copy);
      else if (kind === 'audio') S.doc.audios.push(copy);
      else S.doc.texts.push(copy);
      created.push({ kind, id: copy.id });
    }
  }, `duplicate-${items.map((entry) => entry.item.id).join('-')}`);
  selectMany(created);
  toast(created.length > 1 ? `已复制 ${created.length} 个片段` : '已复制到时间线', 'ok');
  return created;
}

export function copySelected() {
  const items = selectionItems();
  if (!items.length) return 0;
  const nonMain = items.filter((entry) => entry.kind !== 'main');
  const minStart = nonMain.length
    ? Math.min(...nonMain.map((entry) => Number(entry.item.start) || 0))
    : 0;
  S.clipboard = {
    at: S.playhead,
    items: items.map(({ kind, item }) => ({
      kind,
      item: JSON.parse(JSON.stringify(item)),
      offset: kind === 'main' ? null : Math.round(((Number(item.start) || 0) - minStart) * 1000) / 1000,
    })),
  };
  toast(`已复制 ${items.length} 个片段`, 'ok', 1600);
  return items.length;
}

export function cutSelected() {
  const items = selectionItems();
  if (!items.length) return 0;
  copySelected();
  deleteSelected();
  toast(`已剪切 ${items.length} 个片段`, 'ok', 1600);
  return items.length;
}

export function pasteClipboard() {
  const board = S.clipboard;
  if (!board || !board.items?.length) return 0;
  const created = [];
  const at = S.playhead;
  mutate(() => {
    const mainCopies = board.items
      .filter((entry) => entry.kind === 'main')
      .map((entry) => JSON.parse(JSON.stringify(entry.item)));
    if (mainCopies.length) {
      let index = S.doc.main.length;
      let cursor = 0;
      for (let i = 0; i < S.doc.main.length; i += 1) {
        const length = clipDuration(S.doc.main[i]);
        if (at < cursor + length / 2) { index = i; break; }
        cursor += length;
      }
      for (const copy of mainCopies) {
        copy.id = newId('m');
        created.push({ kind: 'main', id: copy.id });
      }
      S.doc.main.splice(index, 0, ...mainCopies);
    }
    for (const entry of board.items) {
      if (entry.kind === 'main') continue;
      const copy = JSON.parse(JSON.stringify(entry.item));
      copy.id = newId(entry.kind === 'overlay' ? 'o' : entry.kind === 'audio' ? 'a' : 't');
      copy.start = clamp(at + Number(entry.offset || 0), 0,
        Math.max(0, mainDuration() - 0.2));
      if (entry.kind === 'overlay') S.doc.overlays.push(copy);
      else if (entry.kind === 'audio') S.doc.audios.push(copy);
      else S.doc.texts.push(copy);
      created.push({ kind: entry.kind, id: copy.id });
    }
  }, 'paste-clipboard');
  if (!created.length) return 0;
  selectMany(created);
  toast(`已粘贴 ${created.length} 个片段`, 'ok', 1600);
  return created.length;
}

export function toggleMuteSelected() {
  const items = selectionItems().filter((entry) => entry.kind === 'main' || entry.kind === 'audio');
  if (!items.length) return 0;
  const muted = !items.every(({ item }) => item.muted);
  mutate(() => {
    for (const { item } of items) item.muted = muted;
  }, 'toggle-mute-selected');
  toast(muted ? `已静音 ${items.length} 个片段` : `已取消静音 ${items.length} 个片段`, 'ok', 1600);
  return items.length;
}

function buildOverlayFromMain(clip, trackId, start) {
  return {
    id: newId('o'),
    kind: 'video',
    trackId,
    src: clip.src,
    in: Number(clip.in) || 0,
    start: Math.max(0, Math.round(start * 1000) / 1000),
    duration: Math.max(0.2, Math.round(clipDuration(clip) * 1000) / 1000),
    x: 0.5,
    y: 0.5,
    scale: cloneNumber(clip.scale, 1),
    rotate: Number(clip.rotate) || 0,
    opacity: 1,
  };
}

function buildAudioFromMain(clip, start, overlayId = '') {
  const track = firstTrack('audio');
  if (!track) return null;
  return {
    id: newId('a'),
    trackId: track.id,
    src: clip.src,
    in: Number(clip.in) || 0,
    start: Math.max(0, Math.round(start * 1000) / 1000),
    duration: Math.max(0.2, Math.round(clipDuration(clip) * 1000) / 1000),
    volume: cloneNumber(clip.volume, 1),
    muted: Boolean(clip.muted),
    speed: Number(clip.speed) || 1,
    fadeIn: Number(clip.fadeIn) || 0,
    fadeOut: Number(clip.fadeOut) || 0,
    loop: false,
    linkedMainId: null,
    linkedOverlayId: overlayId || null,
  };
}

function cloneNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function mainHasAudio(clip) {
  if (clip.hasAudio === false) return false;
  const meta = S.metaCache.get(clip.src);
  return !meta || meta.hasAudio !== false;
}

function mainClipOffsets() {
  const map = new Map();
  let cursor = 0;
  for (const clip of S.doc?.main || []) {
    const duration = clipDuration(clip);
    map.set(clip.id, cursor);
    cursor += duration;
  }
  return map;
}

export function moveMainClipToTrack(clipId, trackId, start) {
  const track = (S.doc?.tracks || []).find((entry) => entry.id === trackId);
  const clip = (S.doc?.main || []).find((entry) => entry.id === clipId);
  if (!track || !clip || track.type !== 'video') return 0;
  let overlayId = '';
  mutate(() => {
    const index = S.doc.main.findIndex((entry) => entry.id === clipId);
    if (index < 0) return;
    S.doc.main.splice(index, 1);
    const overlay = buildOverlayFromMain(clip, track.id, start);
    S.doc.overlays.push(overlay);
    overlayId = overlay.id;
    if (!clip.audioDetached && mainHasAudio(clip)) {
      const audio = buildAudioFromMain(clip, start, overlay.id);
      if (audio) S.doc.audios.push(audio);
    }
  }, `main-to-overlay-${clipId}`);
  if (!overlayId) return 0;
  select('overlay', overlayId);
  toast(`已转为叠加层并移动到「${track.name}」`, 'ok');
  if (!S.doc.main.length) toast('主轨已空：叠加层需要主轨画面作为底图，请再添加一段主轨视频', 'info', 5000);
  return 1;
}

function buildMainFromOverlay(overlay) {
  const meta = S.metaCache.get(overlay.src);
  const inPoint = Number(overlay.in) || 0;
  const duration = Math.max(0.05, Number(overlay.duration) || 0.05);
  return {
    id: newId('m'),
    kind: 'video',
    src: overlay.src,
    in: inPoint,
    out: inPoint + duration,
    speed: 1,
    volume: 1,
    muted: false,
    scale: clamp(cloneNumber(overlay.scale, 1), 0.05, 4),
    rotate: Number(overlay.rotate) || 0,
    flipH: false,
    flipV: false,
    fit: 'contain',
    fadeIn: 0,
    fadeOut: 0,
    mosaic: false,
    mosaicMode: 'pixel',
    mosaicBlock: 16,
    mosaicX: 0.25,
    mosaicY: 0.25,
    mosaicW: 0.5,
    mosaicH: 0.5,
    hasAudio: !(meta && meta.hasAudio === false),
    audioDetached: false,
  };
}

function mainInsertIndex(time) {
  const at = Math.max(0, Number(time) || 0);
  let index = S.doc.main.length;
  let cursor = 0;
  for (let i = 0; i < S.doc.main.length; i += 1) {
    const length = clipDuration(S.doc.main[i]);
    if (at < cursor + length / 2) { index = i; break; }
    cursor += length;
  }
  return index;
}

export function moveOverlayToMain(overlayId, start) {
  const overlay = (S.doc?.overlays || []).find((entry) => entry.id === overlayId);
  if (!overlay || overlay.kind !== 'video') return 0;
  const at = Number.isFinite(start) ? Math.max(0, start) : Math.max(0, Number(overlay.start) || 0);
  let clipId = '';
  mutate(() => {
    S.doc.overlays = S.doc.overlays.filter((entry) => entry.id !== overlayId);
    S.doc.audios = S.doc.audios.filter((entry) => entry.linkedOverlayId !== overlayId);
    const clip = buildMainFromOverlay(overlay);
    S.doc.main.splice(mainInsertIndex(at), 0, clip);
    clipId = clip.id;
  }, `overlay-to-main-${overlayId}`);
  if (!clipId) return 0;
  select('main', clipId);
  toast('已移回主视频轨（转为顺序片段）', 'ok');
  return 1;
}

export function moveSelectedToMain() {
  const overlays = selectionItems()
    .filter((entry) => entry.kind === 'overlay' && entry.item.kind === 'video')
    .map((entry) => entry.item)
    .sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
  if (!overlays.length) {
    toast('只有视频叠加层可以移回主视频轨；图片、音频、字幕不能作为主轨片段', 'err', 4500);
    return 0;
  }
  const ids = new Set(overlays.map((entry) => entry.id));
  const created = [];
  mutate(() => {
    S.doc.overlays = S.doc.overlays.filter((entry) => !ids.has(entry.id));
    S.doc.audios = S.doc.audios.filter((entry) => !ids.has(entry.linkedOverlayId));
    for (const overlay of overlays) {
      const clip = buildMainFromOverlay(overlay);
      S.doc.main.splice(mainInsertIndex(overlay.start || 0), 0, clip);
      created.push({ kind: 'main', id: clip.id });
    }
  }, 'overlays-to-main');
  selectMany(created);
  toast(`已将 ${created.length} 个视频叠加层移回主视频轨`, 'ok');
  return created.length;
}

export function moveSelectedToTrack(trackId) {
  const track = (S.doc?.tracks || []).find((entry) => entry.id === trackId);
  if (!track) return 0;
  const entries = selectionItems();
  if (!entries.length) return 0;
  const mains = entries.filter((entry) => entry.kind === 'main');
  const overlays = entries.filter((entry) => entry.kind === 'overlay');
  const audios = entries.filter((entry) => entry.kind === 'audio');
  const texts = entries.filter((entry) => entry.kind === 'text');
  const created = [];
  let moved = 0;
  let converted = 0;

  if (track.type === 'video') {
    const offsets = mainClipOffsets();
    const mainIds = new Set(mains.map((entry) => entry.item.id));
    if (mainIds.size || overlays.length) {
      mutate(() => {
        if (mainIds.size) {
          S.doc.main = S.doc.main.filter((clip) => !mainIds.has(clip.id));
        }
        for (const { item: clip } of mains) {
          const overlay = buildOverlayFromMain(clip, track.id, offsets.get(clip.id) || 0);
          S.doc.overlays.push(overlay);
          created.push({ kind: 'overlay', id: overlay.id });
          if (!clip.audioDetached && mainHasAudio(clip)) {
            const audio = buildAudioFromMain(clip, offsets.get(clip.id) || 0, overlay.id);
            if (audio) S.doc.audios.push(audio);
          }
          converted += 1;
        }
        for (const { item } of overlays) {
          item.trackId = track.id;
          created.push({ kind: 'overlay', id: item.id });
          moved += 1;
        }
      }, `move-track-${track.id}`);
    }
  } else if (track.type === 'audio') {
    if (audios.length) {
      mutate(() => {
        for (const { item } of audios) item.trackId = track.id;
        moved = audios.length;
      }, `move-track-${track.id}`);
    }
  } else if (track.type === 'text') {
    if (texts.length) {
      mutate(() => {
        for (const { item } of texts) item.trackId = track.id;
        moved = texts.length;
      }, `move-track-${track.id}`);
    }
  }

  const total = moved + converted;
  if (!total) {
    toast('选中的片段不能移动到这条轨道', 'err');
    return 0;
  }
  if (created.length) selectMany(created);
  if (converted) {
    toast(`已将 ${converted} 个主轨片段转为叠加层并移动到「${track.name}」`, 'ok');
    if (!S.doc.main.length) toast('主轨已空：叠加层需要主轨画面作为底图，请再添加一段主轨视频', 'info', 5000);
  } else {
    toast(`已移动 ${moved} 个片段到「${track.name}」`, 'ok');
  }
  return total;
}

export function moveSelectedToAdjacentTrack(delta) {
  const selected = selectionItems();
  if (!selected.length) {
    toast('请先选中要换轨的片段', 'err');
    return 0;
  }
  const first = selected[0];
  const type = first.kind === 'main' ? 'video'
    : first.kind === 'overlay' ? 'video' : first.kind;
  const tracks = tracksOfType(type);
  if (!tracks.length) return 0;
  let currentId = first.kind === 'main' ? null : first.item.trackId;
  if (first.kind === 'main') {
    const active = (S.doc?.tracks || []).find((entry) => entry.id === S.activeTrackId);
    currentId = active?.type === 'video' ? active.id : tracks[0].id;
  }
  if (!currentId || !tracks.some((entry) => entry.id === currentId)) currentId = tracks[0].id;
  const index = tracks.findIndex((entry) => entry.id === currentId);
  const target = clamp(index + Math.sign(delta || 1), 0, tracks.length - 1);
  if (target === index) {
    toast(index === 0 ? '已经是第一条同类轨道' : '已经是最后一条同类轨道', 'info', 1600);
    return 0;
  }
  return moveSelectedToTrack(tracks[target].id);
}

export function splitAllAtPlayhead() {
  if (!S.doc) return false;
  const targets = [];
  const offsets = mainOffsets();
  offsets.forEach((entry) => {
    const local = S.playhead - entry.start;
    if (local > 0.06 && local < entry.duration - 0.06) targets.push({ kind: 'main', item: entry.clip });
  });
  for (const [kind, list] of [['overlay', S.doc.overlays], ['audio', S.doc.audios], ['text', S.doc.texts]]) {
    for (const item of list || []) {
      const local = S.playhead - (Number(item.start) || 0);
      if (local > 0.06 && local < (Number(item.duration) || 0) - 0.06) targets.push({ kind, item });
    }
  }
  return splitTargets(targets);
}

export function splitAtPlayhead() {
  if (!S.doc) return false;
  const selected = selectionItems();
  let targets = selected;
  if (!targets.length) {
    const active = activeMain(S.playhead);
    targets = active ? [{ kind: 'main', item: active.clip }] : [];
  }
  return splitTargets(targets);
}

function splitTargets(targets) {
  if (!targets.length) {
    toast('播放头位置没有可分割的片段', 'err');
    return false;
  }
  if (!targets.length) return false;
  const rightSelections = [];
  let count = 0;
  mutate(() => {
    const mainTargets = new Set(targets.filter((entry) => entry.kind === 'main')
      .map((entry) => entry.item.id));
    if (mainTargets.size) {
      const next = [];
      let cursor = 0;
      for (const clip of S.doc.main) {
        const duration = clipDuration(clip);
        const local = S.playhead - cursor;
        next.push(clip);
        if (mainTargets.has(clip.id) && local > 0.06 && local < duration - 0.06) {
          const cutSource = Math.round((Number(clip.in) + local * Number(clip.speed || 1)) * 1000) / 1000;
          if (cutSource > Number(clip.in) + 0.01 && cutSource < Number(clip.out) - 0.01) {
            const right = JSON.parse(JSON.stringify(clip));
            right.id = newId('m');
            right.in = cutSource;
            right.fadeIn = 0;
            clip.out = cutSource;
            clip.fadeOut = 0;
            next.push(right);
            rightSelections.push({ kind: 'main', id: right.id });
            count += 1;
          }
        }
        cursor += duration;
      }
      S.doc.main = next;
    }
    for (const { kind, item } of targets) {
      if (kind === 'main') continue;
      const start = Number(item.start) || 0;
      const duration = Number(item.duration) || 0;
      const local = S.playhead - start;
      if (local <= 0.06 || local >= duration - 0.06) continue;
      const right = JSON.parse(JSON.stringify(item));
      right.id = newId(kind === 'overlay' ? 'o' : kind === 'audio' ? 'a' : 't');
      right.start = Math.round(S.playhead * 1000) / 1000;
      right.duration = Math.round((duration - local) * 1000) / 1000;
      if (kind === 'overlay') {
        if (right.kind === 'video') right.in = Number(right.in || 0) + local;
        S.doc.overlays.push(right);
      } else if (kind === 'audio') {
        right.in = Number(right.in || 0) + local * Number(right.speed || 1);
        S.doc.audios.push(right);
      } else {
        S.doc.texts.push(right);
      }
      item.duration = Math.round(local * 1000) / 1000;
      rightSelections.push({ kind, id: right.id });
      count += 1;
    }
  }, `split-${targets.map((entry) => entry.item.id).join('-')}`);
  if (!count) {
    toast('把播放头移到选中片段内部才能分割', 'err');
    return false;
  }
  selectMany(rightSelections);
  toast(`已在播放头处分割 ${count} 个片段`, 'ok');
  return true;
}

export function moveMain(delta) {
  const selected = selectedItem();
  if (!selected || selected.kind !== 'main') return;
  const index = S.doc.main.findIndex((entry) => entry.id === selected.item.id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= S.doc.main.length) return;
  mutate(() => {
    const [clip] = S.doc.main.splice(index, 1);
    S.doc.main.splice(target, 0, clip);
  }, `move-main-${selected.item.id}`);
  toast(`已${delta < 0 ? '上移' : '下移'}片段`, 'ok', 1500);
}

export function trimToPlayhead(edge) {
  const selected = selectedItem();
  if (!selected || selected.kind !== 'main') return;
  const offsets = mainOffsets();
  const entry = offsets.find((item) => item.clip.id === selected.item.id);
  if (!entry) return;
  const local = S.playhead - entry.start;
  if (local <= 0.05 || local >= entry.duration - 0.05) {
    toast('播放头不在该片段内部', 'err');
    return;
  }
  const sourcePoint = Number(selected.item.in) + local * Number(selected.item.speed || 1);
  mutate(() => {
    if (edge === 'in') selected.item.in = Math.round(sourcePoint * 1000) / 1000;
    else selected.item.out = Math.round(sourcePoint * 1000) / 1000;
  }, `trim-${edge}-${selected.item.id}`);
  toast(edge === 'in' ? '已裁掉播放头之前的部分' : '已裁掉播放头之后的部分', 'ok');
}

export function addTextAt(time) {
  const previous = S.playhead;
  setPlayhead(time);
  const item = addText();
  return item;
}

export function selectionInfo() {
  const selected = selectedItem();
  if (!selected) return null;
  return { ...selected, title: titleFor(selected.kind, selected.item), count: selectionItems().length };
}

export function timeLabel(seconds) {
  return fmtTime(seconds);
}


export function rippleDeleteSelected() {
  const items = selectionItems();
  if (!items.length) return false;
  const removed = items.map((entry) => ({
    kind: entry.kind, id: entry.item.id,
    trackId: entry.item.trackId || (entry.kind === 'main' ? 'v1' : ''),
    start: Number(entry.item.start) || 0,
    duration: clipDuration(entry.item) || Number(entry.item.duration) || 0,
  }));
  mutate(() => {
    for (const row of removed) {
      if (row.kind === 'main') {
        S.doc.main = S.doc.main.filter((clip) => clip.id !== row.id);
        continue;
      }
      const list = row.kind === 'overlay' ? S.doc.overlays : row.kind === 'audio' ? S.doc.audios : S.doc.texts;
      const index = (list || []).findIndex((item) => item.id === row.id);
      if (index < 0) continue;
      list.splice(index, 1);
      for (const item of list) {
        if ((item.trackId || '') === row.trackId && (Number(item.start) || 0) >= row.start - 0.001) {
          item.start = Math.max(0, Math.round(((Number(item.start) || 0) - row.duration) * 1000) / 1000);
        }
      }
    }
  }, `ripple-${removed.map((row) => row.id).join('-')}`);
  select(null);
  setPlayhead(S.playhead);
  toast(`波纹删除 ${removed.length} 个片段，后续素材已前移`, 'ok');
  return true;
}

export async function freezeFrame() {
  const picked = selectionItems().find((entry) => entry.kind === 'main');
  const active = picked || (activeMain(S.playhead) ? { item: activeMain(S.playhead).clip } : null);
  if (!active) { toast('请先选中主轨片段', 'err'); return false; }
  const clip = active.item;
  const offset = mainOffsets().find((entry) => entry.clip.id === clip.id);
  const local = Math.max(0, S.playhead - (offset ? offset.start : 0));
  const sourceTime = (Number(clip.in) || 0) + local * (Number(clip.speed) || 1);
  toast('正在生成冻结帧…', 'info', 2500);
  try {
    const result = await api.post('/api/derive', { op: 'freeze', src: clip.src, time: sourceTime, duration: 3 });
    mutate(() => {
      const index = S.doc.main.findIndex((row) => row.id === clip.id);
      const next = JSON.parse(JSON.stringify(clip));
      next.id = newId('m');
      next.src = result.path;
      next.in = 0;
      next.out = result.duration;
      next.speed = 1;
      next.audioDetached = true;
      next.transition = null;
      next.effects = [];
      next.keyframes = {};
      S.doc.main.splice(index + 1, 0, next);
    }, `freeze-${clip.id}`);
    toast('已插入 3 秒冻结帧', 'ok');
    return true;
  } catch (error) {
    toast(`冻结帧失败：${error.message}`, 'err', 5000);
    return false;
  }
}

export async function reverseClip() {
  const picked = selectionItems().find((entry) => entry.kind === 'main');
  if (!picked) { toast('请先选中主轨片段', 'err'); return false; }
  const clip = picked.item;
  const duration = clipDuration(clip);
  toast('正在生成倒放片段…', 'info', 3000);
  try {
    const result = await api.post('/api/derive', { op: 'reverse', src: clip.src,
      time: Number(clip.in) || 0, duration: Math.max(0.2, duration * (Number(clip.speed) || 1)) });
    mutate(() => {
      clip.src = result.path;
      clip.in = 0;
      clip.out = result.duration;
      clip.speed = 1;
      clip.transition = null;
    }, `reverse-${clip.id}`);
    toast('片段已倒放', 'ok');
    return true;
  } catch (error) {
    toast(`倒放失败：${error.message}`, 'err', 5000);
    return false;
  }
}

export function addTrack(type, name = '') {
  const valid = new Set(['video', 'audio', 'text']);
  if (!valid.has(type)) return null;
  if (tracksOfType(type).length >= 12) {
    toast('每种类型的轨道最多 12 条', 'err');
    return null;
  }
  const label = { video: '视频轨', audio: '音轨', text: '字幕轨' }[type];
  const track = {
    id: newId('trk'),
    type,
    name: (name || '').trim().slice(0, 40) || `${label} ${tracksOfType(type).length + 1}`,
  };
  S.activeTrackId = track.id;
  mutate(() => {
    if (type === 'video') {
      const index = S.doc.tracks.findIndex((item) => item.type === 'video');
      S.doc.tracks.splice(index < 0 ? S.doc.tracks.length : index, 0, track);
    } else {
      const last = S.doc.tracks.map((item) => item.type).lastIndexOf(type);
      S.doc.tracks.splice(last < 0 ? S.doc.tracks.length : last + 1, 0, track);
    }
  }, `add-track-${track.id}`);
  toast(`已创建「${track.name}」`, 'ok');
  return track;
}

export async function deleteTrack(trackId) {
  const track = (S.doc?.tracks || []).find((item) => item.id === trackId);
  if (!track) return false;
  const sameType = tracksOfType(track.type);
  if (sameType.length <= 1) {
    toast('每种轨道至少保留一条，不能删除最后一条', 'err');
    return false;
  }
  const kind = track.type;
  const items = S.doc[kind === 'video' ? 'overlays' : kind === 'audio' ? 'audios' : 'texts']
    .filter((item) => item.trackId === trackId);
  if (items.length) {
    const ok = await confirmDialog('删除轨道', `「${track.name}」上还有 ${items.length} 个素材，删除后会移动到同类型第一条轨道。`, '删除轨道');
    if (!ok) return false;
  }
  const fallback = sameType.find((item) => item.id !== trackId);
  if (S.activeTrackId === trackId) S.activeTrackId = fallback.id;
  mutate(() => {
    const list = S.doc[kind === 'video' ? 'overlays' : kind === 'audio' ? 'audios' : 'texts'];
    for (const item of list) {
      if (item.trackId === trackId) item.trackId = fallback.id;
    }
    S.doc.tracks = S.doc.tracks.filter((item) => item.id !== trackId);
  }, `delete-track-${trackId}`);
  toast(`轨道「${track.name}」已删除`, 'ok');
  return true;
}
