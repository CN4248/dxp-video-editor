import {
  S, clamp, clipDuration, findItem, isSelected, mainDuration, mainOffsets, mutate, on, redo,
  select, selectAll, selectMany, selectionCount, setPlayhead, stepFrame, tracksOfType, undo,
} from './store.js';
import { preview } from './preview.js';
import { api } from './api.js';
import {
  addMediaToTrack, addMain, addText, addTrack, deleteSelected, deleteTrack, duplicateSelected,
  moveMainClipToTrack, moveOverlayToMain, separateAudio, splitAtPlayhead,
} from './actions.js';
import { handleBuiltinDrop } from './builtins.js';
import {
  $, escapeHtml, fmtTime, fmtTimeShort, icon, closeModal, openModal, toast,
} from './ui.js';

let pps = 48;
let drag = null;
let trimRaf = 0;

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900];

function contentEl() { return $('#tlContent'); }
function scrollEl() { return $('#tlScroll'); }

function timeAt(clientX) {
  const rect = contentEl().getBoundingClientRect();
  return Math.max(0, (clientX - rect.left) / pps);
}

function typeIcon(type) {
  return type === 'video' ? 'layers' : type === 'audio' ? 'music' : 'type';
}

function kindIcon(kind) {
  return kind === 'main' ? 'film' : kind === 'overlay' ? 'layers' : kind === 'audio' ? 'music' : 'type';
}

function blockLabel(kind, item) {
  if (kind === 'text') return item.text || '字幕';
  return String(item.src || '').split('/').pop() || kind;
}

function buildBlock(kind, item, left, width, trackId = '') {
  const selected = isSelected(kind, item.id);
  const audioMeta = kind === 'audio'
    ? ` data-src="${escapeHtml(item.src)}" data-in="${Number(item.in) || 0}" data-dur="${Number(item.duration) || 0}" data-speed="${Number(item.speed) || 1}"`
    : '';
  const label = blockLabel(kind, item);
  const dur = kind === 'main' ? clipDuration(item) : Number(item.duration);
  const showDur = width > 86;
  return `<div class="block ${kind}${selected ? ' selected' : ''}" data-kind="${kind}" data-id="${item.id}"${trackId ? ` data-track-id="${trackId}"` : ''}${audioMeta}
      style="left:${left.toFixed(2)}px;width:${Math.max(12, width).toFixed(2)}px" title="${escapeHtml(label)}">
      ${width > 30 ? '<span class="handle l" data-handle="l"></span>' : ''}
      ${icon(kindIcon(kind), 'icon bicon')}
      <span class="btitle">${escapeHtml(label)}</span>
      ${showDur ? `<span class="bdur">${fmtTimeShort(dur)}</span>` : ''}
      ${width > 30 ? '<span class="handle r" data-handle="r"></span>' : ''}
    </div>`;
}

function linkedAudioHtml(clip, left, width) {
  const selected = isSelected('main', clip.id);
  const label = `原声 · ${String(clip.src).split('/').pop()}`;
  return `<div class="block audio linked${clip.muted ? ' muted' : ''}${selected ? ' selected' : ''}"
    data-kind="main" data-id="${clip.id}" data-linked="1"
    data-src="${escapeHtml(clip.src)}" data-in="${Number(clip.in) || 0}" data-dur="${clipDuration(clip)}" data-speed="${Number(clip.speed) || 1}"
    style="left:${left.toFixed(2)}px;width:${Math.max(12, width).toFixed(2)}px"
    title="原声轨 · 跟随主轨 · 双击分离">
    ${icon('music', 'icon bicon')}
    <span class="btitle">${escapeHtml(label)}</span>
    ${width > 96 ? `<span class="bdur">${fmtTimeShort(clipDuration(clip))}</span>` : ''}
  </div>`;
}

function trackLabelHtml(track) {
  const active = S.activeTrackId === track.id;
  const audio = track.type === 'audio';
  return `<div class="track-label ${track.type}${active ? ' active' : ''}" data-track-id="${track.id}" title="点击选中这条轨道">
    ${icon(typeIcon(track.type))}
    <span class="tname">${escapeHtml(track.name)}</span>
    <span class="track-actions">
      ${audio ? `<button class="tact${track.muted ? ' on' : ''}" data-track-act="muted" data-track-id="${track.id}" type="button" title="静音轨道">M</button>
      <button class="tact${track.solo ? ' on' : ''}" data-track-act="solo" data-track-id="${track.id}" type="button" title="独奏轨道">S</button>` : ''}
      <button class="tact${track.hidden ? ' on' : ''}" data-track-act="hidden" data-track-id="${track.id}" type="button" title="隐藏轨道">H</button>
      <button class="tact${track.locked ? ' on' : ''}" data-track-act="locked" data-track-id="${track.id}" type="button" title="锁定轨道">L</button>
    </span>
    <button class="track-del" data-del-track="${track.id}" type="button" title="删除轨道">×</button>
  </div>`;
}

function laneHtml(track, firstAudioId, linkedAudio) {
  const fallback = (type) => (S.doc.tracks || []).find((item) => item.type === type)?.id;
  if (track.type === 'video') {
    const firstId = fallback('video');
    return (S.doc.overlays || [])
      .filter((item) => (item.trackId || firstId) === track.id)
      .map((item) => buildBlock('overlay', item, item.start * pps, item.duration * pps, track.id))
      .join('');
  }
  if (track.type === 'audio') {
    const firstId = fallback('audio');
    const linked = track.id === firstAudioId ? linkedAudio : '';
    return linked + (S.doc.audios || [])
      .filter((item) => (item.trackId || firstId) === track.id)
      .map((item) => buildBlock('audio', item, item.start * pps, item.duration * pps, track.id))
      .join('');
  }
  const firstId = fallback('text');
  return (S.doc.texts || [])
    .filter((item) => (item.trackId || firstId) === track.id)
    .map((item) => buildBlock('text', item, item.start * pps, item.duration * pps, track.id))
    .join('');
}

