import { S, mutate, on } from './store.js';
import { $, clamp, escapeHtml, icon, openModal } from './ui.js';

function mixerRows() {
  const tracks = (S.doc?.tracks || []).filter((track) => track.type === 'audio');
  const counts = {};
  for (const item of S.doc?.audios || []) counts[item.trackId] = (counts[item.trackId] || 0) + 1;
  return tracks.map((track) => `
    <div class="mixer-row" data-track-id="${track.id}">
      <div class="mixer-name">${icon('volume')}<b>${escapeHtml(track.name)}</b><span>${counts[track.id] || 0} 段</span></div>
      <div class="mixer-fader">
        <input type="range" data-mixer-vol min="0" max="2" step="0.01" value="${Number(track.volume ?? 1)}">
        <b data-mixer-label>${Math.round(Number(track.volume ?? 1) * 100)}%</b>
      </div>
      <div class="mixer-btns">
        <button class="tact${track.muted ? ' on' : ''}" data-mixer-mute type="button" title="静音">M</button>
        <button class="tact${track.solo ? ' on' : ''}" data-mixer-solo type="button" title="独奏">S</button>
      </div>
    </div>`).join('') || '<p class="prop-note">还没有音频轨道，先在时间线工具栏里新建一条。</p>';
}

function renderMixer() {
  const list = $('#mixerList');
  if (!list) return;
  list.innerHTML = mixerRows();
  list.querySelectorAll('.mixer-row').forEach((row) => {
    const track = (S.doc?.tracks || []).find((item) => item.id === row.dataset.trackId);
    if (!track) return;
    const fader = row.querySelector('[data-mixer-vol]');
    const label = row.querySelector('[data-mixer-label]');
    fader?.addEventListener('input', () => {
      const value = clamp(Number(fader.value) || 0, 0, 2);
      label.textContent = `${Math.round(value * 100)}%`;
      mutate(() => { track.volume = Math.round(value * 1000) / 1000; }, `mixer-vol-${track.id}`, { source: 'mixer' });
    });
    row.querySelector('[data-mixer-mute]')?.addEventListener('click', (event) => {
      mutate(() => { track.muted = !track.muted; }, `mixer-mute-${track.id}`);
      event.currentTarget.classList.toggle('on', track.muted);
    });
    row.querySelector('[data-mixer-solo]')?.addEventListener('click', (event) => {
      mutate(() => { track.solo = !track.solo; }, `mixer-solo-${track.id}`);
      event.currentTarget.classList.toggle('on', track.solo);
    });
  });
}

export function initMixer() {
  $('#mixerBtn')?.addEventListener('click', () => {
    renderMixer();
    openModal('#mixerModal');
  });
  on('doc', () => { if (!$('#mixerModal')?.classList.contains('hidden')) renderMixer(); });
}
