import { api } from './api.js';
import { S, emit, on } from './store.js';
import { $, confirmDialog, debounce, escapeHtml, fmtAgo, fmtTime, icon, toast } from './ui.js';

const STATUS_TEXT = {
  queued: '排队中',
  running: '渲染中',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
  canceled: '已终止',
};

let logAuto = localStorage.getItem('cinecut-log-auto') !== '0';
let taskRefreshTimer = null;

function scheduleTaskRefresh() {
  clearTimeout(taskRefreshTimer);
  taskRefreshTimer = setTimeout(() => { refreshTasks().catch(() => {}); }, 140);
}

export async function refreshTasks() {
  const data = await api.get('/api/tasks');
  S.tasks = data.tasks || [];
  S.queue = data.queue || S.queue;
  const ids = new Set(S.tasks.map((task) => task.id));
  for (const id of Array.from(S.taskSel)) if (!ids.has(id)) S.taskSel.delete(id);
  renderQueue();
  renderLogFilters();
  renderLogs();
}

function activeCount() {
  return S.tasks.filter((task) => ['queued', 'running', 'paused'].includes(task.status)).length;
}

function actionButtons(task) {
  const buttons = [];
  if (task.status === 'queued') {
    buttons.push(`<button data-act="pause" data-id="${task.id}" type="button">暂停</button>`);
    buttons.push(`<button data-act="stop" data-id="${task.id}" type="button" class="danger">终止</button>`);
  } else if (task.status === 'running') {
    buttons.push(`<button data-act="pause" data-id="${task.id}" type="button" class="accent">暂停</button>`);
    buttons.push(`<button data-act="stop" data-id="${task.id}" type="button" class="danger">终止</button>`);
    buttons.push(`<button data-act="log" data-id="${task.id}" type="button">日志</button>`);
  } else if (task.status === 'paused') {
    buttons.push(`<button data-act="resume" data-id="${task.id}" type="button" class="accent">继续</button>`);
    buttons.push(`<button data-act="stop" data-id="${task.id}" type="button" class="danger">终止</button>`);
    buttons.push(`<button data-act="log" data-id="${task.id}" type="button">日志</button>`);
  } else if (task.status === 'done') {
    buttons.push(`<a class="mini-link" href="/api/output?path=${encodeURIComponent(task.output)}" target="_blank" rel="noopener">${icon('download')}打开</a>`);
    buttons.push(`<button data-act="delete" data-id="${task.id}" type="button" class="danger">删除</button>`);
    buttons.push(`<button data-act="log" data-id="${task.id}" type="button">日志</button>`);
  } else if (task.status === 'failed' || task.status === 'canceled') {
    buttons.push(`<button data-act="retry" data-id="${task.id}" type="button" class="accent">重试</button>`);
    buttons.push(`<button data-act="delete" data-id="${task.id}" type="button" class="danger">删除</button>`);
    buttons.push(`<button data-act="log" data-id="${task.id}" type="button">日志</button>`);
  }
  return buttons.join('');
}

function taskHtml(task) {
  const selected = S.taskSel.has(task.id);
  const pct = Math.max(0, Math.min(100, Number(task.progress) || 0));
  const stage = task.status === 'done' ? (task.output || task.stage)
    : task.status === 'failed' ? (task.message || '渲染失败')
    : task.status === 'paused' ? (task.message || task.stage)
    : task.stage || '等待中';
  return `<div class="task ${task.status} ${selected ? 'selected' : ''}" data-id="${task.id}">
    <div class="task-top">
      <input class="task-check" type="checkbox" data-check="${task.id}" ${selected ? 'checked' : ''} aria-label="选择任务">
      <span class="task-name" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</span>
      <span class="status ${task.status}">${STATUS_TEXT[task.status] || task.status}</span>
    </div>
    <div class="task-progress"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="task-info">
      <span class="stage" title="${escapeHtml(stage)}">${escapeHtml(stage)}</span>
      <span class="pct">${task.status === 'done' ? '100%' : `${pct.toFixed(0)}%`}</span>
    </div>
    ${task.error ? `<div class="task-error" title="${escapeHtml(task.error)}">${escapeHtml(task.message || task.error)}</div>` : ''}
    <div class="task-actions">${actionButtons(task)}</div>
  </div>`;
}