function syncLabelScroll() {
  const scroll = scrollEl();
  const inner = $('#tlLabelsInner');
  if (scroll && inner) inner.style.transform = `translateY(${-scroll.scrollTop}px)`;
}

function updatePlayheadButtons() {
  const hasSelection = selectionCount() > 0;
  $('#deleteBtn').disabled = !hasSelection;
  $('#duplicateBtn').disabled = !hasSelection;
  $('#undoBtn').disabled = !S.history.length;
  $('#redoBtn').disabled = !S.future.length;
  const noMain = !S.doc?.main?.length;
  $('#prevFrameBtn').disabled = noMain;
  $('#nextFrameBtn').disabled = noMain;
  const nothing = !S.doc || (!S.doc.main?.length && !S.doc.overlays?.length
    && !S.doc.audios?.length && !S.doc.texts?.length);
  const selectAllBtn = $('#selectAllBtn');
  if (selectAllBtn) selectAllBtn.disabled = nothing;
}

export function renderTimeline() {
  if (!S.doc) return;
  pps = S.zoom;
  const duration = mainDuration();
  const scroll = scrollEl();
  const content = contentEl();
  const viewWidth = scroll.clientWidth || 800;
  const width = Math.max(viewWidth, duration * pps + 260, 640);
  content.style.width = `${Math.round(width)}px`;
  $('#zoomLabel').textContent = `${Math.round(pps)} px/s`;
  $('#tlDuration').textContent = fmtTime(duration, 1);

  const step = TICK_STEPS.find((value) => value * pps >= 70) || 900;
  const total = width / pps;
  let ticks = '';
  for (let time = 0; time <= total + 0.001; time += step) {
    const major = Math.abs(time / (step * 5) - Math.round(time / (step * 5))) < 0.001;
    ticks += `<div class="tick${major ? ' major' : ''}" style="left:${(time * pps).toFixed(1)}px">
      ${major ? `<span>${fmtTimeShort(time)}</span>` : ''}</div>`;
  }
  const offsets = mainOffsets();
  let mainHtml = '';
  let transHtml = '';
  offsets.forEach((entry, index) => {
    mainHtml += buildBlock('main', entry.clip, entry.start * pps, entry.duration * pps);
    if (entry.transition > 0) {
      transHtml += `<div class="tl-trans" style="left:${(entry.start * pps).toFixed(1)}px;width:${(entry.transition * pps).toFixed(1)}px" title="转场：${escapeHtml(entry.clip.transition?.type || 'fade')} · ${entry.transition.toFixed(2)}s">${index > 0 ? '⇄' : ''}</div>`;
    }
  });
  $('#laneMain').innerHTML = mainHtml + transHtml;
  const markers = (S.doc.markers || []).map((marker) => `<div class="tl-marker" data-marker-id="${marker.id}" style="left:${(Number(marker.time || 0) * pps).toFixed(1)}px" title="${escapeHtml(marker.label || '标记')} · 双击删除"><i></i><span>${escapeHtml(marker.label || '')}</span></div>`).join('');
  $('#tlRuler').innerHTML = ticks + markers;

  const tracks = S.doc.tracks || [];
  const videoTracks = tracks.filter((track) => track.type === 'video');
  const audioTracks = tracks.filter((track) => track.type === 'audio');
  const textTracks = tracks.filter((track) => track.type === 'text');
  const displayTracks = [...videoTracks, ...audioTracks, ...textTracks];
  const firstAudioId = audioTracks[0]?.id || '';

  let linkedAudio = '';
  for (const entry of offsets) {
    const clip = entry.clip;
    const meta = S.metaCache.get(clip.src);
    const hasAudio = clip.hasAudio !== false && (!meta || meta.hasAudio !== false);
    if (hasAudio && !clip.audioDetached) {
      linkedAudio += linkedAudioHtml(clip, entry.start * pps, entry.duration * pps);
    }
  }

  $('#tlTrackLabels').innerHTML = displayTracks.map(trackLabelHtml).join('');
  $('#tlDynamicTracks').innerHTML = displayTracks.map((track) => `
    <div class="track" data-track-id="${track.id}">
      <div class="lane" data-lane="${track.id}">${laneHtml(track, firstAudioId, linkedAudio)}</div>
    </div>`).join('');

  document.querySelector('.track-label.main')?.classList.toggle('active', !S.activeTrackId);

  const empty = !S.doc.main.length && !S.doc.overlays.length && !S.doc.audios.length && !S.doc.texts.length;
  $('#timelineEmpty').classList.toggle('hidden', !empty);
  $('#splitBtn').disabled = !S.doc.main.length;
  updatePlayheadButtons();
  syncLabelScroll();
  updatePlayhead(false);
  paintWaveforms();
}

// ------------------------------------------------------------ 音频波形

const waveCache = new Map();
let waveToken = 0;

async function peaksFor(src, start, duration, buckets) {
  const key = `${src}|${start}|${duration}|${buckets}`;
  if (waveCache.has(key)) return waveCache.get(key);
  const query = `path=${encodeURIComponent(src)}&start=${start}&duration=${duration}&buckets=${buckets}`;
  try {
    const data = await api.get(`/api/waveform?${query}`);
    const peaks = Array.isArray(data?.peaks) ? data.peaks : [];
    waveCache.set(key, peaks);
    return peaks;
  } catch (error) {
    waveCache.set(key, []);
    return [];
  }
}

