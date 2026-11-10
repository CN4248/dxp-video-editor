import { api } from './api.js';
import { addAudio, addMain, addOverlay } from './actions.js';
import {
  BUILTIN_CATS, addBuiltinAudio, addSticker, addSubtitleTemplate, applyFilter,
  applyMosaicEffect, builtinItem, loadBuiltinManifest,
} from './builtins.js';
import {
  S, on, setMeta,
} from './store.js';
import { $, escapeHtml, fmtBytes, fmtTime, fmtTimeShort, icon, toast } from './ui.js';

let uploading = false;

function metaLine(entry) {
  const meta = entry.meta;
  if (entry.type === 'dir') return '文件夹';
  if (!meta) return `${fmtBytes(entry.size)} · 读取中…`;
  if (meta.error) return `${fmtBytes(entry.size)} · 无法解析`;
  const parts = [];
  if (meta.duration) parts.push(fmtTime(meta.duration));
  if (meta.width && meta.height) parts.push(`${meta.width}×${meta.height}`);
  if (meta.kind === 'audio' && meta.bitrate) parts.push(`${Math.round(meta.bitrate / 1000)} kbps`);
  parts.push(fmtBytes(entry.size));
  return parts.join(' · ');
}

function entryThumb(entry) {
  if (entry.type === 'dir') return icon('folder');
  if (entry.kind === 'audio') return icon('music');
  if (entry.kind === 'image' || entry.kind === 'video') {
    return `${icon(entry.kind === 'video' ? 'film' : 'image')}
      <img loading="lazy" src="/api/thumb?path=${encodeURIComponent(entry.path)}" alt="" onerror="this.style.display='none'">`;
  }
  return icon('film');
}

function rowHtml(entry, index) {
  const isDir = entry.type === 'dir';
  const actions = isDir ? '' : `<div class="file-actions">
      ${entry.kind === 'video' ? `<button data-act="main" data-index="${index}" type="button">主轨</button>` : ''}
      ${entry.kind === 'video' || entry.kind === 'image' ? `<button data-act="overlay" data-index="${index}" type="button">叠加</button>` : ''}
      ${entry.kind === 'audio' ? `<button data-act="audio" data-index="${index}" type="button">音轨</button>` : ''}
    </div>`;
  return `<div class="file-row ${isDir ? 'dir' : entry.kind}" data-index="${index}"
    data-path="${escapeHtml(entry.path || '')}" ${isDir ? '' : 'draggable="true"'} title="${escapeHtml(entry.path || entry.name)}">
    <div class="file-thumb">
      ${entryThumb(entry)}
      ${!isDir && entry.kind ? `<span class="kind-dot">${icon(entry.kind === 'video' ? 'film' : entry.kind === 'image' ? 'image' : 'music')}</span>` : ''}
    </div>
    <div class="file-main">
      <div class="file-name">${escapeHtml(entry.name)}</div>
      <div class="file-meta" data-meta="${escapeHtml(entry.path)}">${escapeHtml(metaLine(entry))}</div>
    </div>
    ${actions}
  </div>`;
}

function visibleEntries() {
  if (S.searchResults) return S.searchResults;
  let entries = S.entries;
  if (S.fileKind !== 'all') entries = entries.filter((entry) => entry.type === 'dir' || entry.kind === S.fileKind);
  if (S.fileSearch) {
    const term = S.fileSearch.toLowerCase();
    entries = entries.filter((entry) => entry.name.toLowerCase().includes(term));
  }
  return entries;
}

function setLibraryMode(mode) {
  S.libraryMode = mode === 'builtin' ? 'builtin' : 'files';
  document.querySelectorAll('#libraryMode button').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === S.libraryMode);
  });
  const filesMode = S.libraryMode === 'files';
  for (const selector of ['.pathbar', '.library-tools', '.media-tabs', '#fileList']) {
    $(selector)?.classList.toggle('hidden', !filesMode);
  }
  $('#builtinPanel').classList.toggle('hidden', filesMode);
  const hint = $('#libHint');
  if (hint) hint.textContent = filesMode ? '双击添加到轨道' : '点击添加 / 应用';
  if (filesMode) renderLibrary();
  else {
    if (!S.builtin) loadBuiltin();
    else renderBuiltin();
  }
}

