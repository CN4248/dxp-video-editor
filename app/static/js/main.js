import { api } from './api.js';
import {
  S, THEMES, applyTheme, clone, createProject, deleteProject, duplicateProject, editPoints,
  importProjectFile, initTheme, loadConfig, mainDuration, on, openProject, refreshProjects,
  redo, saveAsProject, saveBeacon, saveNow, selectAll as selectAllItems, setPlayhead,
  stepFrame, undo,
} from './store.js';
import { preview } from './preview.js';
import { addMarker, initTimeline, renderTimeline } from './timeline.js';
import { initInspector } from './inspector.js';
import { initLibrary, loadDir } from './library.js';
import { appendLog, initQueue, loadLogs, refreshTasks, renderQueue } from './queue.js';
import {
  $, bindModalBasics, closeModal, confirmDialog, escapeHtml, fmtDate, fmtTime,
  icon, openModal, toast,
} from './ui.js';
import {
  copySelected, cutSelected, deleteSelected, duplicateSelected, moveSelectedToAdjacentTrack,
  pasteClipboard, rippleDeleteSelected, splitAllAtPlayhead, splitAtPlayhead, toggleMuteSelected,
  trimToPlayhead,
} from './actions.js';
import { initContextMenu } from './contextmenu.js';
import { initSubtitles } from './subtitles.js';
import { initMixer } from './mixer.js';
import { loadBuiltinManifest } from './builtins.js';

let lastLogRefresh = 0;

function setTab(tab) {
  S.activeTab = tab;
  document.querySelectorAll('.side-tabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  for (const [name, id] of [['inspector', '#inspectorPane'], ['queue', '#queuePane'], ['logs', '#logPane']]) {
    $(id).classList.toggle('hidden', name !== tab);
  }
  if (tab === 'queue') refreshTasks().catch(() => {});
  if (tab === 'logs') {
    const view = $('#logView');
    if (view && localStorage.getItem('cinecut-log-auto') !== '0') view.scrollTop = view.scrollHeight;
  }
}

async function manualSave() {
  try {
    await saveNow();
    toast('工程已保存到 /data', 'ok', 1800);
  } catch (error) {
    toast(`保存失败：${error.message}`, 'err', 5000);
  }
}

function bindHeader() {
  $('#projectBtn').addEventListener('click', () => openProjects());
  $('#saveBtn').addEventListener('click', manualSave);
  $('#exportBtn').addEventListener('click', () => openExport());
  $('#themeBtn').addEventListener('click', () => openThemes());
  $('#helpBtn').addEventListener('click', () => openModal('#helpModal'));
  on('project', ({ project }) => {
    $('#projectName').textContent = project.name;
    document.title = `${project.name} · CineCut`;
  });
  on('projectname', ({ name }) => {
    $('#projectName').textContent = name;
    document.title = `${name} · CineCut`;
  });
  on('save', ({ state, error }) => {
    const badge = $('#saveState');
    badge.dataset.state = state;
    if (state === 'saving') badge.innerHTML = '<i></i>保存中…';
    else if (state === 'error') badge.innerHTML = `<i></i>保存失败${error ? `：${error.slice(0, 24)}` : ''}`;
    else badge.innerHTML = '<i></i>已保存';
  });
}

function bindTabs() {
  document.querySelectorAll('.side-tabs button').forEach((button) => {
    button.addEventListener('click', () => setTab(button.dataset.tab));
  });
  window.addEventListener('cinecut:tab', (event) => setTab(event.detail));
  on('export', () => openExport());
}

// ------------------------------------------------------------ 导出

