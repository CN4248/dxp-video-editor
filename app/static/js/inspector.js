import {
  S, clipDuration, mainDuration, mainOffsets, mutate, on, selectedItem, selectionItems,
  titleFor,
} from './store.js';
import {
  deleteSelected, duplicateSelected, moveMain, separateAudio, splitAtPlayhead,
  toggleMuteSelected, trimToPlayhead,
} from './actions.js';
import { $, clamp, escapeHtml, fmtTime, icon, toast } from './ui.js';
import {
  bindAnimation, bindBlend, bindCropMask, bindEffects, bindTransition,
  renderAnimation, renderBlend, renderCropMask, renderEffects, renderTransition,
} from './effects-ui.js';

function field(label, inner, hint = '') {
  return `<label class="field"><span>${label}</span>${inner}${hint ? `<em>${hint}</em>` : ''}</label>`;
}

function rangeField(label, id, min, max, step, value) {
  return `<div class="field">
    <span>${label}<b id="${id}Val">${value}</b></span>
    <div class="slider-row"><input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}"></div>
  </div>`;
}

function numberField(label, id, value, min, max, step, unit = '') {
  return `<div class="field"><span>${label}${unit ? `<small>${unit}</small>` : ''}</span>
    <input type="number" id="${id}" value="${value}" min="${min}" max="${max}" step="${step}">
  </div>`;
}

function quickNav(kind) {
  const items = {
    main: [['secClip', '片段/速度'], ['cropSection', '画面裁剪'], ['fxSection', '特效'],
      ['animSection', '关键帧'], ['secAudio', '音频'], ['transSection', '转场']],
    overlay: [['secClip', '位置/缩放'], ['blendSection', '混合'], ['cropSection', '裁剪/蒙版'],
      ['fxSection', '特效'], ['animSection', '关键帧']],
    audio: [['secAudio', '音频参数'], ['fxSection', '音频特效'], ['animSection', '关键帧']],
    text: [['secText', '字幕内容'], ['animSection', '关键帧']],
  }[kind] || [];
  return `<div class="inspector-nav">${items.map(([id, label]) =>
    `<button type="button" data-jump="${id}">${label}</button>`).join('')}</div>`;
}

function bindRange(id, apply, format) {
  const input = $(`#${id}`);
  const label = $(`#${id}Val`);
  if (!input) return;
  const refresh = () => { if (label) label.textContent = format(Number(input.value)); };
  input.addEventListener('input', () => {
    refresh();
    apply(Number(input.value));
  });
}

function bindNumber(id, apply) {
  const input = $(`#${id}`);
  if (!input) return;
  input.addEventListener('input', () => {
    const value = Number(input.value);
    if (Number.isFinite(value)) apply(value);
  });
}

function bindChange(id, apply) {
  const input = $(`#${id}`);
  if (!input) return;
  input.addEventListener('change', () => apply(input.value));
}

function bindCheck(id, apply) {
  const input = $(`#${id}`);
  if (!input) return;
  input.addEventListener('change', () => apply(input.checked));
}

function trackField(type, current) {
  const options = (S.doc.tracks || []).filter((track) => track.type === type);
  return `<label class="field"><span>所在轨道</span>
    <select id="ipTrack">${options.map((track) => `<option value="${track.id}"${track.id === current ? ' selected' : ''}>${escapeHtml(track.name)}</option>`).join('')}</select>
  </label>`;
}

function selectedHead(kind, item) {
  const title = escapeHtml(titleFor(kind, item));
  const meta = kind === 'main' ? `主轨片段 · ${fmtTime(clipDuration(item))}`
    : kind === 'overlay' ? `叠加${item.kind === 'image' ? '图片' : '视频'} · ${fmtTime(item.duration)}`
    : kind === 'audio' ? `音轨 · ${fmtTime(item.duration)}`
    : `字幕 · ${fmtTime(item.duration)}`;
  const badge = kind === 'main' ? 'film' : kind === 'overlay' ? 'layers' : kind === 'audio' ? 'music' : 'type';
  return `<div class="selected-head">
    <div class="badge">${icon(badge)}</div>
    <div class="info"><b>${title}</b><span>${meta}</span></div>
    <button class="icon-btn danger-link" id="ipDelete" type="button" title="删除">${icon('trash')}</button>
  </div>`;
}

const RESET_LABELS = {
  clip: '画面/速度', mosaic: '马赛克', overlay: '位置/缩放', crop: '裁剪/蒙版',
  blend: '混合模式', transition: '转场', effects: '特效', anim: '关键帧',
  audio: '音轨', text: '字幕样式', grade: '调色',
};

function resetBtn(scope, extra = '') {
  return `<button class="sec-reset${extra}" type="button" data-reset="${scope}" title="恢复${RESET_LABELS[scope] || ''}默认值">${icon('rotate-left')}</button>`;
}