export function renderLibrary() {
  if (S.libraryMode === 'builtin') {
    renderBuiltin();
    return;
  }
  const entries = visibleEntries();
  const list = $('#fileList');
  if (!list) return;
  if (!entries.length) {
    list.innerHTML = `<div class="empty-state">${icon(S.searchResults ? 'search' : 'folder')}<br>${
      S.searchResults ? '没有找到匹配的素材' : S.fileSearch ? '当前目录没有匹配项' : '这个目录里没有可用的素材'
    }<br><span style="opacity:.7">支持视频、图片、音频；也可以直接拖入文件上传</span></div>`;
  } else {
    list.innerHTML = entries.map((entry, index) => rowHtml(entry, index)).join('');
  }
  const total = entries.filter((entry) => entry.type === 'file').reduce((sum, entry) => sum + (entry.size || 0), 0);
  $('#libCount').textContent = S.searchResults
    ? `搜索到 ${entries.length} 个素材`
    : `${entries.length} 个素材 · ${fmtBytes(total)}`;
  $('#upBtn').disabled = !S.cwd || Boolean(S.searchResults);
  document.querySelectorAll('#mediaTabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset.kind === S.fileKind);
  });
  renderBreadcrumb();
  hydrateMeta(entries);
}

function renderBreadcrumb() {
  const bar = $('#breadcrumb');
  if (S.searchResults) {
    bar.innerHTML = `<button data-path="" type="button">搜索结果</button><span class="sep">/</span><span style="color:var(--faint);padding:0 4px">${escapeHtml(S.fileSearch)}</span>`;
    return;
  }
  const parts = S.cwd ? S.cwd.split('/') : [];
  let html = `<button data-path="" type="button">${icon('folder')} 素材库</button>`;
  let path = '';
  for (const part of parts) {
    path = path ? `${path}/${part}` : part;
    html += `<span class="sep">/</span><button data-path="${escapeHtml(path)}" type="button">${escapeHtml(part)}</button>`;
  }
  bar.innerHTML = html;
}

function hydrateMeta(entries) {
  const pending = entries.filter((entry) => entry.type === 'file' && !entry.meta).slice(0, 24);
  for (const entry of pending) {
    const cached = S.metaCache.get(entry.path);
    if (cached) {
      entry.meta = cached;
      updateMetaText(entry);
      continue;
    }
    api.get(`/api/probe?path=${encodeURIComponent(entry.path)}`).then((data) => {
      entry.meta = data.meta;
      setMeta(entry.path, data.meta);
      updateMetaText(entry);
    }).catch(() => {});
  }
}

function updateMetaText(entry) {
  const node = Array.from(document.querySelectorAll('.file-meta')).find((item) => item.dataset.meta === entry.path);
  if (node) node.textContent = metaLine(entry);
}

export async function loadDir(path) {
  const data = await api.get(`/api/files?path=${encodeURIComponent(path || '')}`);
  S.cwd = data.cwd || '';
  S.entries = data.entries || [];
  S.searchResults = null;
  S.fileSearch = '';
  $('#searchInput').value = '';
  for (const entry of S.entries) {
    if (entry.meta) setMeta(entry.path, entry.meta);
  }
  renderLibrary();
}