function parseTimecode(text) {
  const raw = String(text || '').trim();
  if (!raw) return 0;
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
  const match = raw.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (!match) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function qualityFromSelect(value) {
  return value === 'high' ? 18 : value === 'small' ? 25 : 21;
}

function populateFormats() {
  const select = $('#expFormat');
  if (!select) return;
  const formats = S.config?.formats || [];
  const groups = new Map();
  for (const fmt of formats) {
    if (!groups.has(fmt.group)) groups.set(fmt.group, []);
    groups.get(fmt.group).push(fmt);
  }
  let html = '';
  for (const [group, items] of groups) {
    html += `<optgroup label="${escapeHtml(group)}">`;
    for (const fmt of items) {
      html += `<option value="${fmt.key}">${escapeHtml(fmt.label)} · ${escapeHtml(fmt.description)}</option>`;
    }
    html += '</optgroup>';
  }
  select.innerHTML = html || '<option value="mp4">MP4</option>';
}

function currentFormat() {
  const key = $('#expFormat')?.value || 'mp4';
  return (S.config?.formats || []).find((fmt) => fmt.key === key) || {
    key: 'mp4', label: 'MP4', ext: '.mp4', kind: 'video', description: 'H.264 + AAC', quality: true,
  };
}

function renderExportSummary() {
  if (!S.doc) return;
  const doc = S.doc;
  const fmt = currentFormat();
  const duration = mainDuration(doc);
  const extras = doc.overlays.length + doc.audios.length + doc.texts.length;
  const audioOnly = fmt.kind === 'audio';
  const gif = fmt.kind === 'gif';
  $('#expSummary').innerHTML = `
    <div><span>时长</span><b>${fmtTime(duration)}</b></div>
    <div><span>输出格式</span><b>${fmt.label} ${fmt.ext}</b></div>
    <div><span>${audioOnly ? '音频编码' : '画布'}</span><b>${audioOnly ? fmt.description : `${doc.canvas.width} × ${doc.canvas.height}`}</b></div>
    <div><span>片段</span><b>${doc.main.length} 段</b></div>
    <div><span>叠加 / 字幕 / 音轨</span><b>${doc.overlays.length} / ${doc.texts.length} / ${doc.audios.length}</b></div>
    <div><span>渲染模式</span><b>${audioOnly ? '仅音频' : gif ? '动图（无声音）' : extras ? '分段合成' : '直出拼接'}</b></div>`;
  const hint = $('#expFormatHint');
  if (hint) hint.textContent = `${fmt.description} · 自动使用扩展名 ${fmt.ext}`;
  const nameHint = $('#expNameHint');
  if (nameHint) nameHint.textContent = `无需填写扩展名，将自动使用 ${fmt.ext}`;
  $('#expQuality').disabled = !fmt.quality;
  $('#expPreset').disabled = !fmt.quality;
}

function syncFormatUI() {
  renderExportSummary();
}

function exportDefaults() {
  const doc = S.doc;
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const base = (doc.name || '我的影片').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  return `${base}_${stamp}`;
}

function openExport() {
  if (!S.doc || !S.doc.main.length) {
    toast('主轨还是空的，先把视频加入主轨再导出', 'err');
    return;
  }
  populateFormats();
  $('#expName').value = exportDefaults();
  $('#expSubdir').value = '';
  $('#expStart').value = '';
  $('#expEnd').value = '';
  $('#expOverwrite').checked = false;
  $('#expQuality').value = 'standard';
  $('#expPreset').value = 'medium';
  $('#expFormat').value = 'mp4';
  renderExportSummary();
  $('#expSubmit').disabled = false;
  $('#expSubmit').innerHTML = `${icon('queue')}加入渲染队列`;
  openModal('#exportModal');
  setTimeout(() => $('#expName').select(), 60);
}

async function submitExport() {
  if (!S.doc) return;
  const filename = $('#expName').value.trim();
  if (!filename) {
    toast('请填写文件名', 'err');
    $('#expName').focus();
    return;
  }
  const button = $('#expSubmit');
  button.disabled = true;
  button.textContent = '正在加入…';
  try {
    const start = parseTimecode($('#expStart').value);
    const end = parseTimecode($('#expEnd').value);
    if (start === null || end === null) {
      toast('时间格式无效，请用 秒数 或 mm:ss.s', 'err');
      button.disabled = false;
      button.innerHTML = `${icon('queue')}加入渲染队列`;
      return;
    }
    if (end > 0 && end <= start) {
      toast('结束时间必须大于起始时间', 'err');
      button.disabled = false;
      button.innerHTML = `${icon('queue')}加入渲染队列`;
      return;
    }
    await saveNow();
    const exportOptions = {
      filename,
      start,
      end,
      subdir: $('#expSubdir').value.trim(),
      format: $('#expFormat').value || 'mp4',
      overwrite: $('#expOverwrite').checked,
      crf: qualityFromSelect($('#expQuality').value),
      preset: $('#expPreset').value,
      audioBitrate: 192,
    };
    const data = await api.post('/api/render', {
      projectId: S.projectId,
      doc: clone(S.doc),
      export: exportOptions,
      save: true,
    });
    closeModal('#exportModal');
    await refreshTasks();
    setTab('queue');
    toast('已加入渲染队列', 'ok');
    if (S.queue.paused) toast('队列当前处于暂停状态，点击队列右上角的播放按钮开始渲染', 'info', 5000);
  } catch (error) {
    toast(error.message, 'err');
    button.disabled = false;
    button.innerHTML = `${icon('queue')}加入渲染队列`;
  }
}

function bindExport() {
  $('#expFormat').addEventListener('change', syncFormatUI);
  $('#expSubmit').addEventListener('click', submitExport);
  $('#expName').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitExport();
  });
  window.addEventListener('cinecut:export', () => openExport());
}

