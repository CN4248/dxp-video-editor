import {
  S, findItem, isSelected, mainDuration, select, selectAll as selectAllItems, selectionItems,
  setPlayhead, stepFrame, titleFor, tracksOfType,
} from './store.js';
import {
  addAudio, addMain, addOverlay, addText, copySelected, cutSelected, deleteSelected,
  deleteTrack, duplicateSelected, freezeFrame, moveSelectedToAdjacentTrack, moveSelectedToMain,
  moveSelectedToTrack, pasteClipboard, reverseClip, rippleDeleteSelected, separateAudio,
  splitAllAtPlayhead, splitAtPlayhead, toggleMuteSelected,
} from './actions.js';
import {
  addBuiltinAudio, addSticker, addSubtitleTemplate, applyFilter, applyMosaicEffect, builtinItem,
  clearMosaic,
} from './builtins.js';
import { preview } from './preview.js';
import { renderTimeline } from './timeline.js';
import { $, fmtTime, icon, toast } from './ui.js';

let menu = null;

function closeContextMenu() {
  if (!menu) return;
  menu.remove();
  menu = null;
}

function makeButton(item, onActivate) {
  const button = document.createElement('button');
  button.className = `ctx-item${item.danger ? ' danger' : ''}`;
  button.type = 'button';
  button.disabled = Boolean(item.disabled);
  const left = document.createElement('span');
  left.className = 'ctx-left';
  left.innerHTML = item.icon ? icon(item.icon, 'icon') : '<span class="ctx-dot"></span>';
  const label = document.createElement('span');
  label.className = 'ctx-label';
  label.textContent = item.label;
  left.appendChild(label);
  button.appendChild(left);
  if (item.hint) {
    const hint = document.createElement('kbd');
    hint.textContent = item.hint;
    button.appendChild(hint);
  }
  if (item.children?.length) {
    const arrow = document.createElement('span');
    arrow.className = 'ctx-arrow';
    arrow.innerHTML = icon('chevron-right', 'icon');
    button.appendChild(arrow);
  }
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (button.disabled) return;
    onActivate(button);
  });
  return button;
}

function openMenu(event, header, rawItems) {
  closeContextMenu();
  const node = document.createElement('div');
  node.className = 'ctx-menu';
  node.setAttribute('role', 'menu');
  if (header) {
    const head = document.createElement('div');
    head.className = 'ctx-head';
    head.innerHTML = header;
    node.appendChild(head);
  }
  const items = rawItems.filter(Boolean);
  for (const item of items) {
    if (item === '-') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      node.appendChild(sep);
      continue;
    }
    if (item.children?.length) {
      const sub = document.createElement('div');
      sub.className = 'ctx-sub';
      for (const child of item.children) {
        if (child === '-') {
          const childSep = document.createElement('div');
          childSep.className = 'ctx-sep';
          sub.appendChild(childSep);
          continue;
        }
        sub.appendChild(makeButton(child, () => {
          closeContextMenu();
          try { child.action?.(); } catch (error) { toast(error.message, 'err'); }
        }));
      }
      const button = makeButton(item, () => {
        button.classList.toggle('open');
        sub.classList.toggle('open');
        positionMenu(node, Number(node.dataset.anchorX), Number(node.dataset.anchorY));
      });
      node.appendChild(button);
      node.appendChild(sub);
    } else {
      node.appendChild(makeButton(item, () => {
        closeContextMenu();
        try { item.action?.(); } catch (error) { toast(error.message, 'err'); }
      }));
    }
  }
  document.body.appendChild(node);
  menu = node;
  node.dataset.anchorX = String(event.clientX);
  node.dataset.anchorY = String(event.clientY);
  positionMenu(node, event.clientX, event.clientY);
}

function positionMenu(node, clientX, clientY) {
  const rect = node.getBoundingClientRect();
  const pad = 8;
  let left = clientX;
  let top = clientY;
  if (left + rect.width + pad > window.innerWidth) left = Math.max(pad, window.innerWidth - rect.width - pad);
  if (top + rect.height + pad > window.innerHeight) top = Math.max(pad, window.innerHeight - rect.height - pad);
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
}

function showInspector() {
  window.dispatchEvent(new CustomEvent('cinecut:tab', { detail: 'inspector' }));
}