export function renderQueue() {
  const list = $('#taskList');
  if (!list) return;
  const counts = S.queue.counts || {};
  const running = counts.running || 0;
  const queued = counts.queued || 0;
  const paused = counts.paused || 0;
  const done = counts.done || 0;
  const failed = counts.failed || 0;
  const active = activeCount();
  const badge = $('#queueBadge');
  if (badge) {
    badge.textContent = String(active);
    badge.classList.toggle('hidden', active === 0);
  }
  $('#queueSummary').textContent = S.tasks.length ? `· ${S.tasks.length}` : '';
  const toggle = $('#queueToggleBtn');
  toggle.innerHTML = icon(S.queue.paused ? 'play' : 'pause');
  toggle.title = S.queue.paused ? '启动队列' : '暂停队列';
  $('#queueFoot').innerHTML = S.queue.paused
    ? `<span>队列已暂停 · 不会开始新任务</span><span>${queued} 待处理</span>`
    : `<span>${running ? '正在渲染' : '队列运行中'} · ${S.queue.workers || 1} 个渲染线程</span><span>${queued} 待处理</span>`;
  const batch = $('#queueBatchBar');
  batch.classList.toggle('hidden', S.taskSel.size === 0);
  $('#queueBatchCount').textContent = String(S.taskSel.size);
  const allSelected = S.tasks.length > 0 && S.taskSel.size === S.tasks.length;
  $('#queueSelectAll').textContent = allSelected ? '取消全选' : '全选';
  if (!S.tasks.length) {
    list.innerHTML = `<div class="queue-empty">${icon('queue')}<br>队列还是空的<br><span style="opacity:.7">完成剪辑后点击右上角「导出影片」</span></div>`;
    return;
  }
  list.innerHTML = S.tasks.map(taskHtml).join('');
}

// ------------------------------------------------------------ 操作

async function singleAction(taskId, action) {
  try {
    if (action === 'delete') {
      const ok = await confirmDialog('删除任务记录', '将删除该任务及其日志。已导出的视频文件不会删除。', '删除');
      if (!ok) return;
      await api.del(`/api/tasks/${taskId}`);
      S.taskSel.delete(taskId);
      toast('任务记录已删除', 'ok');
    } else if (action === 'log') {
      S.logFilter = taskId;
      const select = $('#logFilter');
      if (select) select.value = taskId;
      renderLogs();
      window.dispatchEvent(new CustomEvent('cinecut:tab', { detail: 'logs' }));
      return;
    } else {
      const data = await api.post(`/api/tasks/${taskId}/action`, { action });
      toast(data.message || '操作成功', 'ok');
    }
    await refreshTasks();
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function batchAction(action) {
  const ids = Array.from(S.taskSel);
  if (!ids.length) return;
  try {
    const data = await api.post('/api/tasks/batch', { ids, action });
    const ok = (data.results || []).filter((item) => item.ok).length;
    toast(`已对 ${ok}/${ids.length} 个任务执行${action === 'pause' ? '暂停' : action === 'resume' ? '继续' : '终止'}`, ok ? 'ok' : 'err');
    await refreshTasks();
  } catch (error) {
    toast(error.message, 'err');
  }
}

export function initQueue() {
  $('#taskList').addEventListener('click', (event) => {
    const actionButton = event.target.closest('button[data-act]');
    if (actionButton) {
      event.stopPropagation();
      singleAction(actionButton.dataset.id, actionButton.dataset.act);
      return;
    }
    const checkbox = event.target.closest('input[data-check]');
    if (checkbox) {
      const id = checkbox.dataset.check;
      if (checkbox.checked) S.taskSel.add(id);
      else S.taskSel.delete(id);
      renderQueue();
      return;
    }
    const row = event.target.closest('.task');
    if (row && !event.target.closest('a')) {
      const id = row.dataset.id;
      if (S.taskSel.has(id)) S.taskSel.delete(id);
      else S.taskSel.add(id);
      renderQueue();
    }
  });
  $('#queueSelectAll').addEventListener('click', () => {
    if (S.taskSel.size === S.tasks.length) S.taskSel.clear();
    else S.tasks.forEach((task) => S.taskSel.add(task.id));
    renderQueue();
  });
  $('#queueBatchBar').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-batch]');
    if (button) batchAction(button.dataset.batch);
  });
  $('#queueToggleBtn').addEventListener('click', async () => {
    try {
      const data = await api.post('/api/queue', { action: S.queue.paused ? 'start' : 'pause' });
      S.queue = data.queue;
      toast(S.queue.paused ? '队列已暂停，不再开始新任务' : '队列已启动', 'ok');
      renderQueue();
    } catch (error) {
      toast(error.message, 'err');
    }
  });
  $('#queueClearBtn').addEventListener('click', async () => {
    const done = S.tasks.filter((task) => task.status === 'done').length;
    if (!done) { toast('没有已完成的任务可清除', 'info'); return; }
    const ok = await confirmDialog('清除已完成任务', `将删除 ${done} 条已完成任务记录与日志，不会删除 /output 中已导出的视频。`, '清除');
    if (!ok) return;
    try {
      const data = await api.post('/api/tasks/clear-completed', {});
      toast(`已清除 ${data.removed} 条已完成记录`, 'ok');
      await refreshTasks();
    } catch (error) {
      toast(error.message, 'err');
    }
  });
  $('#queueClearAllBtn').addEventListener('click', async () => {
    if (!S.tasks.length) { toast('队列里没有任务', 'info'); return; }
    const running = S.tasks.filter((task) => ['running', 'queued', 'paused'].includes(task.status)).length;
    const ok = await confirmDialog(
      '删除全部任务',
      `将删除 ${S.tasks.length} 条任务记录与日志${running ? `，并先终止 ${running} 个未完成任务` : ''}。已导出的视频文件不会删除。`,
      '全部删除',
    );
    if (!ok) return;
    try {
      const data = await api.post('/api/tasks/clear-all', {});
      S.taskSel.clear();
      toast(`已删除 ${data.removed} 条任务记录`, 'ok');
      await refreshTasks();
    } catch (error) {
      toast(error.message, 'err');
    }
  });
  $('#queueRetryBtn').addEventListener('click', async () => {
    const failed = S.tasks.filter((task) => task.status === 'failed').length;
    if (!failed) { toast('没有失败的任务', 'info'); return; }
    try {
      const data = await api.post('/api/tasks/retry-failed', {});
      toast(`已重新排队 ${data.retried} 个失败任务`, 'ok');
      await refreshTasks();
    } catch (error) {
      toast(error.message, 'err');
    }
  });

  // 日志
  $('#logFilter').addEventListener('change', (event) => {
    S.logFilter = event.target.value;
    renderLogs();
  });
  $('#logAuto').checked = logAuto;
  $('#logAuto').addEventListener('change', (event) => {
    logAuto = event.target.checked;
    localStorage.setItem('cinecut-log-auto', logAuto ? '1' : '0');
    if (logAuto) scrollLogsToEnd();
  });
  $('#logClear').addEventListener('click', () => {
    S.logs = [];
    renderLogs();
  });
  if (S.tasks.length) renderQueue();
  renderLogs();
}