function applyReset(kind, item, scope) {
  if (scope === 'clip' && kind === 'main') {
    Object.assign(item, { speed: 1, volume: 1, scale: 1, rotate: 0, flipH: false, flipV: false,
      fit: 'contain', fadeIn: 0, fadeOut: 0, opacity: 1 });
  } else if (scope === 'clip' && kind === 'overlay') {
    Object.assign(item, { x: 0.5, y: 0.5, scale: 1, rotate: 0, opacity: 1, in: 0 });
  } else if (scope === 'mosaic') {
    Object.assign(item, { mosaic: false, mosaicMode: 'pixel', mosaicBlock: 16,
      mosaicX: 0.25, mosaicY: 0.25, mosaicW: 0.5, mosaicH: 0.5 });
  } else if (scope === 'crop') {
    item.crop = { left: 0, right: 0, top: 0, bottom: 0 };
    item.mask = { enabled: false, shape: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5, feather: 0, invert: false };
  } else if (scope === 'blend') {
    item.blend = 'normal';
  } else if (scope === 'transition') {
    item.transition = null;
  } else if (scope === 'effects') {
    item.effects = [];
  } else if (scope === 'anim') {
    item.keyframes = {};
  } else if (scope === 'audio') {
    Object.assign(item, { volume: 1, pan: 0, speed: 1, fadeIn: 0, fadeOut: 0, muted: false, loop: false });
  } else if (scope === 'text') {
    Object.assign(item, { x: 0.5, y: 0.8, size: 64, color: '#ffffff', bold: true, italic: false,
      outline: 3, shadow: 0, bgEnabled: false, bgAlpha: 0.55, bg: '', opacity: 1 });
  }
}

function commonDeleteButtons() {
  return `<div class="btn-row">
    <button class="mini-btn" id="ipDuplicate" type="button">${icon('copy')}复制</button>
    <button class="mini-btn danger-link" id="ipDelete2" type="button">${icon('trash')}删除</button>
  </div>`;
}

function renderMain(item) {
  const offsets = mainOffsets();
  const entry = offsets.find((row) => row.clip.id === item.id);
  const mainIndex = offsets.findIndex((row) => row.clip.id === item.id);
  const speed = Number(item.speed) || 1;
  const canvas = S.doc.canvas;
  return `${selectedHead('main', item)}
  ${quickNav('main')}
  <div class="inspector-section" id="secClip">
    <div class="inspector-title">${icon('film')}片段 / 速度 / 画面缩放${resetBtn('clip')}</div>
    <div class="prop-note">${escapeHtml(item.src)}<br>入点 ${item.in.toFixed(2)}s · 出点 ${item.out.toFixed(2)}s · 时长 ${fmtTime(clipDuration(item))}</div>
    <div class="btn-row" style="margin-bottom:10px">
      <button class="mini-btn" id="ipSetIn" type="button">播放头设为入点</button>
      <button class="mini-btn" id="ipSetOut" type="button">播放头设为出点</button>
    </div>
    ${rangeField('速度', 'ipSpeed', 25, 400, 5, Math.round(speed * 100))}
    ${rangeField('音量', 'ipVolume', 0, 200, 1, Math.round(Number(item.volume || 0) * 100))}
    ${rangeField('缩放', 'ipScale', 5, 200, 1, Math.round(Number(item.scale || 1) * 100))}
    <div class="field"><span>画面方向</span>
      <div class="seg" style="margin-bottom:5px">
        <button type="button" data-rot="-90">${icon('rotate-left')} 左转</button>
        <button type="button" data-rot="90">${icon('rotate-right')} 右转</button>
        <button type="button" data-rot="180">180°</button>
      </div>
      <div class="btn-row">
        <button class="mini-btn" id="ipFlipH" type="button">${icon('flip-h')}水平翻转</button>
        <button class="mini-btn" id="ipFlipV" type="button">${icon('flip-v')}垂直翻转</button>
      </div>
      <em>当前旋转 ${item.rotate}° · ${item.flipH ? '水平翻转 ' : ''}${item.flipV ? '垂直翻转' : ''}</em>
    </div>
    <div class="field"><span>填充方式</span>
      <div class="seg">
        <button type="button" data-fit="contain" class="${item.fit === 'contain' ? 'active' : ''}">完整显示</button>
        <button type="button" data-fit="cover" class="${item.fit === 'cover' ? 'active' : ''}">铺满裁切</button>
      </div>
    </div>
    <div class="field-row">
      ${numberField('淡入', 'ipFadeIn', Number(item.fadeIn || 0), 0, 10, 0.1, '秒')}
      ${numberField('淡出', 'ipFadeOut', Number(item.fadeOut || 0), 0, 10, 0.1, '秒')}
    </div>
  </div>
  <div class="inspector-section">
    <div class="inspector-title">${icon('layers')}马赛克${resetBtn('mosaic')}</div>
    <label class="check-line" style="margin-bottom:9px">
      <input type="checkbox" id="ipMosaic" ${item.mosaic ? 'checked' : ''}>
      <span><b>启用马赛克 / 遮挡</b><em>在画面上打码；区域按画布比例设置，模糊方式边缘更自然。</em></span>
    </label>
    <label class="field"><span>处理方式</span>
      <select id="ipMosaicMode">
        <option value="pixel" ${(item.mosaicMode || 'pixel') === 'pixel' ? 'selected' : ''}>像素马赛克</option>
        <option value="blur" ${item.mosaicMode === 'blur' ? 'selected' : ''}>高斯模糊</option>
        <option value="black" ${item.mosaicMode === 'black' ? 'selected' : ''}>纯黑遮挡</option>
      </select>
    </label>
    ${rangeField('强度 / 块大小', 'ipMosaicBlock', 2, 64, 2, Number(item.mosaicBlock || 16))}
    ${rangeField('区域 X', 'ipMosaicX', 0, 100, 1, Math.round(Number(item.mosaicX ?? 0.25) * 100))}
    ${rangeField('区域 Y', 'ipMosaicY', 0, 100, 1, Math.round(Number(item.mosaicY ?? 0.25) * 100))}
    ${rangeField('区域宽度', 'ipMosaicW', 2, 100, 1, Math.round(Number(item.mosaicW ?? 0.5) * 100))}
    ${rangeField('区域高度', 'ipMosaicH', 2, 100, 1, Math.round(Number(item.mosaicH ?? 0.5) * 100))}
  </div>
  <div class="inspector-section" id="secAudio">
    <div class="inspector-title">${icon('music')}原声 / 音轨</div>
    ${item.audioDetached
      ? '<div class="prop-note">音轨已分离到「音轨」轨，可在时间线上独立裁剪、移动、调音量或变速。主轨画面将保持静音。</div>'
      : (() => {
          const meta = S.metaCache.get(item.src);
          const hasAudio = item.hasAudio !== false && (!meta || meta.hasAudio !== false);
          return hasAudio
            ? `<div class="prop-note">音轨目前跟随主轨画面。需要单独裁剪、移位或做音频处理时，点下面的按钮把原声提取为独立音轨。</div>
               <button class="mini-btn" id="ipDetachAudio" type="button" style="width:100%;height:30px">${icon('music')}分离 / 提取音轨</button>`
            : '<div class="prop-note">该视频没有音轨，无法分离。</div>';
        })()}
  </div>
  <div class="inspector-section">
    <div class="inspector-title">${icon('layers')}排列</div>
    <div class="btn-row">
      <button class="mini-btn" id="ipMoveUp" type="button">${icon('chevron-up')}上移</button>
      <button class="mini-btn" id="ipMoveDown" type="button">${icon('chevron-down')}下移</button>
      <button class="mini-btn" id="ipSplit" type="button">${icon('split')}分割</button>
    </div>
    <div class="prop-note" style="margin-top:10px">画布 ${canvas.width}×${canvas.height}。缩放 100% 表示按画布完整显示；超过 100% 会放大并裁切画面。</div>
  </div>
  ${renderCropMask('main', item)}
  ${renderTransition(item, mainIndex)}
  ${renderEffects('main', item)}
  ${renderAnimation('main', item)}
  ${commonDeleteButtons()}`;
}