function blockMenu(event, block) {
  const kind = block.dataset.kind;
  const id = block.dataset.id;
  if (!isSelected(kind, id)) select(kind, id);
  const entries = selectionItems();
  if (!entries.length) return;
  const count = entries.length;
  const primary = findItem(kind, id);
  const hasMain = entries.some((entry) => entry.kind === 'main');
  const hasOverlay = entries.some((entry) => entry.kind === 'overlay');
  const hasVideoOverlay = entries.some((entry) => entry.kind === 'overlay' && entry.item.kind === 'video');
  const hasAudio = entries.some((entry) => entry.kind === 'audio');
  const hasText = entries.some((entry) => entry.kind === 'text');
  const header = count > 1
    ? `已选 <strong>${count}</strong> 个片段`
    : `<b>${escapeText(titleFor(kind, primary))}</b><span>${kindLabel(kind)}</span>`;
  const filterChildren = (S.builtin?.filters || []).map((filter) => ({
    label: filter.name,
    hint: filter.desc,
    action: () => applyFilter(filter),
  }));
  const effectChildren = (S.builtin?.effects || []).map((effect) => ({
    label: effect.name,
    hint: effectModeLabel(effect.mode),
    action: () => applyMosaicEffect(effect),
  }));
  const trackChildren = (S.doc?.tracks || []).filter((track) => {
    if (track.type === 'video') return hasMain || hasOverlay;
    if (track.type === 'audio') return hasAudio;
    return hasText && track.type === 'text';
  }).map((track) => ({
    label: track.name,
    hint: track.type === 'video' && hasMain ? '转叠加层' : trackTypeLabel(track.type),
    action: () => moveSelectedToTrack(track.id),
  }));
  if (hasVideoOverlay) {
    trackChildren.unshift({
      label: '主视频轨', hint: '转为顺序片段',
      action: () => moveSelectedToMain(),
    });
  }
  if (!trackChildren.length) {
    trackChildren.push({ label: '没有可用的同类轨道', disabled: true });
  }
  trackChildren.push('-');
  trackChildren.push({
    label: '新建轨道…', icon: 'plus',
    action: () => $('#addTrackBtn')?.click(),
  });
  openMenu(event, header, [
    { label: '复制', icon: 'copy', hint: 'Ctrl+C', action: copySelected },
    { label: '剪切', icon: 'scissors', hint: 'Ctrl+X', action: cutSelected },
    { label: '粘贴', icon: 'download', hint: 'Ctrl+V', action: pasteClipboard, disabled: !S.clipboard },
    { label: '复制一份', icon: 'copy', hint: 'Ctrl+D', action: duplicateSelected },
    { label: '删除', icon: 'trash', hint: 'Del', action: deleteSelected, danger: true },
    '-',
    { label: '在播放头分割', icon: 'split', hint: 'S', action: splitAtPlayhead },
    { label: '分割所有轨道', icon: 'split', hint: 'Ctrl+K', action: splitAllAtPlayhead },
    { label: '波纹删除（后续前移）', icon: 'trash', action: rippleDeleteSelected, danger: true },
    '-',
    { label: '插入冻结帧（3 秒）', icon: 'image', action: freezeFrame, disabled: !hasMain },
    { label: '倒放片段', icon: 'refresh', action: reverseClip, disabled: !hasMain },
    { label: '静音 / 取消静音', icon: 'volume-x', hint: 'M', action: toggleMuteSelected, disabled: !hasMain && !hasAudio },
    { label: '分离音轨', icon: 'music', action: separateAudio, disabled: !hasMain },
    '-',
    { label: '应用滤镜', icon: 'palette', children: filterChildren, disabled: !hasMain },
    { label: '马赛克 / 遮挡', icon: 'layers', children: effectChildren, disabled: !hasMain },
    { label: '关闭马赛克 / 遮挡', icon: 'x', action: clearMosaic, disabled: !hasMain },
    { label: '移回主视频轨', icon: 'film', action: moveSelectedToMain, disabled: !hasVideoOverlay },
    { label: '移到上一条同类轨道', icon: 'chevron-up', hint: 'Alt+↑', action: () => moveSelectedToAdjacentTrack(-1) },
    { label: '移到下一条同类轨道', icon: 'chevron-down', hint: 'Alt+↓', action: () => moveSelectedToAdjacentTrack(1) },
    { label: '移动到指定轨道', icon: 'layers', children: trackChildren },
    '-',
    { label: '属性面板', icon: 'settings', action: showInspector },
  ]);
}