async function paintWaveforms() {
  const token = ++waveToken;
  if (!S.showWaveforms) {
    document.querySelectorAll('.block.audio canvas.wave').forEach((canvas) => canvas.remove());
    return;
  }
  for (const block of document.querySelectorAll('.block.audio')) {
    if (token !== waveToken) return;
    const src = block.dataset.src;
    if (!src) continue;
    const width = Math.max(24, Math.round(block.clientWidth));
    const height = Math.max(12, Math.round(block.clientHeight));
    let canvas = block.querySelector('canvas.wave');
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'wave';
      block.prepend(canvas);
    }
    canvas.width = Math.round(width * (window.devicePixelRatio || 1));
    canvas.height = Math.round(height * (window.devicePixelRatio || 1));
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    const peaks = await peaksFor(src, Number(block.dataset.in) || 0,
      Number(block.dataset.dur) || 0, Math.min(1200, width));
    if (token !== waveToken || !block.isConnected) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const daylight = document.documentElement.dataset.theme === 'daylight';
    ctx.fillStyle = block.classList.contains('muted')
      ? (daylight ? 'rgba(51,65,85,.45)' : 'rgba(148,163,184,.35)')
      : (daylight ? 'rgba(4,120,87,.92)' : 'rgba(110,231,183,.55)');
    const mid = canvas.height / 2;
    const step = canvas.width / Math.max(1, peaks.length);
    peaks.forEach((peak, index) => {
      const bar = Math.max(1, peak * canvas.height * 0.92);
      ctx.fillRect(index * step, mid - bar / 2, Math.max(1, step - 0.6), bar);
    });
  }
}

export function updatePlayhead(ensureVisible = true) {
  const playhead = $('#tlPlayhead');
  if (!playhead) return;
  const left = S.playhead * pps;
  playhead.style.left = `${left.toFixed(2)}px`;
  const scroll = scrollEl();
  if (ensureVisible && S.playing) {
    if (left > scroll.scrollLeft + scroll.clientWidth - 50) {
      scroll.scrollLeft = left - scroll.clientWidth * 0.35;
    } else if (left < scroll.scrollLeft + 10) {
      scroll.scrollLeft = Math.max(0, left - 50);
    }
  }
}

// ------------------------------------------------------------ 拖动落点反馈

function ensureGhost(lane, left, width) {
  document.querySelectorAll('.drop-ghost').forEach((node) => {
    if (node.parentElement !== lane) node.remove();
  });
  let ghost = lane.querySelector('.drop-ghost');
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.className = 'drop-ghost';
    lane.appendChild(ghost);
  }
  ghost.style.left = `${Math.max(0, left).toFixed(2)}px`;
  ghost.style.width = `${Math.max(12, width).toFixed(2)}px`;
}

function showSnap(left, label) {
  const line = $('#tlSnapLine');
  const text = $('#tlSnapLabel');
  if (!line) return;
  line.classList.remove('hidden');
  line.style.left = `${left.toFixed(2)}px`;
  if (text) text.textContent = label;
}

function hideSnap() {
  $('#tlSnapLine')?.classList.add('hidden');
}

function showDragTip(event, label) {
  const tip = $('#tlDragTip');
  const body = $('.tl-body');
  if (!tip || !body) return;
  const rect = body.getBoundingClientRect();
  tip.classList.remove('hidden');
  tip.textContent = label;
  const half = Math.max(48, (tip.offsetWidth || 120) / 2 + 6);
  const minLeft = Math.min(rect.width / 2, 112 + half);
  tip.style.left = `${Math.max(minLeft, Math.min(rect.width - half, event.clientX - rect.left))}px`;
  tip.style.top = `${Math.max(18, event.clientY - rect.top)}px`;
}

function hideDragTip() {
  $('#tlDragTip')?.classList.add('hidden');
}

function clearDragUi() {
  document.querySelectorAll('.drop-ghost').forEach((node) => node.remove());
  document.querySelectorAll('.lane.drag-target').forEach((node) => node.classList.remove('drag-target'));
  document.querySelectorAll('.lane.compatible').forEach((node) => node.classList.remove('compatible'));
  document.querySelectorAll('.track-label.drag-target').forEach((node) => node.classList.remove('drag-target'));
  hideSnap();
  hideDragTip();
  contentEl()?.classList.remove('dragging');
  document.body.classList.remove('is-dragging');
}

function flashBlock(kind, id) {
  const block = document.querySelector(`.block[data-kind="${kind}"][data-id="${id}"]`);
  if (!block) return;
  block.classList.add('just-dropped');
  setTimeout(() => block.classList.remove('just-dropped'), 500);
}

function snapTime(value) {
  return S.snap ? Math.round(value * 20) / 20 : value;
}

function dragTargetTrack(clientX, clientY, kind, itemKind = '') {
  document.querySelectorAll('.lane.drag-target').forEach((node) => node.classList.remove('drag-target'));
  document.querySelectorAll('.track-label.drag-target').forEach((node) => node.classList.remove('drag-target'));
  const element = document.elementFromPoint(clientX, clientY);
  const info = element?.closest('.lane')
    ? laneInfo(element.closest('.lane'))
    : trackLabelInfo(element?.closest('.track-label'));
  if (!info) return null;
  if (info.type === 'main') {
    if (kind !== 'overlay' || itemKind !== 'video') return null;
    info.lane?.classList.add('drag-target');
    info.label?.classList.add('drag-target');
    return { main: true, lane: info.lane };
  }
  const expected = kind === 'main' ? 'video' : kind === 'overlay' ? 'video' : kind === 'audio' ? 'audio' : 'text';
  if (!info.track || info.track.type !== expected) return null;
  info.lane?.classList.add('drag-target');
  info.label?.classList.add('drag-target');
  return { track: info.track, lane: info.lane };
}