function renderOverlay(item) {
  return `${selectedHead('overlay', item)}
  ${quickNav('overlay')}
  <div class="inspector-section" id="secClip">
    <div class="inspector-title">${icon('layers')}叠加设置 / 位置 / 缩放${resetBtn('clip')}</div>
    <div class="prop-note">${escapeHtml(item.src)}</div>
    ${trackField('video', item.trackId)}
    <div class="field-row">
      ${numberField('开始', 'ipStart', item.start, 0, 86400, 0.1, '秒')}
      ${numberField('时长', 'ipDur', item.duration, 0.1, 86400, 0.1, '秒')}
    </div>
    ${rangeField('水平位置', 'ipX', 0, 100, 1, Math.round(item.x * 100))}
    ${rangeField('垂直位置', 'ipY', 0, 100, 1, Math.round(item.y * 100))}
    ${rangeField('缩放', 'ipScale', 1, 200, 1, Math.round(item.scale * 100))}
    ${rangeField('旋转', 'ipRotate', -180, 180, 1, Math.round(item.rotate))}
    ${rangeField('不透明度', 'ipOpacity', 0, 100, 1, Math.round(item.opacity * 100))}
    ${item.kind === 'video' ? numberField('素材入点', 'ipIn', item.in, 0, 86400, 0.1, '秒') : ''}
  </div>
  ${renderBlend(item)}
  ${renderEffects('overlay', item)}
  ${renderAnimation('overlay', item)}
  ${renderCropMask('overlay', item)}
  ${commonDeleteButtons()}`;
}