async function globalSearch(term) {
  if (!term) { S.searchResults = null; renderLibrary(); return; }
  try {
    const data = await api.get(`/api/search?q=${encodeURIComponent(term)}`);
    S.searchResults = data.results || [];
    for (const entry of S.searchResults) {
      if (entry.meta) setMeta(entry.path, entry.meta);
    }
    renderLibrary();
    if (!S.searchResults.length) toast('没有找到匹配的素材', 'info');
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function performAction(action, entry) {
  try {
    if (action === 'main') await addMain(entry);
    else if (action === 'overlay') await addOverlay(entry);
    else if (action === 'audio') await addAudio(entry);
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function uploadFiles(files) {
  const list = Array.from(files || []);
  if (!list.length || uploading) return;
  uploading = true;
  const panel = $('.library-panel');
  panel?.classList.add('upload-drop');
  toast(`开始上传 ${list.length} 个文件…`, 'info');
  let ok = 0;
  for (const file of list) {
    try {
      await api.upload(file, 'uploads', (progress) => {
        $('#libCount').textContent = `上传 ${file.name} · ${Math.round(progress * 100)}%`;
      });
      ok += 1;
    } catch (error) {
      toast(`上传 ${file.name} 失败：${error.message}`, 'err');
    }
  }
  uploading = false;
  panel?.classList.remove('upload-drop');
  toast(`已上传 ${ok}/${list.length} 个素材到 /input/uploads`, ok ? 'ok' : 'err');
  await loadDir('uploads');
}

// ------------------------------------------------------------ 内置素材

async function loadBuiltin() {
  $('#builtinContent').innerHTML = '<div class="empty-state">正在加载内置素材…</div>';
  try {
    await loadBuiltinManifest(true);
    renderBuiltin();
  } catch (error) {
    $('#builtinContent').innerHTML = `<div class="empty-state">内置素材加载失败<br>${escapeHtml(error.message)}</div>`;
  }
}

const EFFECT_MODES = { pixel: '像素化', blur: '高斯模糊', black: '黑块遮挡' };

function renderBuiltin() {
  const manifest = S.builtin;
  if (!manifest) return;
  const category = S.builtinCategory || 'filters';
  $('#builtinCats').innerHTML = BUILTIN_CATS.map((cat) => {
    const count = (manifest[cat.id] || []).length;
    return `<button data-bcat="${cat.id}" class="${cat.id === category ? 'active' : ''}" type="button">${cat.label} ${count}</button>`;
  }).join('');
  const content = $('#builtinContent');
  if (category === 'filters') {
    content.innerHTML = `<div class="builtin-grid">${(manifest.filters || []).map((item) => `
      <button class="filter-card" data-filter="${item.id}" type="button" draggable="true">
        <span class="filter-swatch" style="background:linear-gradient(135deg,${item.sw[0]},${item.sw[1]})"></span>
        <b>${escapeHtml(item.name)}</b><span>${escapeHtml(item.desc)}</span>
      </button>`).join('')}</div>`;
  } else if (category === 'subtitles') {
    content.innerHTML = (manifest.subtitles || []).map((item) => {
      const style = item.style;
      return `<button class="sub-card" data-subtitle="${item.id}" type="button" draggable="true">
        <div class="sample" style="font-size:${Math.max(13, style.size * 0.2)}px;color:${style.color};${style.bg ? 'background:rgba(0,0,0,.35);padding:3px 6px;border-radius:4px;display:inline-block' : ''}">${escapeHtml(style.text)}</div>
        <span>${escapeHtml(item.name)} · ${escapeHtml(item.desc)}</span>
      </button>`;
    }).join('');
  } else if (category === 'stickers') {
    content.innerHTML = `<div class="sticker-grid">${(manifest.stickers || []).map((item) => `
      <button class="sticker-card" data-sticker="${item.id}" type="button" draggable="true">
        <span class="thumb"><img src="/builtin/${escapeHtml(item.file)}" alt=""></span>
        <b>${escapeHtml(item.name)}</b>
      </button>`).join('')}</div>`;
  } else if (category === 'audio') {
    content.innerHTML = (manifest.audio || []).map((item) => `
      <button class="audio-card" data-baudio="${item.id}" type="button" draggable="true">
        <span class="aicon">${icon('music')}</span>
        <span class="ainfo"><b>${escapeHtml(item.name)}</b><span>${escapeHtml(item.desc)} · ${fmtTimeShort(item.duration)}</span></span>
        ${icon('plus', 'icon')}
      </button>`).join('');
  } else {
    content.innerHTML = (manifest.effects || []).map((item) => `
      <button class="effect-card" data-effect="${item.id}" type="button" draggable="true">
        <b>${icon('layers')} ${escapeHtml(item.name)}</b>
        <span>${escapeHtml(item.desc)} · ${EFFECT_MODES[item.mode] || '像素化'} · 块 ${item.block}px</span>
      </button>`).join('');
  }
  $('#libCount').textContent = `内置素材 · ${BUILTIN_CATS.find((cat) => cat.id === category)?.label || ''}`;
  const hint = $('#libHint');
  if (hint) hint.textContent = '点击应用 · 可拖到时间线轨道';
}

function builtinAction(event) {
  const target = event.target.closest('[data-filter],[data-subtitle],[data-sticker],[data-baudio],[data-effect]');
  if (!target || !S.builtin) return;
  let category = '';
  let id = '';
  if (target.dataset.filter) { category = 'filters'; id = target.dataset.filter; }
  else if (target.dataset.subtitle) { category = 'subtitles'; id = target.dataset.subtitle; }
  else if (target.dataset.sticker) { category = 'stickers'; id = target.dataset.sticker; }
  else if (target.dataset.baudio) { category = 'audio'; id = target.dataset.baudio; }
  else if (target.dataset.effect) { category = 'effects'; id = target.dataset.effect; }
  const item = builtinItem(category, id);
  if (!item) return;
  if (category === 'filters') applyFilter(item);
  else if (category === 'subtitles') addSubtitleTemplate(item);
  else if (category === 'stickers') addSticker(item);
  else if (category === 'audio') addBuiltinAudio(item);
  else applyMosaicEffect(item);
}

function setDragPayload(event, payload) {
  if (!event.dataTransfer) return;
  const text = JSON.stringify(payload);
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData('application/x-cinecut', text);
  event.dataTransfer.setData('text/plain', text);
}

function builtinDragStart(event) {
  const target = event.target.closest('[data-filter],[data-subtitle],[data-sticker],[data-baudio],[data-effect]');
  if (!target) return;
  let category = '';
  let id = '';
  if (target.dataset.filter) { category = 'filters'; id = target.dataset.filter; }
  else if (target.dataset.subtitle) { category = 'subtitles'; id = target.dataset.subtitle; }
  else if (target.dataset.sticker) { category = 'stickers'; id = target.dataset.sticker; }
  else if (target.dataset.baudio) { category = 'audio'; id = target.dataset.baudio; }
  else if (target.dataset.effect) { category = 'effects'; id = target.dataset.effect; }
  if (!category) return;
  setDragPayload(event, { type: 'builtin', category, id });
  target.classList.add('dragging-source');
}

function fileDragStart(event) {
  const row = event.target.closest('.file-row');
  if (!row || row.classList.contains('dir')) return;
  const entry = visibleEntries()[Number(row.dataset.index)];
  if (!entry || entry.type !== 'file') return;
  setDragPayload(event, { type: 'media', entry });
  row.classList.add('dragging-source');
}

function clearDragSource(event) {
  event.target.closest('.dragging-source')?.classList.remove('dragging-source');
  document.querySelectorAll('.dragging-source').forEach((node) => node.classList.remove('dragging-source'));
}

function initBuiltin() {
  $('#libraryMode').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]');
    if (button) setLibraryMode(button.dataset.mode);
  });
  $('#builtinCats').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-bcat]');
    if (!button) return;
    S.builtinCategory = button.dataset.bcat;
    renderBuiltin();
  });
  $('#builtinContent').addEventListener('click', builtinAction);
  $('#builtinContent').addEventListener('dragstart', builtinDragStart);
  $('#builtinContent').addEventListener('dragend', clearDragSource);
  $('#fileList').addEventListener('dragstart', fileDragStart);
  $('#fileList').addEventListener('dragend', clearDragSource);
}