function laneMenu(event, lane) {
  const isMain = lane.id === 'laneMain';
  const track = isMain ? null : (S.doc?.tracks || []).find((entry) => entry.id === lane.dataset.lane);
  const time = Math.max(0, (event.clientX - $('#tlContent').getBoundingClientRect().left) / S.zoom);
  const header = `<b>${isMain ? '主视频轨' : escapeText(track?.name || '轨道')}</b><span>${fmtTime(time, 2)} 处</span>`;
  openMenu(event, header, [
    {
      label: '粘贴到此处', icon: 'download', hint: 'Ctrl+V', disabled: !S.clipboard,
      action: () => { setPlayhead(time); pasteClipboard(); },
    },
    { label: '在此处添加字幕', icon: 'type', action: () => { setPlayhead(time); addText(); } },
    '-',
    { label: '全选时间线', icon: 'list', hint: 'Ctrl+A', action: selectAllItems },
    { label: '新建轨道…', icon: 'plus', action: () => $('#addTrackBtn')?.click() },
    { label: '保存工程', icon: 'save', hint: 'Ctrl+S', action: () => document.querySelector('#saveBtn')?.click() },
  ]);
}

function fileMenu(event, row) {
  const path = row.dataset.path || '';
  const entry = [...(S.entries || []), ...(S.searchResults || [])]
    .find((item) => item.path === path) || S.entries?.[Number(row.dataset.index)];
  if (!entry || entry.type !== 'file') return;
  const items = [];
  if (entry.kind === 'video') {
    items.push({ label: '加入主轨', icon: 'film', action: () => addMain(entry).catch(() => {}) });
  }
  if (entry.kind === 'video' || entry.kind === 'image') {
    items.push({ label: '作为叠加层', icon: 'layers', action: () => addOverlay(entry).catch(() => {}) });
  }
  if (entry.kind === 'audio' || entry.kind === 'video') {
    items.push({ label: '加入音轨', icon: 'music', action: () => addAudio(entry).catch(() => {}) });
  }
  items.push('-');
  items.push({
    label: '复制路径', icon: 'copy',
    action: async () => {
      try {
        await navigator.clipboard.writeText(entry.path);
        toast('路径已复制', 'ok', 1500);
      } catch (error) {
        toast(`复制失败：${error.message}`, 'err');
      }
    },
  });
  openMenu(event, `<b>${escapeText(entry.name)}</b><span>${entry.kind}</span>`, items);
}

function builtinMenu(event, target) {
  let category = '';
  let id = '';
  if (target.dataset.filter) { category = 'filters'; id = target.dataset.filter; }
  else if (target.dataset.subtitle) { category = 'subtitles'; id = target.dataset.subtitle; }
  else if (target.dataset.sticker) { category = 'stickers'; id = target.dataset.sticker; }
  else if (target.dataset.baudio) { category = 'audio'; id = target.dataset.baudio; }
  else if (target.dataset.effect) { category = 'effects'; id = target.dataset.effect; }
  const item = builtinItem(category, id);
  if (!item) return;
  const items = [];
  if (category === 'filters') {
    items.push({ label: '应用滤镜', icon: 'palette', action: () => applyFilter(item) });
  } else if (category === 'effects') {
    items.push({ label: '应用到选中的主轨片段', icon: 'layers', action: () => applyMosaicEffect(item) });
  } else if (category === 'subtitles') {
    items.push({ label: '添加到字幕轨', icon: 'type', action: () => builtinAdd(item, 'subtitles') });
  } else if (category === 'stickers') {
    items.push({ label: '添加到视频轨', icon: 'layers', action: () => builtinAdd(item, 'stickers') });
  } else if (category === 'audio') {
    items.push({ label: '添加到音频轨', icon: 'music', action: () => builtinAdd(item, 'audio') });
  }
  items.push('-');
  items.push({ label: '提示：可直接拖到时间线对应轨道', icon: 'info', disabled: true });
  openMenu(event, `<b>${escapeText(item.name)}</b><span>${escapeText(item.desc || '')}</span>`, items);
}

function builtinAdd(item, category) {
  if (category === 'subtitles') addSubtitleTemplate(item);
  else if (category === 'stickers') addSticker(item);
  else if (category === 'audio') addBuiltinAudio(item);
}