function markCompatibleLanes(kind, item) {
  document.querySelectorAll('.lane.compatible').forEach((node) => node.classList.remove('compatible'));
  if (kind === 'main') {
    $('#laneMain')?.classList.add('compatible');
    for (const lane of document.querySelectorAll('#tlDynamicTracks .lane')) {
      const track = (S.doc.tracks || []).find((entry) => entry.id === lane.dataset.lane);
      if (track?.type === 'video') lane.classList.add('compatible');
    }
    return;
  }
  const type = kind === 'overlay' ? 'video' : kind === 'audio' ? 'audio' : 'text';
  if (kind === 'overlay' && item?.kind === 'video') $('#laneMain')?.classList.add('compatible');
  for (const lane of document.querySelectorAll('#tlDynamicTracks .lane')) {
    const track = (S.doc.tracks || []).find((entry) => entry.id === lane.dataset.lane);
    if (track?.type === type) lane.classList.add('compatible');
  }
}

function computeMainTarget(clientX, current) {
  const rect = contentEl().getBoundingClientRect();
  const pointerStart = (clientX - rect.left - current.grabOffset) / pps;
  const others = S.doc.main.filter((clip) => clip.id !== current.id);
  let index = 0;
  let cursor = 0;
  for (const clip of others) {
    const dur = clipDuration(clip);
    if (pointerStart >= cursor + dur / 2) index += 1;
    cursor += dur;
  }
  let boundary = 0;
  for (let i = 0; i < index; i += 1) boundary += clipDuration(others[i]);
  return { index, boundary };
}

function applyMainGap(current, targetIndex) {
  const others = S.doc.main.filter((clip) => clip.id !== current.id);
  others.forEach((clip, index) => {
    const block = document.querySelector(`.block.main[data-id="${clip.id}"]`);
    if (!block) return;
    block.style.transform = index >= targetIndex ? `translateX(${current.widthPx}px)` : '';
  });
}

function scheduleTrimRender() {
  if (trimRaf) return;
  trimRaf = requestAnimationFrame(() => {
    trimRaf = 0;
    renderTimeline();
  });
}

const MARQUEE_HOLD_MS = 280;
const MARQUEE_MOVE_PX = 8;
let marqueeState = null;

function startEmptyGesture(event, lane) {
  const body = $('.tl-body');
  if (!body) return;
  event.preventDefault();
  if (lane) S.activeTrackId = lane.dataset.lane || null;
  const additive = event.metaKey || event.ctrlKey || event.shiftKey;
  if (!additive) select(null);
  setPlayhead(timeAt(event.clientX));

  const bodyRect = body.getBoundingClientRect();
  const state = {
    startX: event.clientX,
    startY: event.clientY,
    additive,
    active: false,
    moved: false,
    timer: 0,
    box: null,
  };
  marqueeState = state;

  const clampPoint = (value, low, high) => Math.max(low, Math.min(high, value));
  const updateBox = (clientX, clientY) => {
    if (!state.box) return;
    const left = clampPoint(Math.min(state.startX, clientX) - bodyRect.left, 0, bodyRect.width);
    const top = clampPoint(Math.min(state.startY, clientY) - bodyRect.top, 0, bodyRect.height);
    const right = clampPoint(Math.max(state.startX, clientX) - bodyRect.left, 0, bodyRect.width);
    const bottom = clampPoint(Math.max(state.startY, clientY) - bodyRect.top, 0, bodyRect.height);
    state.box.style.left = `${left}px`;
    state.box.style.top = `${top}px`;
    state.box.style.width = `${Math.max(0, right - left)}px`;
    state.box.style.height = `${Math.max(0, bottom - top)}px`;
  };
  const activate = () => {
    state.timer = 0;
    if (!marqueeState || marqueeState !== state) return;
    state.active = true;
    const box = document.createElement('div');
    box.className = 'marquee-box';
    box.innerHTML = '<span>框选中 · 拖动多选</span>';
    body.appendChild(box);
    state.box = box;
    updateBox(state.startX, state.startY);
    document.body.classList.add('marquee-mode');
  };
  const finish = () => {
    if (!state.box) return;
    const rect = state.box.getBoundingClientRect();
    const seen = new Set();
    const entries = [];
    if (state.additive) {
      for (const entry of S.selected || []) {
        const key = `${entry.kind}:${entry.id}`;
        seen.add(key);
        entries.push({ kind: entry.kind, id: entry.id });
      }
    }
    for (const block of document.querySelectorAll('#tlTracks .block')) {
      const kind = block.dataset.kind;
      const id = block.dataset.id;
      if (!kind || !id) continue;
      const key = `${kind}:${id}`;
      if (seen.has(key)) continue;
      const box = block.getBoundingClientRect();
      const hit = box.right > rect.left && box.left < rect.right
        && box.bottom > rect.top && box.top < rect.bottom;
      if (!hit) continue;
      seen.add(key);
      entries.push({ kind, id });
    }
    if (entries.length) selectMany(entries);
    else if (!state.additive) select(null);
  };
  const cleanup = () => {
    clearTimeout(state.timer);
    state.timer = 0;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    if (state.box) {
      state.box.remove();
      state.box = null;
    }
    document.body.classList.remove('marquee-mode');
    if (marqueeState === state) marqueeState = null;
  };
  const move = (moveEvent) => {
    const distance = Math.hypot(moveEvent.clientX - state.startX, moveEvent.clientY - state.startY);
    if (!state.active) {
      if (distance > MARQUEE_MOVE_PX) {
        state.moved = true;
        clearTimeout(state.timer);
        state.timer = 0;
        setPlayhead(timeAt(moveEvent.clientX));
      }
      return;
    }
    updateBox(moveEvent.clientX, moveEvent.clientY);
  };
  const up = () => {
    const wasActive = state.active;
    if (wasActive && state.box) finish();
    cleanup();
  };
  const cancel = () => cleanup();

  state.timer = setTimeout(activate, MARQUEE_HOLD_MS);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
  window.addEventListener('pointercancel', cancel, { once: true });
}

