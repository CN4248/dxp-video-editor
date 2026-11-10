import { api } from './api.js';
import { $, clamp, debounce } from './ui.js';

export const THEMES = [
  { id: 'midnight', name: '午夜青', desc: '深空 × 霓虹青', sw: ['#22d3ee', '#818cf8'] },
  { id: 'ocean', name: '深海蓝', desc: '冷调 × 湖水蓝', sw: ['#38bdf8', '#2dd4bf'] },
  { id: 'violet', name: '暮光紫', desc: '夜色 × 霓虹紫', sw: ['#a78bfa', '#f472b6'] },
  { id: 'amber', name: '琥珀金', desc: '暖黑 × 琥珀金', sw: ['#fbbf24', '#fb923c'] },
  { id: 'forest', name: '苔原绿', desc: '墨绿 × 青柠', sw: ['#34d399', '#a3e635'] },
  { id: 'rose', name: '玫瑰红', desc: '暗红 × 玫瑰粉', sw: ['#fb7185', '#f472b6'] },
  { id: 'daylight', name: '日光白', desc: '暖白 × 琥珀橙', sw: ['#ea580c', '#f59e0b'] },
];

export const S = {
  config: null,
  projects: [],
  projectId: null,
  projectName: '',
  doc: null,
  dirty: false,
  dirtyVersion: 0,
  saveState: 'saved',
  cwd: '',
  entries: [],
  libraryMode: 'files',
  builtin: null,
  builtinCategory: 'filters',
  fileKind: 'all',
  fileSearch: '',
  searchResults: null,
  selection: null,
  selected: [],
  selectionAnchor: null,
  clipboard: null,
  activeTrackId: null,
  playhead: 0,
  playing: false,
  muted: false,
  zoom: 48,
  tasks: [],
  taskSel: new Set(),
  queue: { paused: false, counts: {}, workers: 1 },
  logs: [],
  logFilter: '',
  theme: 'midnight',
  activeTab: 'inspector',
  metaCache: new Map(),
  history: [],
  future: [],
  ready: false,
  previewFit: true,
  snap: true,
  showWaveforms: true,
  showScopes: false,
  markerEdit: null,
};

const listeners = new Map();

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}