function stageMenu(event) {
  openMenu(event, `<b>预览</b><span>${fmtTime(S.playhead, 2)} / ${fmtTime(mainDuration(), 2)}</span>`, [
    { label: S.playing ? '暂停' : '播放', icon: S.playing ? 'pause' : 'play', hint: 'Space', action: () => preview.toggle() },
    { label: '上一帧', icon: 'frame-back', hint: '←', action: () => { preview.pause(); stepFrame(-1); } },
    { label: '下一帧', icon: 'frame-forward', hint: '→', action: () => { preview.pause(); stepFrame(1); } },
    '-',
    { label: '在播放头添加字幕', icon: 'type', action: () => addText() },
    { label: '静音预览', icon: 'volume-x', action: () => { S.muted = !S.muted; preview.updateTransport(); preview.syncMedia(true); } },
    { label: '全选时间线', icon: 'list', hint: 'Ctrl+A', action: selectAllItems },
    '-',
    { label: '导出影片', icon: 'export', action: () => window.dispatchEvent(new CustomEvent('cinecut:export')) },
  ]);
}

function trackLabelMenu(event, label) {
  const trackId = label.dataset.trackId;
  if (!trackId) return;
  const track = (S.doc?.tracks || []).find((entry) => entry.id === trackId);
  if (!track) return;
  openMenu(event, `<b>${escapeText(track.name)}</b><span>${trackTypeLabel(track.type)} · ${tracksOfType(track.type).length} 条</span>`, [
    { label: '选中该轨道', icon: 'check', action: () => { S.activeTrackId = trackId; renderTimeline(); } },
    { label: '在此轨道添加素材', icon: 'plus', action: () => { S.activeTrackId = trackId; toast('已选中轨道，从素材库双击即可加入', 'info'); } },
    '-',
    { label: '删除轨道', icon: 'trash', danger: true, action: () => deleteTrack(trackId) },
  ]);
}

function kindLabel(kind) {
  return { main: '主轨片段', overlay: '叠加层', audio: '音轨', text: '字幕' }[kind] || '';
}

function trackTypeLabel(type) {
  return { video: '视频轨', audio: '音频轨', text: '字幕轨' }[type] || '';
}

function effectModeLabel(mode) {
  return { pixel: '像素化', blur: '模糊', black: '黑块遮挡' }[mode] || '像素化';
}

function escapeText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function initContextMenu() {
  document.addEventListener('contextmenu', (event) => {
    if (!(event.target instanceof Element)) return;
    const block = event.target.closest('.block');
    if (block) { event.preventDefault(); blockMenu(event, block); return; }
    const label = event.target.closest('.track-label[data-track-id]');
    if (label) { event.preventDefault(); trackLabelMenu(event, label); return; }
    const lane = event.target.closest('.lane');
    if (lane) { event.preventDefault(); laneMenu(event, lane); return; }
    const ruler = event.target.closest('.ruler');
    if (ruler) {
      event.preventDefault();
      const time = Math.max(0, (event.clientX - $('#tlContent').getBoundingClientRect().left) / S.zoom);
      openMenu(event, `<b>时间线</b><span>${fmtTime(time, 2)} 处</span>`, [
        { label: '移动播放头到此处', icon: 'clock', action: () => setPlayhead(time) },
        { label: '在此处添加字幕', icon: 'type', action: () => { setPlayhead(time); addText(); } },
        { label: '全选时间线', icon: 'list', hint: 'Ctrl+A', action: selectAllItems },
      ]);
      return;
    }
    const row = event.target.closest('#fileList .file-row');
    if (row) { event.preventDefault(); fileMenu(event, row); return; }
    const builtin = event.target.closest('#builtinContent [data-filter], #builtinContent [data-subtitle], #builtinContent [data-sticker], #builtinContent [data-baudio], #builtinContent [data-effect]');
    if (builtin) { event.preventDefault(); builtinMenu(event, builtin); return; }
    const stage = event.target.closest('#stage');
    if (stage) { event.preventDefault(); stageMenu(event); }
  });
  document.addEventListener('pointerdown', (event) => {
    if (menu && !menu.contains(event.target)) closeContextMenu();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeContextMenu();
  });
  window.addEventListener('blur', closeContextMenu);
  window.addEventListener('resize', closeContextMenu);
  document.addEventListener('scroll', (event) => {
    // 菜单自身内容超出高度时会在内部滚动；不要把这种滚动当成“页面滚动”而关掉菜单。
    if (menu && event.target instanceof Node && menu.contains(event.target)) return;
    closeContextMenu();
  }, true);
}