function renderAudio(item) {
  return `${selectedHead('audio', item)}
  ${quickNav('audio')}
  <div class="inspector-section" id="secAudio">
    <div class="inspector-title">${icon('music')}音轨设置 / 音量 / 变速${resetBtn('audio')}</div>
    <div class="prop-note">${escapeHtml(item.src)}</div>
    ${trackField('audio', item.trackId)}
    <div class="field-row">
      ${numberField('开始', 'ipStart', item.start, 0, 86400, 0.1, '秒')}
      ${numberField('时长', 'ipDur', item.duration, 0.1, 86400, 0.1, '秒')}
    </div>
    ${rangeField('音量', 'ipVolume', 0, 200, 1, Math.round(item.volume * 100))}
    ${rangeField('速度', 'ipSpeed', 25, 400, 5, Math.round((Number(item.speed) || 1) * 100))}
    <div class="field-row">
      ${numberField('淡入', 'ipFadeIn', Number(item.fadeIn || 0), 0, 20, 0.1, '秒')}
      ${numberField('淡出', 'ipFadeOut', Number(item.fadeOut || 0), 0, 20, 0.1, '秒')}
    </div>
    ${numberField('素材入点', 'ipIn', item.in, 0, 86400, 0.1, '秒')}
    <label class="check-line" style="margin-top:6px">
      <input type="checkbox" id="ipMuted" ${item.muted ? 'checked' : ''}>
      <span><b>静音</b><em>保留片段但不出声，也可按 M 快速切换。</em></span>
    </label>
    <label class="check-line" style="margin-top:6px">
      <input type="checkbox" id="ipLoop" ${item.loop ? 'checked' : ''}>
      <span><b>循环播放</b><em>素材比时间线短时，循环填充到设定时长。</em></span>
    </label>
  </div>
  ${renderEffects('audio', item)}
  ${renderAnimation('audio', item)}
  ${commonDeleteButtons()}`;
}

function renderText(item) {
  return `${selectedHead('text', item)}
  ${quickNav('text')}
  <div class="inspector-section" id="secText">
    <div class="inspector-title">${icon('type')}字幕内容${resetBtn('text')}</div>
    ${trackField('text', item.trackId)}
    <div class="field"><span>文字</span><textarea id="ipText" rows="3">${escapeHtml(item.text)}</textarea>
      <em>支持多行；在画布上的位置可拖动或用下面滑块调整。</em></div>
    ${numberField('字号', 'ipSize', item.size, 8, 400, 1, 'px')}
    <div class="field"><span>颜色</span><input type="color" id="ipColorPick" value="${item.color}" style="width:100%;height:32px;background:transparent;border:1px solid var(--line);border-radius:8px"></div>
    <label class="check-line" style="margin-bottom:10px">
      <input type="checkbox" id="ipBg" ${item.bgEnabled ? 'checked' : ''}>
      <span><b>半透明底框</b><em>在复杂画面上提高字幕可读性。</em></span>
    </label>
    ${item.bgEnabled ? `<div class="field-row">
      <label class="field"><span>底框颜色</span><input type="color" id="ipBgColor" value="${item.bg || '#000000'}" style="width:100%;height:32px;background:transparent;border:1px solid var(--line);border-radius:8px"></label>
      <label class="field"><span>底框不透明度</span><input type="number" id="ipBgAlpha" min="0" max="1" step="0.05" value="${Number(item.bgAlpha ?? 0.55)}"></label>
    </div>` : ''}
    <div class="field-row">
      <label class="field"><span>描边宽度</span><input type="number" id="ipOutline" min="0" max="20" step="1" value="${Number(item.outline ?? 3)}"></label>
      <label class="field"><span>阴影偏移</span><input type="number" id="ipShadow" min="0" max="20" step="1" value="${Number(item.shadow ?? 0)}"></label>
    </div>
    <label class="check-line" style="margin-top:6px">
      <input type="checkbox" id="ipItalic" ${item.italic ? 'checked' : ''}>
      <span><b>斜体</b></span>
    </label>
    ${rangeField('不透明度', 'ipTextOpacity', 0, 100, 1, Math.round(Number(item.opacity ?? 1) * 100))}
    <div class="field-row">
      ${numberField('开始', 'ipStart', item.start, 0, 86400, 0.1, '秒')}
      ${numberField('时长', 'ipDur', item.duration, 0.1, 86400, 0.1, '秒')}
    </div>
    ${rangeField('水平位置', 'ipX', 0, 100, 1, Math.round(item.x * 100))}
    ${rangeField('垂直位置', 'ipY', 0, 100, 1, Math.round(item.y * 100))}
  </div>
  ${renderAnimation('text', item)}
  ${commonDeleteButtons()}`;
}

const PRESETS = [
  ['1920x1080', '16:9 · 1080p'],
  ['2560x1440', '16:9 · 2K'],
  ['3840x2160', '16:9 · 4K'],
  ['1080x1920', '9:16 · 竖屏'],
  ['1080x1080', '1:1 · 方形'],
  ['1280x720', '16:9 · 720p'],
];