function startDrag(event) {
  if (event.button !== 0) return;
  const block = event.target.closest('.block');
  if (block) {
    event.preventDefault();
    const kind = block.dataset.kind;
    const id = block.dataset.id;
    const toggle = event.metaKey || event.ctrlKey;
    const range = event.shiftKey;
    if (block.dataset.linked) {
      select('main', id, { toggle, range });
      return;
    }
    const item = findItem(kind, id);
    if (!item) return;
    if (toggle || range) {
      select(kind, id, { toggle, range });
      return;
    }
    const handle = event.target.closest('.handle');
    const offsets = mainOffsets();
    const mainIndex = kind === 'main' ? S.doc.main.findIndex((clip) => clip.id === id) : -1;
    const rect = block.getBoundingClientRect();
    drag = {
      mode: handle ? `trim-${handle.dataset.handle}` : 'move',
      kind,
      id,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      item,
      orig: JSON.parse(JSON.stringify(item)),
      index: mainIndex,
      offsetStart: mainIndex >= 0 ? offsets[mainIndex].start : 0,
      block,
      grabOffset: event.clientX - rect.left,
      duration: kind === 'main' ? clipDuration(item) : Number(item.duration),
      widthPx: (kind === 'main' ? clipDuration(item) : Number(item.duration)) * pps,
      lane: block.parentElement,
      origLane: block.parentElement,
      targetTrackId: kind === 'main' ? null : (item.trackId || ''),
      targetStart: kind === 'main' ? (offsets[mainIndex]?.start || 0) : Number(item.start || 0),
      targetIndex: mainIndex,
      convertTrackId: null,
      convertStart: 0,
      toMain: false,
      mainStart: 0,
    };
    select(kind, id);
    const fresh = document.querySelector(`.block[data-kind="${kind}"][data-id="${id}"]`);
    if (fresh) {
      drag.block = fresh;
      drag.lane = fresh.parentElement;
      drag.origLane = fresh.parentElement;
      fresh.classList.add('dragging');
    } else {
      block.classList.add('dragging');
    }
    contentEl().classList.add('dragging');
    document.body.classList.add('is-dragging');
    if (drag.mode === 'move') markCompatibleLanes(kind, item);
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd, { once: true });
    return;
  }
  const ruler = event.target.closest('#tlRuler');
  const lane = event.target.closest('.lane');
  const body = event.target.closest('.tl-body');
  if (ruler || lane || (body && !event.target.closest('.track-label'))) {
    startEmptyGesture(event, lane);
  }
}

function onDragMove(event) {
  if (!drag) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  const delta = dx / pps;
  const item = drag.item;

  if (drag.mode === 'move' && drag.kind !== 'main') {
    const maxStart = Math.max(0, mainDuration() - drag.duration);
    const next = clamp(snapTime(Number(drag.orig.start || 0) + delta), 0, maxStart);
    drag.targetStart = next;
    const target = dragTargetTrack(event.clientX, event.clientY, drag.kind, drag.item.kind);
    drag.block.style.transform = `translateX(${((next - Number(drag.orig.start || 0)) * pps).toFixed(2)}px)`;
    if (target?.main) {
      drag.toMain = true;
      drag.targetTrackId = null;
      drag.mainStart = clamp(snapTime(Number(drag.orig.start || 0) + delta), 0, mainDuration());
      drag.lane = target.lane;
      ensureGhost(target.lane, drag.mainStart * pps, drag.duration * pps);
      showSnap(drag.mainStart * pps, `${fmtTime(drag.mainStart, 2)}`);
      showDragTip(event, `移回主视频轨 · ${fmtTime(drag.mainStart, 2)}`);
      return;
    }
    drag.toMain = false;
    drag.mainStart = 0;
    drag.targetTrackId = target ? target.track.id : (drag.item.trackId || '');
    drag.lane = target ? target.lane : drag.origLane;
    ensureGhost(drag.lane, next * pps, drag.duration * pps);
    showSnap(next * pps, `${fmtTime(next, 2)}`);
    const trackHint = target ? `移到「${target.track.name}」 · ` : '';
    showDragTip(event, `${trackHint}${fmtTime(next, 2)}`);
    return;
  }

  if (drag.mode === 'move' && drag.kind === 'main') {
    drag.block.style.transform = `translateX(${dx.toFixed(2)}px)`;
    const convert = dragTargetTrack(event.clientX, event.clientY, 'main');
    if (convert) {
      document.querySelectorAll('#laneMain .block').forEach((node) => { node.style.transform = ''; });
      drag.convertTrackId = convert.track.id;
      drag.convertStart = clamp(snapTime(Number(drag.orig.start || 0) + delta), 0,
        Math.max(0, mainDuration() - drag.duration));
      drag.lane = convert.lane;
      ensureGhost(convert.lane, drag.convertStart * pps, drag.widthPx);
      showSnap(drag.convertStart * pps, `${fmtTime(drag.convertStart, 2)}`);
      showDragTip(event, `松开转为叠加层「${convert.track.name}」 · ${fmtTime(drag.convertStart, 2)}`);
      return;
    }
    drag.convertTrackId = null;
    drag.lane = drag.origLane;
    const target = computeMainTarget(event.clientX, drag);
    drag.targetIndex = target.index;
    applyMainGap(drag, target.index);
    const mainLane = $('#laneMain');
    if (mainLane) ensureGhost(mainLane, target.boundary * pps, drag.widthPx);
    showSnap(target.boundary * pps, `插入位置 ${fmtTimeShort(target.boundary)}`);
    showDragTip(event, `插入位置 ${fmtTimeShort(target.boundary)}`);
    return;
  }

  if (drag.mode === 'trim-l') {
    if (drag.kind === 'main') {
      const speed = Number(drag.orig.speed) || 1;
      const newIn = clamp(drag.orig.in + delta * speed, 0, drag.orig.out - 0.08);
      mutate(() => { item.in = Math.round(newIn * 1000) / 1000; }, `drag-${drag.id}`, { history: !drag.firstMove, source: 'drag' });
    } else {
      const shift = clamp(delta, -drag.orig.start, drag.orig.duration - 0.1);
      mutate(() => {
        item.start = Math.round((drag.orig.start + shift) * 1000) / 1000;
        item.duration = Math.round((drag.orig.duration - shift) * 1000) / 1000;
        if (drag.kind !== 'text') item.in = Math.max(0, Math.round((Number(drag.orig.in || 0) + shift) * 1000) / 1000);
      }, `drag-${drag.id}`, { history: !drag.firstMove, source: 'drag' });
    }
    drag.firstMove = false;
    scheduleTrimRender();
    return;
  }

  if (drag.mode === 'trim-r') {
    if (drag.kind === 'main') {
      const speed = Number(drag.orig.speed) || 1;
      const meta = S.metaCache.get(drag.orig.src);
      const sourceMax = Number(meta?.duration) || 86400;
      const newOut = clamp(drag.orig.out + delta * speed, drag.orig.in + 0.08, Math.max(drag.orig.in + 0.08, sourceMax));
      mutate(() => { item.out = Math.round(newOut * 1000) / 1000; }, `drag-${drag.id}`, { history: !drag.firstMove, source: 'drag' });
    } else {
      let maxDuration = 3600;
      if (drag.kind !== 'text') {
        const meta = S.metaCache.get(drag.orig.src);
        maxDuration = meta?.duration
          ? Math.max(0.1, Number(meta.duration) - Number(drag.orig.in || 0))
          : 3600;
      }
      const newDuration = clamp(drag.orig.duration + delta, 0.1, maxDuration);
      mutate(() => { item.duration = Math.round(newDuration * 1000) / 1000; }, `drag-${drag.id}`, { history: !drag.firstMove, source: 'drag' });
    }
    drag.firstMove = false;
    scheduleTrimRender();
  }
}