export function emit(event, detail = {}) {
  const handlers = listeners.get(event);
  if (!handlers) return;
  for (const handler of handlers) {
    try {
      handler(detail);
    } catch (error) {
      console.error(`[event:${event}]`, error);
    }
  }
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function newId(prefix) {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${random}`;
}

export function initTheme() {
  const stored = localStorage.getItem('cinecut-theme');
  S.theme = THEMES.some((theme) => theme.id === stored) ? stored : 'midnight';
  applyTheme(S.theme, false);
}

export function applyTheme(themeId, remember = true) {
  if (!THEMES.some((theme) => theme.id === themeId)) themeId = 'midnight';
  S.theme = themeId;
  document.documentElement.dataset.theme = themeId;
  if (remember) localStorage.setItem('cinecut-theme', themeId);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', themeId === 'daylight' ? '#f3efe6' : '#06090f');
  emit('theme', { theme: themeId });
}

// ------------------------------------------------------------ 工程

export async function loadConfig() {
  const data = await api.get('/api/config');
  S.config = data.config;
  S.queue = data.queue;
  if ($('#versionText')) $('#versionText').textContent = `v${data.config.version}`;
  const badge = $('#ffmpegBadge');
  if (badge) {
    badge.classList.add('ok');
    badge.querySelector('span:last-child').textContent = 'FFmpeg 就绪';
    badge.title = `渲染引擎：${data.config.ffmpeg}`;
  }
}

export async function refreshProjects() {
  const data = await api.get('/api/projects');
  S.projects = data.projects;
  return S.projects;
}

export async function openProject(projectId, options = {}) {
  if (S.dirty && !options.skipSave) {
    try { await saveNow(); } catch (error) { /* 保存失败也允许切换，避免卡死 */ }
  }
  const data = await api.get(`/api/projects/${projectId}`);
  S.projectId = data.project.id;
  S.projectName = data.project.name;
  S.doc = data.project.doc;
  S.dirty = false;
  S.dirtyVersion = 0;
  S.saveState = 'saved';
  S.history = [];
  S.future = [];
  S.selection = null;
  S.selected = [];
  S.selectionAnchor = null;
  S.activeTrackId = null;
  S.playhead = 0;
  S.playing = false;
  localStorage.setItem('cinecut-project', projectId);
  emit('project', { project: data.project });
  emit('doc', { source: 'load' });
  emit('selection', { selection: null });
  emit('playhead', { time: 0 });
  emit('save', { state: 'saved' });
}

export async function createProject(name, doc = null) {
  const payload = { name: name || '未命名工程' };
  if (doc) payload.doc = doc;
  const data = await api.post('/api/projects', payload);
  await refreshProjects();
  await openProject(data.project.id);
  return data.project;
}

export async function saveAsProject(name) {
  await saveNow();
  const data = await api.post('/api/projects', { name, doc: clone(S.doc) });
  await refreshProjects();
  await openProject(data.project.id, { skipSave: true });
  return data.project;
}

export async function importProjectFile(payload) {
  const data = await api.post('/api/projects/import', payload);
  await refreshProjects();
  await openProject(data.project.id, { skipSave: true });
  return data.project;
}

export async function duplicateProject(projectId) {
  const data = await api.post(`/api/projects/${projectId}/duplicate`, {});
  await refreshProjects();
  await openProject(data.project.id);
  return data.project;
}

export async function deleteProject(projectId) {
  await api.del(`/api/projects/${projectId}`);
  await refreshProjects();
  if (S.projectId === projectId) {
    if (S.projects.length) await openProject(S.projects[0].id);
    else await createProject('我的第一个工程');
  }
}

// ------------------------------------------------------------ 保存

let saveTimer = null;
let saveChain = Promise.resolve();

export function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveNow().catch(() => {}); }, 700);
}

export function markDirty() {
  S.dirty = true;
  S.dirtyVersion += 1;
  S.saveState = 'saving';
  emit('save', { state: 'saving' });
  scheduleSave();
}

export function saveBeacon() {
  if (!S.projectId || !S.doc) return false;
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return false;
  const payload = {
    name: S.doc.name || S.projectName || '未命名工程',
    doc: clone(S.doc),
  };
  try {
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    return navigator.sendBeacon(`/api/projects/${S.projectId}/save`, blob);
  } catch (error) {
    return false;
  }
}

export function saveNow() {
  clearTimeout(saveTimer);
  if (!S.projectId || !S.doc) return Promise.resolve();
  const projectId = S.projectId;
  const version = S.dirtyVersion;
  const payload = {
    name: S.doc.name || S.projectName || '未命名工程',
    doc: clone(S.doc),
  };
  saveChain = saveChain.catch(() => {}).then(async () => {
    try {
      await api.put(`/api/projects/${projectId}`, payload);
      if (projectId === S.projectId && version === S.dirtyVersion) {
        S.dirty = false;
        S.saveState = 'saved';
      } else if (projectId === S.projectId) {
        S.saveState = 'saving';
        scheduleSave();
      }
    } catch (error) {
      S.saveState = 'error';
      emit('save', { state: 'error', error: error.message });
      throw error;
    }
    emit('save', { state: S.saveState });
  });
  return saveChain;
}

// ------------------------------------------------------------ 文档修改

let lastHistoryKey = '';
let lastHistoryAt = 0;

export function mutate(fn, key = '', options = {}) {
  if (!S.doc) return;
  if (options.history !== false) {
    const now = Date.now();
    if (!(key && key === lastHistoryKey && now - lastHistoryAt < 900)) {
      S.history.push(clone(S.doc));
      if (S.history.length > 80) S.history.shift();
      S.future = [];
    }
    lastHistoryKey = key;
    lastHistoryAt = now;
  }
  fn(S.doc);
  if (typeof S.doc.name === 'string') S.projectName = S.doc.name;
  markDirty();
  emit('doc', { source: options.source || 'ui' });
  emit('projectname', { name: S.projectName });
}

export function undo() {
  if (!S.history.length) return;
  S.future.push(clone(S.doc));
  S.doc = S.history.pop();
  afterHistory();
}

export function redo() {
  if (!S.future.length) return;
  S.history.push(clone(S.doc));
  S.doc = S.future.pop();
  afterHistory();
}

function afterHistory() {
  ensureSelection();
  markDirty();
  emit('doc', { source: 'history' });
  emit('selection', { selection: S.selection });
}

export function ensureSelection() {
  if (!S.selected) S.selected = [];
  S.selected = S.selected.filter((entry) => entry && findItem(entry.kind, entry.id));
  if (S.selection && !findItem(S.selection.kind, S.selection.id)) {
    S.selection = S.selected[0] ? { ...S.selected[0] } : null;
  }
  if (!S.selection && S.selected.length) S.selection = { ...S.selected[0] };
}

export function isSelected(kind, id) {
  return (S.selected || []).some((entry) => entry.kind === kind && entry.id === id);
}

export function allTimelineItems(doc = S.doc) {
  if (!doc) return [];
  const result = [];
  let cursor = 0;
  for (const clip of doc.main || []) {
    const duration = clipDuration(clip);
    result.push({ kind: 'main', id: clip.id, item: clip, start: cursor, duration });
    cursor += duration;
  }
  for (const [kind, list] of [['overlay', doc.overlays || []], ['audio', doc.audios || []],
    ['text', doc.texts || []]]) {
    for (const item of list) {
      result.push({ kind, id: item.id, item, start: Number(item.start) || 0,
        duration: Number(item.duration) || 0 });
    }
  }
  return result.sort((a, b) => (a.start - b.start) || a.kind.localeCompare(b.kind));
}

export function selectionItems() {
  if (!S.doc) return [];
  return (S.selected || [])
    .map((entry) => {
      const item = findItem(entry.kind, entry.id);
      return item ? { kind: entry.kind, item } : null;
    })
    .filter(Boolean);
}

export function selectionCount() {
  return selectionItems().length;
}

export function selectedItem() {
  const items = selectionItems();
  if (!items.length) return null;
  if (S.selection) {
    const primary = items.find((entry) => entry.kind === S.selection.kind && entry.item.id === S.selection.id);
    if (primary) return primary;
  }
  return items[0];
}

export function select(kind, id, options = {}) {
  if (kind && id && !options.toggle && !options.range
    && S.selected.length === 1 && isSelected(kind, id)) {
    return;
  }
  const emitSelection = () => {
    ensureSelection();
    emit('selection', { selection: S.selection, selected: S.selected, count: selectionCount() });
  };
  if (!kind || !id) {
    S.selected = [];
    S.selection = null;
    S.selectionAnchor = null;
    emitSelection();
    return;
  }
  const target = { kind, id };
  const existing = isSelected(kind, id);
  if (options.toggle) {
    if (existing) {
      S.selected = S.selected.filter((entry) => !(entry.kind === kind && entry.id === id));
      if (S.selection && S.selection.kind === kind && S.selection.id === id) {
        S.selection = S.selected.length ? { ...S.selected[S.selected.length - 1] } : null;
      }
    } else {
      S.selected = [...S.selected, target];
      S.selection = { ...target };
    }
    S.selectionAnchor = { ...target };
  } else if (options.range && S.selectionAnchor) {
    const all = allTimelineItems();
    const anchorIndex = all.findIndex((entry) => entry.kind === S.selectionAnchor.kind
      && entry.id === S.selectionAnchor.id);
    const targetIndex = all.findIndex((entry) => entry.kind === kind && entry.id === id);
    if (anchorIndex >= 0 && targetIndex >= 0) {
      const low = Math.min(anchorIndex, targetIndex);
      const high = Math.max(anchorIndex, targetIndex);
      S.selected = all.slice(low, high + 1).map((entry) => ({ kind: entry.kind, id: entry.id }));
    } else {
      S.selected = [target];
    }
    S.selection = { ...target };
  } else {
    S.selected = [target];
    S.selection = { ...target };
    S.selectionAnchor = { ...target };
  }
  if (S.selection) {
    const item = findItem(S.selection.kind, S.selection.id);
    if (item && item.trackId) S.activeTrackId = item.trackId;
  }
  emitSelection();
}

export function selectAll() {
  const all = allTimelineItems();
  S.selected = all.map((entry) => ({ kind: entry.kind, id: entry.id }));
  S.selection = all.length ? { kind: all[0].kind, id: all[0].id } : null;
  S.selectionAnchor = S.selection ? { ...S.selection } : null;
  emit('selection', { selection: S.selection, selected: S.selected, count: selectionCount() });
}

export function clearSelection() {
  select(null);
}

export function selectMany(entries) {
  S.selected = (entries || [])
    .filter((entry) => entry && entry.kind && entry.id && findItem(entry.kind, entry.id))
    .map((entry) => ({ kind: entry.kind, id: entry.id }));
  S.selection = S.selected.length ? { ...S.selected[0] } : null;
  S.selectionAnchor = S.selection ? { ...S.selection } : null;
  if (S.selection) {
    const item = findItem(S.selection.kind, S.selection.id);
    if (item && item.trackId) S.activeTrackId = item.trackId;
  }
  emit('selection', { selection: S.selection, selected: S.selected, count: selectionCount() });
}

export function findItem(kind, id) {
  if (!S.doc) return null;
  const list = kind === 'main' ? S.doc.main : S.doc[kind === 'overlay' ? 'overlays' : kind === 'audio' ? 'audios' : 'texts'];
  return (list || []).find((item) => item.id === id) || null;
}

// ------------------------------------------------------------ 时间计算

export function tracksOfType(type, doc = S.doc) {
  return (doc?.tracks || []).filter((track) => track.type === type);
}

export function trackById(trackId, doc = S.doc) {
  return (doc?.tracks || []).find((track) => track.id === trackId) || null;
}

export function firstTrack(type, doc = S.doc) {
  return tracksOfType(type, doc)[0] || null;
}

export function targetTrack(type, doc = S.doc) {
  const active = trackById(S.activeTrackId, doc);
  if (active && active.type === type) return active;
  return firstTrack(type, doc);
}

export function orderedByTrack(items, type, doc = S.doc) {
  const tracks = tracksOfType(type, doc);
  if (!tracks.length) return [...items];
  const order = new Map(tracks.map((track, index) => [track.id, index]));
  return items
    .map((item, index) => ({ item, index, track: order.has(item.trackId) ? order.get(item.trackId) : 0 }))
    .sort((a, b) => (b.track - a.track) || (a.index - b.index))
    .map((entry) => entry.item);
}

export function clipDuration(clip) {
  return Math.max(0.01, (Number(clip.out) - Number(clip.in)) / (Number(clip.speed) || 1));
}

export function mainDuration(doc = S.doc) {
  if (!doc) return 0;
  const offsets = mainOffsets(doc);
  if (!offsets.length) return 0;
  const last = offsets[offsets.length - 1];
  return last.start + last.duration;
}

export function transitionLength(clip, index, prevDuration, duration) {
  if (index <= 0) return 0;
  const wanted = Math.max(0, Number(clip?.transition?.duration) || 0);
  return Math.min(wanted, duration * 0.5, Math.max(0, prevDuration) * 0.5);
}

export function mainOffsets(doc = S.doc) {
  if (!doc) return [];
  let cursor = 0;
  let prevDuration = 0;
  return (doc.main || []).map((clip, index) => {
    const duration = clipDuration(clip);
    const overlap = transitionLength(clip, index, prevDuration, duration);
    const start = Math.max(0, cursor - overlap);
    const result = { start, duration, clip, transition: overlap };
    cursor = start + duration;
    prevDuration = duration;
    return result;
  });
}

export function activeMain(time, doc = S.doc) {
  const offsets = mainOffsets(doc);
  for (let index = 0; index < offsets.length; index += 1) {
    const entry = offsets[index];
    if (time >= entry.start - 0.001 && time < entry.start + entry.duration - 0.001) return { ...entry, index };
  }
  if (offsets.length && time >= offsets[offsets.length - 1].start) {
    const last = offsets[offsets.length - 1];
    return { ...last, index: offsets.length - 1 };
  }
  return null;
}

export function setPlayhead(time, source = 'ui') {
  const duration = mainDuration();
  const value = clamp(Number(time) || 0, 0, Math.max(0, duration));
  S.playhead = value;
  emit('playhead', { time: value, source });
}

export function stepFrame(delta) {
  if (!S.doc) return S.playhead;
  const fps = Math.max(1, Number(S.doc.canvas.fps) || 30);
  const duration = mainDuration();
  const frame = Math.round(S.playhead * fps) + Math.trunc(delta);
  const target = clamp(frame / fps, 0, duration);
  setPlayhead(target);
  return target;
}

export function editPoints() {
  const points = new Set([0]);
  const duration = mainDuration();
  points.add(duration);
  for (const entry of mainOffsets()) {
    points.add(Math.round(entry.start * 1000) / 1000);
    points.add(Math.round((entry.start + entry.duration) * 1000) / 1000);
  }
  for (const list of [S.doc?.overlays, S.doc?.audios, S.doc?.texts]) {
    for (const item of list || []) {
      points.add(Math.max(0, Number(item.start) || 0));
      points.add(Math.max(0, (Number(item.start) || 0) + (Number(item.duration) || 0)));
    }
  }
  return Array.from(points).sort((a, b) => a - b);
}

export function setMeta(path, meta) {
  S.metaCache.set(path, meta);
}

export function getMeta(path) {
  return S.metaCache.get(path) || null;
}

export function titleFor(kind, item) {
  if (!item) return '';
  if (kind === 'text') return item.text || '字幕';
  const name = String(item.src || '').split('/').pop();
  return name || (kind === 'main' ? '视频片段' : '素材');
}

export function docStats() {
  const doc = S.doc;
  if (!doc) return { clips: 0, overlays: 0, audios: 0, texts: 0, duration: 0 };
  return {
    clips: doc.main.length,
    overlays: doc.overlays.length,
    audios: doc.audios.length,
    texts: doc.texts.length,
    duration: mainDuration(),
  };
}

export const scheduleTasksRefresh = debounce(() => emit('tasks:refresh'), 160);

export { clamp } from './ui.js';