function renderProject() {
  const doc = S.doc;
  if (!doc) return '';
  const presetKey = `${doc.canvas.width}x${doc.canvas.height}`;
  const matching = PRESETS.some(([key]) => key === presetKey) ? presetKey : 'custom';
  const stats = {
    clips: doc.main.length,
    overlays: doc.overlays.length,
    audios: doc.audios.length,
    texts: doc.texts.length,
    duration: mainDuration(),
  };
  return `<div class="inspector-section">
    <div class="inspector-title">${icon('settings')}工程设置 <span class="right">${fmtTime(stats.duration)}</span></div>
    ${field('工程名称', `<input type="text" id="ppName" value="${escapeHtml(doc.name)}" maxlength="80" spellcheck="false">`)}
    <div class="field-row">
      <label class="field"><span>画布</span>
        <select id="ppCanvas">
          ${PRESETS.map(([key, label]) => `<option value="${key}" ${key === presetKey ? 'selected' : ''}>${label}</option>`).join('')}
          <option value="custom" ${matching === 'custom' ? 'selected' : ''}>自定义 ${presetKey}</option>
        </select>
      </label>
      <label class="field"><span>帧率</span>
        <select id="ppFps">
          ${[24, 25, 30, 50, 60].map((fps) => `<option value="${fps}" ${Number(doc.canvas.fps) === fps ? 'selected' : ''}>${fps} fps</option>`).join('')}
        </select>
      </label>
    </div>
    ${rangeField('总音量', 'ppMaster', 0, 200, 1, Math.round(Number(doc.masterVolume) * 100))}
  </div>
  <div class="inspector-section">
    <div class="inspector-title">${icon('palette')}画面调色${resetBtn('grade')}</div>
    ${rangeField('亮度', 'ppBrightness', -100, 100, 1, Math.round(Number(doc.grade.brightness) * 100))}
    ${rangeField('对比度', 'ppContrast', 0, 200, 1, Math.round(Number(doc.grade.contrast) * 100))}
    ${rangeField('饱和度', 'ppSaturation', 0, 200, 1, Math.round(Number(doc.grade.saturation) * 100))}
    ${rangeField('色相', 'ppHue', -180, 180, 1, Math.round(Number(doc.grade.hue || 0)))}
    ${rangeField('色温', 'ppTemperature', -100, 100, 1, Math.round(Number(doc.grade.temperature || 0) * 100))}
    ${rangeField('暗角', 'ppVignette', 0, 100, 1, Math.round(Number(doc.grade.vignette || 0) * 100))}
    <div class="prop-note">调色作用于主轨画面，叠加素材与字幕保持原色；滤镜模板会写入这里。</div>
  </div>
  <div class="inspector-section">
    <div class="inspector-title">${icon('list')}工程统计</div>
    <div class="export-summary" style="margin-bottom:10px">
      <div><span>片段</span><b>${stats.clips}</b></div>
      <div><span>叠加层</span><b>${stats.overlays}</b></div>
      <div><span>音轨</span><b>${stats.audios}</b></div>
      <div><span>字幕</span><b>${stats.texts}</b></div>
    </div>
    <div class="btn-row">
      <button class="mini-btn" id="ppExport" type="button">${icon('export')}导出影片</button>
      <button class="mini-btn" id="ppProjects" type="button">${icon('folder')}工程管理</button>
    </div>
  </div>
  <div class="inspector-empty" style="padding:12px 6px 0">
    ${icon('info')}<br>在时间线或素材库里选中片段后，这里会显示详细参数。
  </div>`;
}

function bindCommon() {
  $('#ipDelete')?.addEventListener('click', () => deleteSelected());
  $('#ipDelete2')?.addEventListener('click', () => deleteSelected());
  $('#ipDuplicate')?.addEventListener('click', () => duplicateSelected());
}

function bindMain(item) {
  bindRange('ipSpeed', (value) => {
    mutate(() => { item.speed = Math.round((value / 100) * 100) / 100; }, `insp-${item.id}-speed`, { source: 'inspector' });
  }, (value) => `×${(value / 100).toFixed(2)}`);
  bindRange('ipVolume', (value) => {
    mutate(() => { item.volume = value / 100; item.muted = value === 0; }, `insp-${item.id}-vol`, { source: 'inspector' });
  }, (value) => `${value}%`);
  bindRange('ipScale', (value) => {
    mutate(() => { item.scale = value / 100; }, `insp-${item.id}-scale`, { source: 'inspector' });
  }, (value) => `${value}%`);
  $('#ipFlipH')?.addEventListener('click', () => mutate(() => { item.flipH = !item.flipH; }, `insp-${item.id}-fliph`, { source: 'inspector' }));
  $('#ipFlipV')?.addEventListener('click', () => mutate(() => { item.flipV = !item.flipV; }, `insp-${item.id}-flipv`, { source: 'inspector' }));
  document.querySelectorAll('[data-rot]').forEach((button) => {
    button.addEventListener('click', () => {
      const delta = Number(button.dataset.rot);
      mutate(() => { item.rotate = ((Number(item.rotate) + delta) % 360 + 360) % 360; }, `insp-${item.id}-rotate`, { source: 'inspector' });
      renderInspector();
    });
  });
  document.querySelectorAll('[data-fit]').forEach((button) => {
    button.addEventListener('click', () => {
      mutate(() => { item.fit = button.dataset.fit; }, `insp-${item.id}-fit`, { source: 'inspector' });
      renderInspector();
    });
  });
  bindNumber('ipFadeIn', (value) => mutate(() => { item.fadeIn = value; }, `insp-${item.id}-fi`, { source: 'inspector' }));
  bindNumber('ipFadeOut', (value) => mutate(() => { item.fadeOut = value; }, `insp-${item.id}-fo`, { source: 'inspector' }));
  bindCheck('ipMosaic', (checked) => { mutate(() => { item.mosaic = checked; }, `insp-${item.id}-mosaic`, { source: 'inspector' }); });
  bindChange('ipMosaicMode', (value) => { mutate(() => { item.mosaicMode = value; }, `insp-${item.id}-mmode`, { source: 'inspector' }); });
  bindRange('ipMosaicBlock', (value) => mutate(() => { item.mosaicBlock = value; }, `insp-${item.id}-mblock`, { source: 'inspector' }), (value) => `${value}px`);
  bindRange('ipMosaicX', (value) => mutate(() => { item.mosaicX = value / 100; }, `insp-${item.id}-mx`, { source: 'inspector' }), (value) => `${value}%`);
  bindRange('ipMosaicY', (value) => mutate(() => { item.mosaicY = value / 100; }, `insp-${item.id}-my`, { source: 'inspector' }), (value) => `${value}%`);
  bindRange('ipMosaicW', (value) => mutate(() => { item.mosaicW = value / 100; }, `insp-${item.id}-mw`, { source: 'inspector' }), (value) => `${value}%`);
  bindRange('ipMosaicH', (value) => mutate(() => { item.mosaicH = value / 100; }, `insp-${item.id}-mh`, { source: 'inspector' }), (value) => `${value}%`);
  $('#ipDetachAudio')?.addEventListener('click', () => separateAudio());
  $('#ipSetIn')?.addEventListener('click', () => { trimToPlayhead('in'); renderInspector(); });
  $('#ipSetOut')?.addEventListener('click', () => { trimToPlayhead('out'); renderInspector(); });
  $('#ipMoveUp')?.addEventListener('click', () => moveMain(-1));
  $('#ipMoveDown')?.addEventListener('click', () => moveMain(1));
  $('#ipSplit')?.addEventListener('click', () => splitAtPlayhead());
  bindEffects('main', item);
  bindAnimation('main', item);
  bindTransition(item);
  bindCropMask(item);
}