function onDragEnd() {
  window.removeEventListener('pointermove', onDragMove);
  if (!drag) return;
  const current = drag;
  drag = null;
  clearDragUi();
  if (!current.moved) {
    renderTimeline();
    return;
  }
  let dropped = false;
  let flashKind = current.kind;
  let flashId = current.id;
  if (current.mode === 'move' && current.kind !== 'main') {
    if (current.toMain) {
      if (moveOverlayToMain(current.id, current.mainStart)) {
        dropped = true;
        flashKind = 'main';
        flashId = S.selection?.id || current.id;
      }
    } else {
      if (current.targetTrackId) S.activeTrackId = current.targetTrackId;
      mutate(() => {
        current.item.start = Math.round(current.targetStart * 1000) / 1000;
        if (current.targetTrackId) current.item.trackId = current.targetTrackId;
      }, `drop-${current.id}`);
      dropped = true;
    }
  } else if (current.mode === 'move' && current.kind === 'main' && current.convertTrackId) {
    if (moveMainClipToTrack(current.id, current.convertTrackId, current.convertStart)) {
      dropped = true;
      flashKind = 'overlay';
      flashId = S.selection?.id || current.id;
    }
  } else if (current.mode === 'move' && current.kind === 'main') {
    const oldIndex = S.doc.main.findIndex((clip) => clip.id === current.id);
    const target = clamp(current.targetIndex, 0, S.doc.main.length - 1);
    if (target !== oldIndex && oldIndex >= 0) {
      mutate(() => {
        const [clip] = S.doc.main.splice(oldIndex, 1);
        S.doc.main.splice(target, 0, clip);
      }, `reorder-${current.id}`);
    }
    dropped = true;
  }
  renderTimeline();
  if (dropped) flashBlock(flashKind, flashId);
  setPlayhead(S.playhead);
}

// ------------------------------------------------------------ 轨道管理

function suggestTrackName() {
  const type = $('#trackType')?.value || 'video';
  const label = { video: '视频轨', audio: '音轨', text: '字幕轨' }[type];
  const count = tracksOfType(type).length;
  const input = $('#trackName');
  if (input) input.placeholder = `留空自动命名：${label} ${count + 1}`;
}

function initTrackModal() {
  $('#addTrackBtn').addEventListener('click', () => {
    $('#trackName').value = '';
    $('#trackType').value = 'video';
    suggestTrackName();
    openModal('#trackModal');
  });
  $('#trackType').addEventListener('change', suggestTrackName);
  $('#trackSubmit').addEventListener('click', () => {
    const track = addTrack($('#trackType').value, $('#trackName').value);
    if (track) {
      closeModal('#trackModal');
      renderTimeline();
    }
  });
  $('#trackName').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('#trackSubmit').click();
  });
  $('#tlLabelsInner').addEventListener('click', (event) => {
    const deleteButton = event.target.closest('[data-del-track]');
    if (deleteButton) {
      event.stopPropagation();
      deleteTrack(deleteButton.dataset.delTrack);
      return;
    }
    const mainLabel = event.target.closest('[data-track-select="main"]');
    if (mainLabel) {
      S.activeTrackId = null;
      renderTimeline();
      return;
    }
    const label = event.target.closest('[data-track-id]');
    if (label) {
      S.activeTrackId = label.dataset.trackId;
      renderTimeline();
    }
  });
}