// ------------------------------------------------------------ 主题

function renderThemes() {
  const grid = $('#themeGrid');
  grid.innerHTML = THEMES.map((theme) => `
    <button class="theme-card ${S.theme === theme.id ? 'active' : ''}" data-theme-id="${theme.id}" type="button">
      <span class="theme-swatch" style="--sw-1:${theme.sw[0]};--sw-2:${theme.sw[1]}"></span>
      <span><b>${theme.name}</b><span>${theme.desc}</span></span>
    </button>`).join('');
  grid.querySelectorAll('[data-theme-id]').forEach((button) => {
    button.addEventListener('click', () => {
      applyTheme(button.dataset.themeId);
      renderThemes();
    });
  });
}

function openThemes() {
  renderThemes();
  openModal('#themeModal');
}

// ------------------------------------------------------------ 工程

function openProjects() {
  renderProjects();
  openModal('#projectModal');
  refreshProjects().then(renderProjects).catch(() => {});
}

function renderProjects() {
  const list = $('#projectList');
  if (!list) return;
  if (!S.projects.length) {
    list.innerHTML = '<div class="empty-state">还没有工程</div>';
    return;
  }
  list.innerHTML = S.projects.map((project) => `
    <div class="project-row ${project.id === S.projectId ? 'active' : ''}" data-id="${project.id}">
      <div class="pinfo">
        <b>${escapeHtml(project.name)}</b>
        <span>更新于 ${fmtDate(project.updated)}</span>
      </div>
      <div class="pactions">
        <button class="mini-btn" data-open="${project.id}" type="button">打开</button>
        <a class="mini-btn" href="/api/projects/${project.id}/export" download title="导出工程文件">${icon('download')}</a>
        <button class="mini-btn" data-dup="${project.id}" type="button" title="复制工程">${icon('copy')}</button>
        <button class="mini-btn danger" data-del="${project.id}" type="button" title="删除工程">${icon('trash')}</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('[data-open]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await openProject(button.dataset.open);
        closeModal('#projectModal');
        toast('工程已打开', 'ok');
      } catch (error) { toast(error.message, 'err'); }
    });
  });
  list.querySelectorAll('[data-dup]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await duplicateProject(button.dataset.dup);
        closeModal('#projectModal');
        toast('工程副本已创建', 'ok');
      } catch (error) { toast(error.message, 'err'); }
    });
  });
  list.querySelectorAll('[data-del]').forEach((button) => {
    button.addEventListener('click', async () => {
      const project = S.projects.find((item) => item.id === button.dataset.del);
      if (!project) return;
      const ok = await confirmDialog('删除工程', `确定删除「${project.name}」？工程中的剪辑数据会一并删除，已导出的视频不受影响。`, '删除');
      if (!ok) return;
      try {
        await deleteProject(button.dataset.del);
        renderProjects();
        if (!S.projects.length) { closeModal('#projectModal'); return; }
        toast('工程已删除', 'ok');
      } catch (error) { toast(error.message, 'err'); }
    });
  });
}

function bindProjects() {
  $('#saveAsBtn').addEventListener('click', async () => {
    if (!S.doc) return;
    const name = ($('#projectNewName').value || '').trim() || `${S.doc.name} 副本`;
    try {
      await saveAsProject(name.slice(0, 80));
      $('#projectNewName').value = '';
      renderProjects();
      closeModal('#projectModal');
      toast(`已另存为「${name}」并切换过去`, 'ok');
    } catch (error) {
      toast(`另存为失败：${error.message}`, 'err');
    }
  });
  $('#exportProjectBtn').addEventListener('click', () => {
    if (!S.projectId) return;
    const link = document.createElement('a');
    link.href = `/api/projects/${S.projectId}/export`;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    link.remove();
  });
  $('#importProjectBtn').addEventListener('click', () => $('#projectImportInput').click());
  $('#projectImportInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      await importProjectFile(payload);
      closeModal('#projectModal');
      toast(`已导入工程「${S.doc?.name || file.name}」`, 'ok');
    } catch (error) {
      toast(`导入失败：${error.message}`, 'err');
    }
  });
  $('#newProjectBtn').addEventListener('click', async () => {
    const name = $('#projectNewName').value.trim();
    if (!name) { toast('请输入工程名称', 'err'); return; }
    try {
      await createProject(name);
      $('#projectNewName').value = '';
      renderProjects();
      closeModal('#projectModal');
      toast('新工程已创建', 'ok');
    } catch (error) { toast(error.message, 'err'); }
  });
  $('#projectNewName').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('#newProjectBtn').click();
  });
  window.addEventListener('cinecut:projects', () => openProjects());
}

// ------------------------------------------------------------ 快捷键

function isTyping(target) {
  return target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
}

function bindKeyboard() {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') return;
    if (document.querySelector('.modal-backdrop:not(.hidden)')) return;
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key;
    if (modifier) {
      if (key === 's' || key === 'S') {
        event.preventDefault();
        manualSave();
        return;
      }
      if (isTyping(event.target)) return;
      const lower = key.toLowerCase();
      if (lower === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
        return;
      }
      if (lower === 'y') { event.preventDefault(); redo(); return; }
      if (lower === 'c') { event.preventDefault(); copySelected(); return; }
      if (lower === 'x') { event.preventDefault(); cutSelected(); return; }
      if (lower === 'v') { event.preventDefault(); pasteClipboard(); return; }
      if (lower === 'a') { event.preventDefault(); selectAllItems(); return; }
      if (lower === 'd') { event.preventDefault(); duplicateSelected(); return; }
      if (lower === 'k') { event.preventDefault(); splitAllAtPlayhead(); return; }
      if (lower === 'e') { event.preventDefault(); openExport(); return; }
      return;
    }
    if (isTyping(event.target)) return;
    if (event.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      event.preventDefault();
      moveSelectedToAdjacentTrack(key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (event.repeat && ['s', 'S', 'm', 'M', 'i', 'I', 'o', 'O', 'j', 'J', 'k', 'K', 'l', 'L', 'f', 'F'].includes(key)) return;
    if (event.code === 'Space') {
      event.preventDefault();
      preview.toggle();
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      if (event.shiftKey) rippleDeleteSelected(); else deleteSelected();
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault();
      preview.pause();
      if (event.shiftKey) setPlayhead(S.playhead + (key === 'ArrowRight' ? 1 : -1));
      else stepFrame(key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      event.preventDefault();
      const points = editPoints();
      const target = key === 'ArrowUp'
        ? [...points].reverse().find((point) => point < S.playhead - 0.01)
        : points.find((point) => point > S.playhead + 0.01);
      if (target !== undefined) setPlayhead(target);
      return;
    }
    if (key === 'Home') { event.preventDefault(); setPlayhead(0); return; }
    if (key === 'End') { event.preventDefault(); setPlayhead(mainDuration()); return; }
    if (key === 's' || key === 'S') { event.preventDefault(); splitAtPlayhead(); return; }
    if (key === 'M' && event.shiftKey) { event.preventDefault(); addMarker(); return; }
    if (key === 'm' || key === 'M') {
      event.preventDefault();
      if (!toggleMuteSelected()) {
        S.muted = !S.muted;
        preview.updateTransport();
        preview.syncMedia(true);
      }
      return;
    }
    if (key === 'i' || key === 'I') { event.preventDefault(); trimToPlayhead('in'); return; }
    if (key === 'o' || key === 'O') { event.preventDefault(); trimToPlayhead('out'); return; }
    if (key === 'j' || key === 'J') { event.preventDefault(); preview.play(-1); return; }
    if (key === 'k' || key === 'K') { event.preventDefault(); preview.pause(); return; }
    if (key === 'l' || key === 'L') { event.preventDefault(); preview.play(1); return; }
    if (key === '+' || key === '=') {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent('cinecut:zoom', { detail: 10 }));
      return;
    }
    if (key === '-' || key === '_') {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent('cinecut:zoom', { detail: -10 }));
      return;
    }
    if (key === 'f' || key === 'F') {
      event.preventDefault();
      const panel = document.querySelector('.stage-panel');
      if (!document.fullscreenElement) panel?.requestFullscreen?.().catch(() => {});
      else document.exitFullscreen?.().catch(() => {});
      return;
    }
    if (key === '?') { event.preventDefault(); openModal('#helpModal'); }
  });
  // 关闭页面/切换标签时兜底保存到 /data；sendBeacon 不阻塞卸载。
  window.addEventListener('beforeunload', (event) => {
    if (!S.dirty) return;
    if (!saveBeacon()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  window.addEventListener('pagehide', () => {
    if (S.dirty) saveBeacon();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.dirty) saveNow().catch(() => {});
  });
}

// ------------------------------------------------------------ SSE

let eventSource = null;
let refreshTimer = null;

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshTasks().catch(() => {}); }, 150);
}

function connectSSE() {
  if (eventSource) eventSource.close();
  eventSource = new EventSource('/api/events');
  eventSource.addEventListener('hello', () => {});
  eventSource.addEventListener('task', () => scheduleRefresh());
  eventSource.addEventListener('task_deleted', () => scheduleRefresh());
  eventSource.addEventListener('queue', (event) => {
    try { S.queue = { ...S.queue, ...JSON.parse(event.data) }; } catch (error) { /* ignore */ }
    renderQueue();
  });
  eventSource.addEventListener('log', (event) => {
    try {
      appendLog(JSON.parse(event.data));
    } catch (error) { /* ignore */ }
  });
  eventSource.onopen = () => {
    const now = Date.now();
    if (now - lastLogRefresh > 3000) {
      lastLogRefresh = now;
      refreshTasks().catch(() => {});
      loadLogs().catch(() => {});
    }
  };
  eventSource.onerror = () => { /* EventSource 自动重连 */ };
}

// ------------------------------------------------------------ 示波器

let scopeTimer = 0;
let scopeBuffer = null;

function drawScopes() {
  const canvas = $('#scopesCanvas');
  const source = $('#previewCanvas');
  if (!canvas || !source || !S.showScopes) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (!scopeBuffer) {
    scopeBuffer = document.createElement('canvas');
    scopeBuffer.width = 192;
    scopeBuffer.height = 108;
  }
  const bctx = scopeBuffer.getContext('2d', { willReadFrequently: true });
  if (!bctx) return;
  bctx.drawImage(source, 0, 0, scopeBuffer.width, scopeBuffer.height);
  const data = bctx.getImageData(0, 0, scopeBuffer.width, scopeBuffer.height).data;
  const hist = [new Uint32Array(64), new Uint32Array(64), new Uint32Array(64)];
  let max = 1;
  for (let index = 0; index < data.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const bucket = Math.min(63, data[index + channel] >> 2);
      hist[channel][bucket] += 1;
      if (hist[channel][bucket] > max) max = hist[channel][bucket];
    }
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(8,12,20,.78)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const colors = ['rgba(248,113,113,.9)', 'rgba(74,222,128,.9)', 'rgba(96,165,250,.9)'];
  hist.forEach((buckets, channel) => {
    ctx.beginPath();
    ctx.strokeStyle = colors[channel];
    ctx.lineWidth = 1.2;
    for (let bucket = 0; bucket < 64; bucket += 1) {
      const x = (bucket / 63) * (canvas.width - 8) + 4;
      const y = canvas.height - 6 - (buckets[bucket] / max) * (canvas.height - 16);
      if (bucket === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
  ctx.fillStyle = 'rgba(226,232,240,.7)';
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillText('RGB PARADE', 6, 12);
}

function toggleScopes() {
  S.showScopes = !S.showScopes;
  $('#scopesCanvas')?.classList.toggle('hidden', !S.showScopes);
  $('#scopesBtn')?.classList.toggle('active', S.showScopes);
  if (S.showScopes) {
    clearInterval(scopeTimer);
    scopeTimer = setInterval(drawScopes, 400);
    drawScopes();
  } else {
    clearInterval(scopeTimer);
    scopeTimer = 0;
  }
}

// ------------------------------------------------------------ 启动

function showBootError(error) {
  const boot = $('#boot');
  const message = error?.message || String(error);
  $('#bootError').classList.remove('hidden');
  $('#bootError').textContent = `加载失败：${message}`;
  if (!$('#bootRetry')) {
    const button = document.createElement('button');
    button.id = 'bootRetry';
    button.className = 'btn btn-primary';
    button.textContent = '重新加载';
    button.addEventListener('click', () => window.location.reload());
    boot.appendChild(button);
  }
}

async function boot() {
  initTheme();
  bindModalBasics();
  bindHeader();
  bindTabs();
  bindExport();
  bindProjects();
  bindKeyboard();
  preview.init();
  initTimeline();
  initInspector();
  initLibrary();
  initContextMenu();
  initQueue();
  initSubtitles();
  initMixer();
  $('#scopesBtn')?.addEventListener('click', () => toggleScopes());
  try {
    await loadConfig();
    await loadBuiltinManifest().catch(() => {});
    await refreshProjects();
    const last = localStorage.getItem('cinecut-project');
    const project = S.projects.find((item) => item.id === last) || S.projects[0];
    if (!project) throw new Error('没有可用的工程');
    await openProject(project.id, { skipSave: true });
    await loadDir('');
    await refreshTasks();
    await loadLogs();
    connectSSE();
    document.querySelectorAll('.side-tabs button').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.dataset.tab === 'queue') refreshTasks().catch(() => {});
      });
    });
    setTimeout(() => {
      $('#boot').classList.add('done');
      renderTimeline();
      preview.layout();
      preview.drawSoon();
    }, 120);
  } catch (error) {
    console.error(error);
    showBootError(error);
  }
}

boot();
