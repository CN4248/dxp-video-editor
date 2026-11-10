import { S, mutate, newId, selectMany } from './store.js';
import { $, closeModal, fmtTime, openModal, toast } from './ui.js';

function firstTextTrack() {
  return (S.doc?.tracks || []).find((track) => track.type === 'text')?.id || 't1';
}

export function srtTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const ms = Math.round((value % 1) * 1000);
  const total = Math.floor(value);
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss},${String(ms).padStart(3, '0')}`;
}

function parseSrt(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  const cues = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((line, index) => line.trim() || index > 0);
    if (!lines.length) continue;
    let cursor = 0;
    if (/^\d+$/.test(lines[0].trim())) cursor = 1;
    const timing = lines[cursor] || '';
    const match = timing.match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
    if (!match) continue;
    const toSeconds = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
    const start = toSeconds(match[1], match[2], match[3], match[4]);
    const end = toSeconds(match[5], match[6], match[7], match[8]);
    const body = lines.slice(cursor + 1).join('\n').trim();
    if (!body || end <= start) continue;
    cues.push({ start, end, text: body });
  }
  return cues;
}

export function exportSrt() {
  const texts = [...(S.doc?.texts || [])].sort((a, b) => (a.start || 0) - (b.start || 0));
  if (!texts.length) { toast('当前工程没有字幕片段', 'err'); return; }
  const body = texts.map((item, index) => `${index + 1}\n${srtTime(item.start)} --> ${srtTime((Number(item.start) || 0) + (Number(item.duration) || 0))}\n${item.text}\n`).join('\n');
  const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${(S.doc?.name || '字幕').replace(/[\\/:*?"<>|]/g, '_')}.srt`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`已导出 ${texts.length} 条字幕`, 'ok');
}

export async function importSrtFile(file) {
  if (!file) return;
  const text = await file.text();
  const cues = parseSrt(text);
  if (!cues.length) { toast('没有解析到有效字幕，请检查 SRT 格式', 'err'); return; }
  const trackId = firstTextTrack();
  const created = [];
  mutate(() => {
    for (const cue of cues) {
      const item = {
        id: newId('t'), trackId, text: cue.text, start: Math.round(cue.start * 1000) / 1000,
        duration: Math.max(0.1, Math.round((cue.end - cue.start) * 1000) / 1000),
        x: 0.5, y: 0.82, size: 54, color: '#ffffff', bgEnabled: true, bg: '#000000',
        bgAlpha: 0.55, bold: true, italic: false, outline: 3, shadow: 1, opacity: 1, keyframes: {},
      };
      S.doc.texts.push(item);
      created.push({ kind: 'text', id: item.id });
    }
  }, `srt-import-${Date.now()}`);
  selectMany(created);
  toast(`已导入 ${cues.length} 条字幕（${fmtTime(cues[0].start)} 起）`, 'ok', 3200);
}

export function initSubtitles() {
  $('#srtBtn')?.addEventListener('click', () => {
    const count = (S.doc?.texts || []).length;
    $('#srtStats').textContent = `当前工程有 ${count} 条字幕片段。`;
    openModal('#srtModal');
  });
  $('#srtImportOpen')?.addEventListener('click', () => $('#srtFile')?.click());
  $('#srtFile')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await importSrtFile(file);
    closeModal('#srtModal');
  });
  $('#srtExport')?.addEventListener('click', () => exportSrt());
}