// ------------------------------------------------------------ 外部素材拖入轨道

let externalDragPayload = null;

function parseDragPayload(event) {
  if (externalDragPayload) return externalDragPayload;
  const raw = event.dataTransfer?.getData('application/x-cinecut')
    || event.dataTransfer?.getData('text/plain');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (error) { return null; }
}

function laneInfo(lane) {
  if (!lane) return null;
  if (lane.id === 'laneMain') return { type: 'main', track: null, lane };
  const track = (S.doc?.tracks || []).find((entry) => entry.id === lane.dataset.lane);
  if (!track) return null;
  return { type: track.type, track, lane };
}

function trackLabelInfo(label) {
  if (!label) return null;
  if (label.dataset.trackSelect === 'main') {
    return { type: 'main', track: null, lane: $('#laneMain'), label };
  }
  const trackId = label.dataset.trackId;
  if (!trackId) return null;
  const track = (S.doc?.tracks || []).find((entry) => entry.id === trackId);
  if (!track) return null;
  const lane = Array.from(document.querySelectorAll('.lane')).find((node) => node.dataset.lane === trackId) || null;
  if (!lane) return null;
  return { type: track.type, track, lane, label };
}

function externalDropInfo(event) {
  const element = event.target instanceof Element ? event.target : null;
  const lane = element?.closest('.lane');
  if (lane) return laneInfo(lane);
  return trackLabelInfo(element?.closest('.track-label'));
}

function payloadCompatible(payload, info) {
  if (!payload || !info) return false;
  if (payload.type === 'builtin') {
    if (info.type === 'main') return payload.category === 'filters' || payload.category === 'effects';
    if (payload.category === 'subtitles') return info.type === 'text';
    if (payload.category === 'stickers') return info.type === 'video';
    if (payload.category === 'audio') return info.type === 'audio';
    if (payload.category === 'effects') return info.type === 'video';
    if (payload.category === 'filters') return true;
    return false;
  }
  if (payload.type === 'media') {
    const kind = payload.entry?.kind;
    if (info.type === 'main') return kind === 'video';
    if (info.type === 'video') return kind === 'video' || kind === 'image';
    if (info.type === 'audio') return kind === 'audio' || kind === 'video';
    return false;
  }
  return false;
}

function trackTitle(info) {
  return info.type === 'main' ? '主视频轨' : info.track?.name || '轨道';
}

function externalDragDuration(payload) {
  if (payload.type === 'media') {
    const meta = payload.entry?.meta || S.metaCache.get(payload.entry?.path);
    const duration = Number(meta?.duration) || 4;
    return Math.max(1, Math.min(12, duration));
  }
  if (payload.type === 'builtin') {
    if (payload.category === 'stickers') return 4;
    if (payload.category === 'subtitles') return 3;
    if (payload.category === 'audio') {
      const item = (S.builtin?.audio || []).find((entry) => entry.id === payload.id);
      return Math.max(0.2, Number(item?.duration) || 3);
    }
  }
  return 0;
}

function clearExternalDropUi() {
  document.querySelectorAll('.lane.drag-target').forEach((node) => node.classList.remove('drag-target'));
  document.querySelectorAll('.track-label.drag-target').forEach((node) => node.classList.remove('drag-target'));
  document.querySelectorAll('.drop-ghost').forEach((node) => node.remove());
  hideSnap();
  hideDragTip();
}