function bindOverlay(item) {
  bindChange('ipTrack', (value) => mutate(() => { item.trackId = value; }, `insp-${item.id}-track`, { source: 'inspector' }));
  bindNumber('ipStart', (value) => mutate(() => { item.start = Math.max(0, value); }, `insp-${item.id}-start`, { source: 'inspector' }));
  bindNumber('ipDur', (value) => mutate(() => { item.duration = Math.max(0.1, value); }, `insp-${item.id}-dur`, { source: 'inspector' }));
  bindRange('ipX', (value) => mutate(() => { item.x = value / 100; }, `insp-${item.id}-x`, { source: 'inspector' }), (value) => `${value}%`);
  bindRange('ipY', (value) => mutate(() => { item.y = value / 100; }, `insp-${item.id}-y`, { source: 'inspector' }), (value) => `${value}%`);
  bindRange('ipScale', (value) => mutate(() => { item.scale = value / 100; }, `insp-${item.id}-scale`, { source: 'inspector' }), (value) => `${value}%`);
  bindRange('ipRotate', (value) => mutate(() => { item.rotate = value; }, `insp-${item.id}-rot`, { source: 'inspector' }), (value) => `${value}°`);
  bindRange('ipOpacity', (value) => mutate(() => { item.opacity = value / 100; }, `insp-${item.id}-op`, { source: 'inspector' }), (value) => `${value}%`);
  bindNumber('ipIn', (value) => mutate(() => { item.in = Math.max(0, value); }, `insp-${item.id}-in`, { source: 'inspector' }));
  bindEffects('overlay', item);
  bindAnimation('overlay', item);
  bindBlend(item);
  bindCropMask(item);
}

function bindAudio(item) {
  bindChange('ipTrack', (value) => mutate(() => { item.trackId = value; }, `insp-${item.id}-track`, { source: 'inspector' }));
  bindNumber('ipStart', (value) => mutate(() => { item.start = Math.max(0, value); }, `insp-${item.id}-start`, { source: 'inspector' }));
  bindNumber('ipDur', (value) => mutate(() => { item.duration = Math.max(0.1, value); }, `insp-${item.id}-dur`, { source: 'inspector' }));
  bindNumber('ipIn', (value) => mutate(() => { item.in = Math.max(0, value); }, `insp-${item.id}-in`, { source: 'inspector' }));
  bindRange('ipVolume', (value) => mutate(() => { item.volume = value / 100; }, `insp-${item.id}-vol`, { source: 'inspector' }), (value) => `${value}%`);
  bindRange('ipSpeed', (value) => mutate(() => { item.speed = Math.round((value / 100) * 100) / 100; }, `insp-${item.id}-speed`, { source: 'inspector' }), (value) => `×${(value / 100).toFixed(2)}`);
  bindNumber('ipFadeIn', (value) => mutate(() => { item.fadeIn = Math.max(0, value); }, `insp-${item.id}-fi`, { source: 'inspector' }));
  bindNumber('ipFadeOut', (value) => mutate(() => { item.fadeOut = Math.max(0, value); }, `insp-${item.id}-fo`, { source: 'inspector' }));
  bindCheck('ipMuted', (checked) => { mutate(() => { item.muted = checked; }, `insp-${item.id}-muted`, { source: 'inspector' }); });
  bindCheck('ipLoop', (checked) => { mutate(() => { item.loop = checked; }, `insp-${item.id}-loop`, { source: 'inspector' }); });
  bindEffects('audio', item);
  bindAnimation('audio', item);
}