export function initLibrary() {
  $('#refreshBtn').addEventListener('click', () => loadDir(S.cwd).catch((error) => toast(error.message, 'err')));
  $('#upBtn').addEventListener('click', () => {
    if (!S.cwd) return;
    const parent = S.cwd.includes('/') ? S.cwd.slice(0, S.cwd.lastIndexOf('/')) : '';
    loadDir(parent).catch((error) => toast(error.message, 'err'));
  });
  $('#breadcrumb').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-path]');
    if (button) loadDir(button.dataset.path).catch((error) => toast(error.message, 'err'));
  });
  $('#mediaTabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-kind]');
    if (!button) return;
    S.fileKind = button.dataset.kind;
    renderLibrary();
  });
  $('#searchInput').addEventListener('input', (event) => {
    S.fileSearch = event.target.value.trim();
    S.searchResults = null;
    renderLibrary();
  });
  $('#searchInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      globalSearch(event.target.value.trim());
    }
  });
  $('#searchInput').addEventListener('search', () => {
    S.searchResults = null;
    S.fileSearch = '';
    renderLibrary();
  });
  $('#fileList').addEventListener('click', (event) => {
    const actionButton = event.target.closest('button[data-act]');
    if (actionButton) {
      event.stopPropagation();
      const entry = visibleEntries()[Number(actionButton.dataset.index)];
      if (entry) performAction(actionButton.dataset.act, entry);
      return;
    }
  });
  $('#fileList').addEventListener('dblclick', (event) => {
    if (event.target.closest('button[data-act]')) return;
    const row = event.target.closest('.file-row');
    if (!row) return;
    const entry = visibleEntries()[Number(row.dataset.index)];
    if (!entry) return;
    if (entry.type === 'dir') loadDir(entry.path).catch((error) => toast(error.message, 'err'));
    else if (entry.kind === 'video') performAction('main', entry);
    else if (entry.kind === 'image') performAction('overlay', entry);
    else if (entry.kind === 'audio') performAction('audio', entry);
  });
  $('#uploadBtn').addEventListener('click', () => $('#uploadInput').click());
  $('#uploadInput').addEventListener('change', (event) => {
    uploadFiles(event.target.files);
    event.target.value = '';
  });
  const panel = $('.library-panel');
  panel.addEventListener('dragover', (event) => {
    event.preventDefault();
    panel.classList.add('upload-drop');
  });
  panel.addEventListener('dragleave', (event) => {
    if (!panel.contains(event.relatedTarget)) panel.classList.remove('upload-drop');
  });
  panel.addEventListener('drop', (event) => {
    event.preventDefault();
    panel.classList.remove('upload-drop');
    if (event.dataTransfer?.files?.length) uploadFiles(event.dataTransfer.files);
  });
  initBuiltin();
  on('project', () => { /* 保持素材目录，便于连续添加 */ });
}