// ------------------------------------------------------------ 日志

export async function loadLogs() {
  try {
    const data = await api.get('/api/logs?limit=300');
    S.logs = data.logs || [];
    renderLogs();
  } catch (error) {
    console.warn('加载日志失败', error);
  }
}

export function appendLog(entry) {
  if (!entry || typeof entry.line !== 'string') return;
  S.logs.push(entry);
  if (S.logs.length > 1500) S.logs.splice(0, S.logs.length - 1500);
  if (!matchesFilter(entry)) return;
  appendLogLine(entry);
  updateLogCount();
  if (logAuto) scrollLogsToEnd();
}

function matchesFilter(entry) {
  return !S.logFilter || entry.taskId === S.logFilter;
}

function logClass(line) {
  if (/❌|失败|error|Error|Traceback/.test(line)) return 'err';
  if (/✅|完成|已导出|导出成功/.test(line)) return 'ok';
  if (/服务重启|队列|上传/.test(line)) return 'sys';
  return '';
}

function logTag(taskId) {
  if (!taskId || taskId === 'queue' || taskId === 'upload') return '系统';
  const task = S.tasks.find((item) => item.id === taskId);
  return task ? task.title.split(' · ')[0].slice(0, 10) : taskId.slice(-6);
}

function logLineHtml(entry) {
  const date = new Date(entry.ts * 1000);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  return `<div class="log-line ${logClass(entry.line)}" data-log-id="${entry.id}">
    <span class="lt">${time}</span><span class="ltag">${escapeHtml(logTag(entry.taskId))}</span>
    <span class="lmsg">${escapeHtml(entry.line)}</span></div>`;
}

function appendLogLine(entry) {
  const view = $('#logView');
  if (!view) return;
  if (view.querySelector('.log-empty')) view.innerHTML = '';
  view.insertAdjacentHTML('beforeend', logLineHtml(entry));
  while (view.children.length > 1200) view.firstElementChild.remove();
}

export function renderLogs() {
  const view = $('#logView');
  if (!view) return;
  const filtered = S.logs.filter(matchesFilter);
  if (!filtered.length) {
    view.innerHTML = `<div class="log-empty" style="padding:22px 12px;text-align:center;color:var(--faint);font-size:10.5px">${S.logFilter ? '该任务暂时没有日志' : '等待任务日志…'}</div>`;
  } else {
    view.innerHTML = filtered.map(logLineHtml).join('');
  }
  updateLogCount(filtered.length);
  if (logAuto) scrollLogsToEnd();
}

function updateLogCount(count) {
  const total = count ?? S.logs.filter(matchesFilter).length;
  $('#logCount').textContent = total ? `· ${total}` : '';
  $('#logFoot').textContent = logAuto ? '实时追加 · 自动滚动到底部' : '实时追加 · 自动滚动已关闭';
}

function scrollLogsToEnd() {
  const view = $('#logView');
  if (view) view.scrollTop = view.scrollHeight;
}

function renderLogFilters() {
  const select = $('#logFilter');
  if (!select) return;
  const current = S.logFilter;
  const options = ['<option value="">全部日志</option>'];
  for (const task of S.tasks) {
    options.push(`<option value="${task.id}">${escapeHtml(task.title.slice(0, 40))}</option>`);
  }
  select.innerHTML = options.join('');
  select.value = S.tasks.some((task) => task.id === current) ? current : '';
  if (!S.tasks.some((task) => task.id === current)) S.logFilter = '';
}

export function initQueueEvents() {
  on('tasks:refresh', () => refreshTasks().catch(() => {}));
  window.addEventListener('cinecut:tasks', () => scheduleTaskRefresh());
  on('log', () => {});
}