function bindText(item) {
  bindChange('ipTrack', (value) => mutate(() => { item.trackId = value; }, `insp-${item.id}-track`, { source: 'inspector' }));
  const textarea = $('#ipText');
  textarea?.addEventListener('input', () => {
    mutate(() => { item.text = textarea.value; }, `insp-${item.id}-text`, { source: 'inspector' });
  });
  bindNumber('ipSize', (value) => mutate(() => { item.size = clamp(value, 8, 400); }, `insp-${item.id}-size`, { source: 'inspector' }));
  const color = $('#ipColorPick');
  color?.addEventListener('input', () => {
    mutate(() => { item.color = color.value; }, `insp-${item.id}-color`, { source: 'inspector' });
  });
  bindCheck('ipBg', (checked) => mutate(() => {
    item.bgEnabled = checked;
    item.bg = checked ? (item.bg || '#000000') : '';
  }, `insp-${item.id}-bg`, { source: 'inspector' }));
  const bgColor = $('#ipBgColor');
  bgColor?.addEventListener('input', () => mutate(() => { item.bg = bgColor.value; }, `insp-${item.id}-bgc`, { source: 'inspector' }));
  bindNumber('ipBgAlpha', (value) => mutate(() => { item.bgAlpha = clamp(value, 0, 1); }, `insp-${item.id}-bga`, { source: 'inspector' }));
  bindNumber('ipOutline', (value) => mutate(() => { item.outline = clamp(Math.round(value), 0, 20); }, `insp-${item.id}-outline`, { source: 'inspector' }));
  bindNumber('ipShadow', (value) => mutate(() => { item.shadow = clamp(Math.round(value), 0, 20); }, `insp-${item.id}-shadow`, { source: 'inspector' }));
  bindCheck('ipItalic', (checked) => mutate(() => { item.italic = checked; }, `insp-${item.id}-italic`, { source: 'inspector' }));
  bindRange('ipTextOpacity', (value) => mutate(() => { item.opacity = value / 100; }, `insp-${item.id}-top`, { source: 'inspector' }), (value) => `${value}%`);
  bindNumber('ipStart', (value) => mutate(() => { item.start = Math.max(0, value); }, `insp-${item.id}-start`, { source: 'inspector' }));
  bindNumber('ipDur', (value) => mutate(() => { item.duration = Math.max(0.1, value); }, `insp-${item.id}-dur`, { source: 'inspector' }));
  bindRange('ipX', (value) => mutate(() => { item.x = value / 100; }, `insp-${item.id}-x`, { source: 'inspector' }), (value) => `${value}%`);
  bindRange('ipY', (value) => mutate(() => { item.y = value / 100; }, `insp-${item.id}-y`, { source: 'inspector' }), (value) => `${value}%`);
  bindAnimation('text', item);
}

function bindProject(doc) {
  const name = $('#ppName');
  name?.addEventListener('input', () => {
    mutate(() => { doc.name = name.value || '未命名工程'; }, 'proj-name', { source: 'inspector' });
  });
  bindChange('ppCanvas', (value) => {
    if (value === 'custom') return;
    const [width, height] = value.split('x').map(Number);
    mutate(() => { doc.canvas.width = width; doc.canvas.height = height; }, 'proj-canvas', { source: 'inspector' });
    renderInspector();
  });
  bindChange('ppFps', (value) => {
    mutate(() => { doc.canvas.fps = Number(value); }, 'proj-fps', { source: 'inspector' });
    renderInspector();
  });
  bindRange('ppMaster', (value) => mutate(() => { doc.masterVolume = value / 100; }, 'proj-master', { source: 'inspector' }), (value) => `${value}%`);
  bindRange('ppBrightness', (value) => mutate(() => { doc.grade.brightness = value / 100; }, 'proj-bri', { source: 'inspector' }), (value) => `${value}`);
  bindRange('ppContrast', (value) => mutate(() => { doc.grade.contrast = value / 100; }, 'proj-con', { source: 'inspector' }), (value) => `${value}%`);
  bindRange('ppSaturation', (value) => mutate(() => { doc.grade.saturation = value / 100; }, 'proj-sat', { source: 'inspector' }), (value) => `${value}%`);
  bindRange('ppHue', (value) => mutate(() => { doc.grade.hue = value; }, 'proj-hue', { source: 'inspector' }), (value) => `${value}°`);
  bindRange('ppTemperature', (value) => mutate(() => { doc.grade.temperature = value / 100; }, 'proj-temp', { source: 'inspector' }), (value) => `${value}`);
  bindRange('ppVignette', (value) => mutate(() => { doc.grade.vignette = value / 100; }, 'proj-vig', { source: 'inspector' }), (value) => `${value}%`);
  $('#ppExport')?.addEventListener('click', () => emitExport());
  $('#ppProjects')?.addEventListener('click', () => emitProjects());
}