function onExternalDragOver(event) {
  const info = externalDropInfo(event);
  const payload = parseDragPayload(event);
  if (!info || !payloadCompatible(payload, info)) {
    clearExternalDropUi();
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  document.querySelectorAll('.lane.drag-target,.track-label.drag-target').forEach((node) => node.classList.remove('drag-target'));
  info.lane?.classList.add('drag-target');
  info.label?.classList.add('drag-target');
  const time = info.label ? S.playhead : timeAt(event.clientX);
  const ghostDuration = externalDragDuration(payload);
  if (ghostDuration > 0) ensureGhost(info.lane, time * pps, ghostDuration * pps);
  else document.querySelectorAll('.drop-ghost').forEach((node) => node.remove());
  showSnap(time * pps, `${fmtTime(time, 2)}`);
  showDragTip(event, `${trackTitle(info)} · ${fmtTime(time, 2)}`);
}

function onExternalDragLeave(event) {
  const body = $('.tl-body');
  if (body && event.relatedTarget instanceof Node && body.contains(event.relatedTarget)) return;
  clearExternalDropUi();
}

function onExternalDrop(event) {
  const info = externalDropInfo(event);
  const payload = parseDragPayload(event);
  if (!info || !payloadCompatible(payload, info)) return;
  event.preventDefault();
  const time = info.label ? S.playhead : timeAt(event.clientX);
  clearExternalDropUi();
  externalDragPayload = null;
  if (payload.type === 'media') {
    if (info.type === 'main') addMain(payload.entry, { time }).catch(() => {});
    else addMediaToTrack(payload.entry, info.track, time).catch(() => {});
    return;
  }
  const block = event.target instanceof Element ? event.target.closest('.block.main') : null;
  const targetClip = block ? findItem('main', block.dataset.id) : null;
  handleBuiltinDrop(payload, { track: info.track, start: time, targetClip }).catch(() => {});
}

export function addMarker(label = '') {
  if (!S.doc) return;
  const time = Math.max(0, Number(S.playhead) || 0);
  const markers = S.doc.markers || [];
  const index = markers.filter((marker) => !label).length + 1;
  const text = label || `标记 ${index}`;
  const id = `mk_${Date.now().toString(36)}`;
  mutate(() => {
    S.doc.markers = [...markers.filter((marker) => Math.abs(Number(marker.time) - time) > 0.02), { id, time: Math.round(time * 1000) / 1000, label: text }]
      .sort((a, b) => a.time - b.time);
  }, 'marker-add');
  toast(`已添加标记 · ${fmtTime(time)}`, 'ok', 1600);
  return id;
}

export function initTimeline() {
  const tracksEl = $('#tlTracks');
  pps = S.zoom;
  $('#zoomRange').value = String(pps);
  $('#zoomRange').addEventListener('input', (event) => {
    S.zoom = Number(event.target.value);
    renderTimeline();
  });
  $('#zoomInBtn').addEventListener('click', () => {
    S.zoom = clamp(S.zoom + 10, 20, 180);
    $('#zoomRange').value = S.zoom;
    renderTimeline();
  });
  $('#zoomOutBtn').addEventListener('click', () => {
    S.zoom = clamp(S.zoom - 10, 20, 180);
    $('#zoomRange').value = S.zoom;
    renderTimeline();
  });
  $('#prevFrameBtn').addEventListener('click', () => { preview.pause(); stepFrame(-1); });
  $('#nextFrameBtn').addEventListener('click', () => { preview.pause(); stepFrame(1); });
  $('#splitBtn').addEventListener('click', () => splitAtPlayhead());
  $('#markerBtn')?.addEventListener('click', () => addMarker());
  $('#snapBtn')?.addEventListener('click', () => {
    S.snap = !S.snap;
    $('#snapBtn').classList.toggle('active', S.snap);
    toast(S.snap ? '吸附已开启' : '吸附已关闭', 'info', 1500);
  });
  $('#waveBtn')?.addEventListener('click', () => {
    S.showWaveforms = !S.showWaveforms;
    $('#waveBtn').classList.toggle('active', S.showWaveforms);
    paintWaveforms();
  });
  $('#tlRuler').addEventListener('click', (event) => {
    const marker = event.target.closest('.tl-marker');
    if (!marker) return;
    event.stopPropagation();
    const item = (S.doc.markers || []).find((row) => row.id === marker.dataset.markerId);
    if (item) setPlayhead(Number(item.time) || 0);
  }, true);
  $('#tlRuler').addEventListener('dblclick', (event) => {
    const marker = event.target.closest('.tl-marker');
    if (!marker) return;
    event.stopPropagation();
    mutate(() => { S.doc.markers = (S.doc.markers || []).filter((row) => row.id !== marker.dataset.markerId); }, 'marker-del');
  });
  tracksEl.addEventListener('click', (event) => {
    const action = event.target.closest('[data-track-act]');
    if (!action) return;
    event.stopPropagation();
    const track = (S.doc.tracks || []).find((row) => row.id === action.dataset.trackId);
    if (!track) return;
    const key = action.dataset.trackAct;
    mutate(() => { track[key] = !track[key]; }, `track-${key}-${track.id}`);
    renderTimeline();
  });
  $('#selectAllBtn')?.addEventListener('click', () => selectAll());
  $('#addTextBtn').addEventListener('click', () => addText());
  $('#deleteBtn').addEventListener('click', () => deleteSelected());
  $('#duplicateBtn').addEventListener('click', () => duplicateSelected());
  $('#undoBtn').addEventListener('click', () => undo());
  $('#redoBtn').addEventListener('click', () => redo());
  tracksEl.addEventListener('pointerdown', startDrag);
  tracksEl.addEventListener('dblclick', (event) => {
    const linked = event.target.closest('.block.linked');
    if (!linked) return;
    select('main', linked.dataset.id);
    separateAudio();
  });
  tracksEl.addEventListener('dragover', onExternalDragOver);
  tracksEl.addEventListener('dragleave', onExternalDragLeave);
  tracksEl.addEventListener('drop', onExternalDrop);
  const labelsEl = $('#tlLabelsInner');
  labelsEl.addEventListener('dragover', onExternalDragOver);
  labelsEl.addEventListener('dragleave', onExternalDragLeave);
  labelsEl.addEventListener('drop', onExternalDrop);
  $('#tlRuler').addEventListener('pointerdown', startDrag);
  $('#tlScroll').addEventListener('scroll', syncLabelScroll);
  $('#tlScroll').addEventListener('wheel', (event) => {
    if (event.shiftKey) {
      event.preventDefault();
      $('#tlScroll').scrollLeft += event.deltaY;
    }
  }, { passive: false });
  document.addEventListener('dragstart', (event) => {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest('#fileList, #builtinContent')) return;
    const raw = event.dataTransfer?.getData('application/x-cinecut')
      || event.dataTransfer?.getData('text/plain');
    if (!raw) return;
    try { externalDragPayload = JSON.parse(raw); } catch (error) { externalDragPayload = null; }
  });
  document.addEventListener('dragend', () => {
    externalDragPayload = null;
    clearExternalDropUi();
  });
  window.addEventListener('cinecut:zoom', (event) => {
    S.zoom = clamp(S.zoom + Number(event.detail || 10), 20, 180);
    $('#zoomRange').value = S.zoom;
    renderTimeline();
  });
  initTrackModal();

  on('doc', () => { if (!drag) renderTimeline(); });
  on('selection', () => { if (!drag) renderTimeline(); });
  on('project', () => renderTimeline());
  on('playhead', () => { updatePlayhead(); updatePlayheadButtons(); });
  on('theme', () => renderTimeline());
  updatePlayheadButtons();
}