function emitExport() {
  window.dispatchEvent(new CustomEvent('cinecut:export'));
}

function emitProjects() {
  window.dispatchEvent(new CustomEvent('cinecut:projects'));
}

const MULTI_LABEL = { main: '主轨', overlay: '叠加', audio: '音轨', text: '字幕' };

function renderMulti(entries) {
  const counts = entries.reduce((acc, entry) => {
    acc[entry.kind] = (acc[entry.kind] || 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts).map(([kind, count]) => `${MULTI_LABEL[kind]} ${count}`).join(' · ');
  const rows = entries.slice(0, 10).map(({ kind, item }) => {
    const duration = kind === 'main' ? clipDuration(item) : Number(item.duration) || 0;
    return `<div class="multi-row">
      <span class="multi-kind ${kind}">${MULTI_LABEL[kind]}</span>
      <b>${escapeHtml(titleFor(kind, item))}</b>
      <em>${fmtTime(duration)}</em>
    </div>`;
  }).join('');
  const more = entries.length > 10 ? `<div class="multi-more">还有 ${entries.length - 10} 项…</div>` : '';
  return `<div class="selected-head multi">
    <div class="badge">${icon('layers')}</div>
    <div class="info"><b>已选 ${entries.length} 项</b><span>${summary}</span></div>
    <button class="icon-btn danger-link" id="multiDeleteTop" type="button" title="删除全部选中">${icon('trash')}</button>
  </div>
  <div class="inspector-section">
    <div class="inspector-title">${icon('list')}选择内容</div>
    <div class="multi-list">${rows}</div>${more}
  </div>
  <div class="inspector-section">
    <div class="inspector-title">${icon('settings')}批量操作</div>
    <div class="btn-row">
      <button class="mini-btn" id="multiMute" type="button">${icon('volume-x')}静音 / 取消静音</button>
      <button class="mini-btn" id="multiDup" type="button">${icon('copy')}复制一份</button>
      <button class="mini-btn danger-link" id="multiDelete" type="button">${icon('trash')}删除全部</button>
    </div>
    <div class="prop-note" style="margin-top:10px">在时间线上 Ctrl/Cmd 点击增减选择，Shift 点击选择范围；右键任意片段可打开批量菜单（复制、剪切、分割、换轨、应用滤镜/特效）。</div>
  </div>`;
}

function bindMulti() {
  $('#multiMute')?.addEventListener('click', () => toggleMuteSelected());
  $('#multiDup')?.addEventListener('click', () => duplicateSelected());
  $('#multiDelete')?.addEventListener('click', () => deleteSelected());
  $('#multiDeleteTop')?.addEventListener('click', () => deleteSelected());
}

export function renderInspector() {
  const pane = $('#inspectorContent');
  if (!pane) return;
  const entries = selectionItems();
  if (entries.length > 1) {
    pane.innerHTML = renderMulti(entries);
    bindMulti();
    return;
  }
  const selected = selectedItem();
  if (!selected) {
    pane.innerHTML = renderProject();
    bindProject(S.doc);
    return;
  }
  const { kind, item } = selected;
  let html = '';
  if (kind === 'main') { html = renderMain(item); }
  else if (kind === 'overlay') { html = renderOverlay(item); }
  else if (kind === 'audio') { html = renderAudio(item); }
  else { html = renderText(item); }
  pane.innerHTML = html;
  pane.querySelectorAll('[data-jump]').forEach((button) => {
    if (!document.getElementById(button.dataset.jump)) button.remove();
  });
  bindCommon();
  if (kind === 'main') bindMain(item);
  else if (kind === 'overlay') bindOverlay(item);
  else if (kind === 'audio') bindAudio(item);
  else bindText(item);
}

export function initInspector() {
  $('#inspectorContent').addEventListener('click', (event) => {
    const reset = event.target.closest('[data-reset]');
    if (reset) {
      const scope = reset.dataset.reset;
      event.preventDefault();
      event.stopPropagation();
      const selected = selectedItem();
      if (!selected) {
        if (scope !== 'grade') return;
        mutate(() => {
          S.doc.grade = { brightness: 0, contrast: 1, saturation: 1, hue: 0, temperature: 0, vignette: 0 };
          S.doc.masterVolume = 1;
        }, 'reset-grade', { source: 'inspector' });
        renderInspector();
        toast('画面调色已恢复默认');
        return;
      }
      mutate(() => applyReset(selected.kind, selected.item, scope), `reset-${scope}`, { source: 'inspector' });
      renderInspector();
      toast(`${RESET_LABELS[scope] || '选项'}已恢复默认`);
      return;
    }
    const jump = event.target.closest('[data-jump]');
    if (!jump) return;
    document.getElementById(jump.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  on('selection', () => renderInspector());
  on('project', () => renderInspector());
  on('doc', (detail) => { if (detail.source !== 'inspector') renderInspector(); });
  window.addEventListener('cinecut:inspector-refresh', () => renderInspector());
  renderInspector();
}
