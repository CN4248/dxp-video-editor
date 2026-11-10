// 特效栈 / 关键帧 / 转场 / 裁剪蒙版 —— 属性面板的可复用区块
import { S, mainOffsets, mutate } from './store.js';
import { clamp, escapeHtml, fmtTime, icon, toast } from './ui.js';

const KIND_LABEL = { main: '片段', overlay: '叠加', audio: '音频', text: '字幕' };
const ANIM_KEYS = {
  main: [['scale', '缩放', 0.05, 2, 0.01], ['rotate', '旋转', -180, 180, 1], ['opacity', '不透明度', 0, 1, 0.01], ['volume', '音量', 0, 2, 0.01]],
  overlay: [['x', '水平位置', 0, 1, 0.01], ['y', '垂直位置', 0, 1, 0.01], ['scale', '缩放', 0.05, 2, 0.01], ['rotate', '旋转', -180, 180, 1], ['opacity', '不透明度', 0, 1, 0.01]],
  audio: [['volume', '音量', 0, 2, 0.01], ['pan', '声像', -1, 1, 0.01]],
  text: [['x', '水平位置', 0, 1, 0.01], ['y', '垂直位置', 0, 1, 0.01], ['size', '字号', 8, 400, 1], ['opacity', '不透明度', 0, 1, 0.01]],
};

export function catalog() {
  return Array.isArray(S.config?.effects) ? S.config.effects : [];
}

export function effectDef(id) {
  return catalog().find((effect) => effect.id === id) || null;
}

export function itemStart(kind, item) {
  if (kind === 'main') {
    const entry = mainOffsets().find((row) => row.clip.id === item.id);
    return entry ? entry.start : 0;
  }
  return Number(item.start) || 0;
}

export function localTime(kind, item) {
  const duration = kind === 'main'
    ? Math.max(0.01, (Number(item.out) - Number(item.in)) / (Number(item.speed) || 1))
    : Math.max(0.01, Number(item.duration) || 0.01);
  return clamp((Number(S.playhead) || 0) - itemStart(kind, item), 0, duration);
}

function easeOptions(current) {
  const labels = { linear: '线性', hold: '保持', easeIn: '缓入', easeOut: '缓出', easeInOut: '缓入缓出' };
  return Object.entries(labels).map(([key, label]) => `<option value="${key}"${key === current ? ' selected' : ''}>${label}</option>`).join('');
}

function resetBtn(scope, label) {
  return `<button class="sec-reset" type="button" data-reset="${scope}" title="恢复${label}默认值">${icon('rotate-left')}</button>`;
}

function paramControl(effectId, param, value) {
  if (Array.isArray(param.options) && param.options.length) {
    return `<select data-fx-param="${param.key}">${param.options.map((option) => `<option value="${escapeHtml(option)}"${String(option) === String(value) ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select>`;
  }
  const numeric = Number(value);
  return `<div class="fx-range">
    <input type="range" data-fx-param="${param.key}" min="${param.min}" max="${param.max}" step="${param.step}" value="${Number.isFinite(numeric) ? numeric : param.default}">
    <b data-fx-val="${param.key}">${Number.isFinite(numeric) ? numeric : param.default}${escapeHtml(param.unit || '')}</b>
  </div>`;
}

function renderEffectCard(effect) {
  const def = effectDef(effect.type);
  const params = def?.params || [];
  const kfCount = Object.values(effect.keyframes || {}).reduce((sum, points) => sum + (points?.length || 0), 0);
  return `<div class="fx-card${effect.enabled === false ? ' disabled' : ''}" data-fx-card="${effect.id}">
    <div class="fx-head">
      <label class="check-toggle"><input type="checkbox" data-fx-enabled ${effect.enabled !== false ? 'checked' : ''}><span>${escapeHtml(def?.label || effect.type)}</span></label>
      <span class="fx-kf">◆ ${kfCount}</span>
      <button class="icon-btn" type="button" data-fx-reset title="恢复默认参数">${icon('rotate-left')}</button>
      <button class="icon-btn danger-link" type="button" data-fx-remove title="移除特效">${icon('trash')}</button>
    </div>
    ${def?.description ? `<div class="fx-desc">${escapeHtml(def.description)}</div>` : ''}
    ${params.map((param) => {
      const value = effect.params?.[param.key] ?? param.default;
      return `<div class="fx-param" data-fx-key="${param.key}">
        <span>${escapeHtml(param.label)}</span>
        ${paramControl(effect.id, param, value)}
        <button class="kf-btn" type="button" data-kf="${param.key}" title="在播放头处打关键帧">◆</button>
      </div>`;
    }).join('')}
    <div class="fx-foot">
      <label><span>插值</span><select data-fx-ease>${easeOptions(effect.ease || 'linear')}</select></label>
      <button class="mini-btn" type="button" data-fx-clear>清除关键帧</button>
    </div>
  </div>`;
}

export function renderEffects(kind, item) {
  const defs = catalog().filter((def) => (kind === 'audio' ? def.kind === 'audio' : def.kind === 'video'));
  const effects = Array.isArray(item.effects) ? item.effects : [];
  return `<div class="inspector-section" id="fxSection">
    <div class="inspector-title">${icon('palette')}特效 <span class="right">${effects.length} 个</span>${resetBtn('effects', '全部特效')}</div>
    <div class="fx-list">${effects.map(renderEffectCard).join('') || '<div class="prop-note">还没有特效。视频特效在渲染时逐帧应用；音频特效走 afilter 链。</div>'}</div>
    <div class="fx-add">
      <select id="fxAddSelect">${defs.map((def) => `<option value="${def.id}">${escapeHtml(def.label)} · ${escapeHtml(def.description || '')}</option>`).join('')}</select>
      <button class="mini-btn" type="button" id="fxAddBtn">${icon('plus')}添加特效</button>
    </div>
  </div>`;
}

export function bindEffects(kind, item) {
  const section = document.querySelector('#fxSection');
  if (!section) return;
  const time = localTime(kind, item);
  section.querySelectorAll('[data-kf]').forEach((button) => {
    const card = button.closest('[data-fx-card]');
    const effect = item.effects?.find((fx) => fx.id === card?.dataset.fxCard);
    if (!effect || button.dataset.kf === undefined) return;
    const points = effect.keyframes?.[button.dataset.kf] || [];
    if (points.some((point) => Math.abs(Number(point.t) - time) < 0.03)) button.classList.add('active');
  });

  section.querySelector('#fxAddBtn')?.addEventListener('click', () => {
    const id = section.querySelector('#fxAddSelect')?.value;
    const def = effectDef(id);
    if (!def) return;
    mutate(() => {
      item.effects = item.effects || [];
      if (item.effects.length >= 24) { toast('单个片段最多 24 个特效', 'err'); return; }
      const params = {};
      for (const param of def.params) params[param.key] = param.default;
      item.effects.push({ id: `fx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, type: id, enabled: true, params, keyframes: {}, ease: 'linear' });
    }, 'fx-add', { source: 'inspector' });
    window.dispatchEvent(new CustomEvent('cinecut:inspector-refresh'));
  });

  section.querySelectorAll('[data-fx-card]').forEach((card) => {
    const effect = item.effects?.find((fx) => fx.id === card.dataset.fxCard);
    if (!effect) return;
    card.querySelector('[data-fx-enabled]')?.addEventListener('change', (event) => {
      mutate(() => { effect.enabled = event.target.checked; }, `fx-enable-${effect.id}`, { source: 'inspector' });
      card.classList.toggle('disabled', !event.target.checked);
    });
    card.querySelector('[data-fx-reset]')?.addEventListener('click', () => {
      const def = effectDef(effect.type);
      if (!def) return;
      mutate(() => {
        effect.params = {};
        for (const param of def.params) effect.params[param.key] = param.default;
        effect.keyframes = {};
      }, `fx-reset-${effect.id}`, { source: 'inspector' });
      window.dispatchEvent(new CustomEvent('cinecut:inspector-refresh'));
    });
    card.querySelector('[data-fx-remove]')?.addEventListener('click', () => {
      mutate(() => { item.effects = (item.effects || []).filter((fx) => fx.id !== effect.id); }, 'fx-remove', { source: 'inspector' });
      window.dispatchEvent(new CustomEvent('cinecut:inspector-refresh'));
    });
    card.querySelectorAll('[data-fx-param]').forEach((input) => {
      const key = input.dataset.fxParam;
      const commit = () => {
        const def = effectDef(effect.type);
        const param = def?.params.find((row) => row.key === key);
        let value = input.value;
        if (param && !(Array.isArray(param.options) && param.options.length)) value = Number(value);
        mutate(() => {
          effect.params = effect.params || {};
          effect.params[key] = value;
          const points = effect.keyframes?.[key];
          if (points?.length) {
            const point = points.find((row) => Math.abs(Number(row.t) - time) < 0.03);
            if (point) point.v = value;
          }
        }, `fx-param-${effect.id}-${key}`, { source: 'inspector' });
        const label = card.querySelector(`[data-fx-val="${key}"]`);
        if (label) label.textContent = `${value}${param?.unit || ''}`;
      };
      input.addEventListener('input', commit);
      input.addEventListener('change', commit);
    });
    card.querySelectorAll('[data-kf]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.kf;
        const def = effectDef(effect.type);
        const param = def?.params.find((row) => row.key === key);
        let value = effect.params?.[key] ?? param?.default ?? 0;
        if (param && (Array.isArray(param.options) && param.options.length)) value = String(value);
        mutate(() => {
          effect.keyframes = effect.keyframes || {};
          const points = effect.keyframes[key] || [];
          const index = points.findIndex((row) => Math.abs(Number(row.t) - time) < 0.03);
          if (index >= 0) points.splice(index, 1);
          else points.push({ t: Math.round(time * 1000) / 1000, v: value, ease: effect.ease || 'linear' });
          points.sort((a, b) => a.t - b.t);
          if (points.length) effect.keyframes[key] = points.slice(0, 96);
          else delete effect.keyframes[key];
        }, `fx-kf-${effect.id}-${key}`, { source: 'inspector' });
        window.dispatchEvent(new CustomEvent('cinecut:inspector-refresh'));
      });
    });
    card.querySelector('[data-fx-clear]')?.addEventListener('click', () => {
      mutate(() => { effect.keyframes = {}; }, `fx-kf-clear-${effect.id}`, { source: 'inspector' });
      window.dispatchEvent(new CustomEvent('cinecut:inspector-refresh'));
    });
    card.querySelector('[data-fx-ease]')?.addEventListener('change', (event) => {
      mutate(() => { effect.ease = event.target.value; }, `fx-ease-${effect.id}`, { source: 'inspector' });
    });
  });
}

export function renderAnimation(kind, item) {
  const keys = ANIM_KEYS[kind] || [];
  return `<div class="inspector-section" id="animSection">
    <div class="inspector-title">${icon('clock')}关键帧动画 <span class="right">播放头 ${fmtTime(localTime(kind, item))}</span>${resetBtn('anim', '关键帧')}</div>
    <div class="anim-list">${keys.map(([key, label, min, max, step]) => {
      const points = item.keyframes?.[key] || [];
      const at = points.some((point) => Math.abs(Number(point.t) - localTime(kind, item)) < 0.03);
      return `<div class="anim-row" data-anim="${key}">
        <span>${label}</span>
        <input type="number" data-anim-value min="${min}" max="${max}" step="${step}" value="${Number(item[key] ?? 0)}">
        <b class="anim-count">${points.length} 帧</b>
        <button class="kf-btn${at ? ' active' : ''}" type="button" data-anim-kf title="在播放头添加/删除关键帧">◆</button>
      </div>`;
    }).join('')}</div>
    <div class="prop-note">关键帧时间相对片段入点；每个参数独立插值，渲染时按关键帧自动切片。</div>
  </div>`;
}

export function bindAnimation(kind, item) {
  document.querySelectorAll('.anim-row').forEach((row) => {
    const key = row.dataset.anim;
    const input = row.querySelector('[data-anim-value]');
    input?.addEventListener('input', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      const time = localTime(kind, item);
      mutate(() => {
        item[key] = value;
        const points = item.keyframes?.[key] || [];
        const point = points.find((row) => Math.abs(Number(row.t) - time) < 0.03);
        if (point) point.v = value;
      }, `anim-${key}`, { source: 'inspector' });
    });
    row.querySelector('[data-anim-kf]')?.addEventListener('click', () => {
      const time = localTime(kind, item);
      const value = Number(item[key]) || 0;
      mutate(() => {
        item.keyframes = item.keyframes || {};
        const points = item.keyframes[key] || [];
        const index = points.findIndex((point) => Math.abs(Number(point.t) - time) < 0.03);
        if (index >= 0) points.splice(index, 1);
        else points.push({ t: Math.round(time * 1000) / 1000, v: value, ease: 'linear' });
        points.sort((a, b) => a.t - b.t);
        if (points.length) item.keyframes[key] = points.slice(0, 96);
        else delete item.keyframes[key];
      }, `anim-kf-${key}`, { source: 'inspector' });
      window.dispatchEvent(new CustomEvent('cinecut:inspector-refresh'));
    });
  });
}

export function renderTransition(item, index) {
  if (index <= 0) return '';
  const transition = item.transition || { type: 'fade', duration: 0 };
  const types = S.config?.transitions || { fade: '淡入淡出' };
  return `<div class="inspector-section" id="transSection">
    <div class="inspector-title">${icon('layers')}片段转场${resetBtn('transition', '转场')}</div>
    <label class="field"><span>转场类型</span>
      <select id="ipTrType">${Object.entries(types).map(([key, label]) => `<option value="${key}"${key === transition.type ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>
      <em>转场与上一段交叉淡化，主轨总时长会相应缩短。</em>
    </label>
    <div class="field-row">
      <label class="field"><span>时长（秒）</span><input type="number" id="ipTrDur" min="0" max="10" step="0.1" value="${transition.duration}"></label>
      <label class="field"><span>快速设置</span><div class="btn-row"><button class="mini-btn" type="button" id="ipTrNone">无转场</button><button class="mini-btn" type="button" id="ipTrFade">0.5s 淡化</button></div></label>
    </div>
  </div>`;
}

export function bindTransition(item) {
  const type = document.querySelector('#ipTrType');
  const duration = document.querySelector('#ipTrDur');
  const apply = () => mutate(() => {
    item.transition = { type: type?.value || 'fade', duration: clamp(Number(duration?.value) || 0, 0, 10) };
  }, 'transition', { source: 'inspector' });
  type?.addEventListener('change', apply);
  duration?.addEventListener('input', apply);
  document.querySelector('#ipTrNone')?.addEventListener('click', () => {
    mutate(() => { item.transition = { type: 'fade', duration: 0 }; }, 'transition-none', { source: 'inspector' });
    if (duration) duration.value = '0';
  });
  document.querySelector('#ipTrFade')?.addEventListener('click', () => {
    mutate(() => { item.transition = { type: 'fade', duration: 0.5 }; }, 'transition-fade', { source: 'inspector' });
    if (duration) duration.value = '0.5';
    if (type) type.value = 'fade';
  });
}

export function renderCropMask(kind, item) {
  const crop = item.crop || { left: 0, right: 0, top: 0, bottom: 0 };
  const mask = item.mask || { enabled: false, shape: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5, feather: 0, invert: false };
  return `<div class="inspector-section" id="cropSection">
    <div class="inspector-title">${icon('image')}画面裁剪 / 蒙版${resetBtn('crop', '裁剪/蒙版')}</div>
    ${['left', 'right', 'top', 'bottom'].map((side) => `<div class="fx-param"><span>裁剪 ${side}</span><div class="fx-range"><input type="range" data-crop="${side}" min="0" max="0.45" step="0.01" value="${Number(crop[side]) || 0}"><b data-crop-val="${side}">${Math.round((Number(crop[side]) || 0) * 100)}%</b></div></div>`).join('')}
    <label class="check-line" style="margin-top:8px">
      <input type="checkbox" id="ipMaskOn" ${mask.enabled ? 'checked' : ''}>
      <span><b>启用蒙版</b><em>矩形/椭圆蒙版以外的画面将被裁掉；羽化让边缘更柔和。</em></span>
    </label>
    <label class="field"><span>蒙版形状</span>
      <select id="ipMaskShape"><option value="rect"${mask.shape === 'rect' ? ' selected' : ''}>矩形</option><option value="ellipse"${mask.shape === 'ellipse' ? ' selected' : ''}>椭圆</option></select>
    </label>
    <div class="field-row">
      <label class="field"><span>蒙版 X</span><input type="number" id="ipMaskX" min="0" max="1" step="0.01" value="${mask.x}"></label>
      <label class="field"><span>蒙版 Y</span><input type="number" id="ipMaskY" min="0" max="1" step="0.01" value="${mask.y}"></label>
    </div>
    <div class="field-row">
      <label class="field"><span>蒙版宽</span><input type="number" id="ipMaskW" min="0.02" max="1" step="0.01" value="${mask.w}"></label>
      <label class="field"><span>蒙版高</span><input type="number" id="ipMaskH" min="0.02" max="1" step="0.01" value="${mask.h}"></label>
    </div>
    <div class="field-row">
      <label class="field"><span>羽化</span><input type="number" id="ipMaskFeather" min="0" max="0.5" step="0.01" value="${mask.feather}"></label>
      <label class="check-line" style="align-self:end"><input type="checkbox" id="ipMaskInvert" ${mask.invert ? 'checked' : ''}><span><b>反转蒙版</b></span></label>
    </div>
  </div>`;
}

export function bindCropMask(item) {
  document.querySelectorAll('[data-crop]').forEach((input) => {
    const side = input.dataset.crop;
    input.addEventListener('input', () => {
      const value = Number(input.value);
      const label = document.querySelector(`[data-crop-val="${side}"]`);
      if (label) label.textContent = `${Math.round(value * 100)}%`;
      mutate(() => {
        item.crop = item.crop || { left: 0, right: 0, top: 0, bottom: 0 };
        item.crop[side] = value;
      }, `crop-${side}`, { source: 'inspector' });
    });
  });
  const commitMask = () => {
    const num = (id) => Number(document.querySelector(id)?.value) || 0;
    mutate(() => {
      item.mask = {
        enabled: Boolean(document.querySelector('#ipMaskOn')?.checked),
        shape: document.querySelector('#ipMaskShape')?.value || 'rect',
        x: clamp(num('#ipMaskX'), 0, 1), y: clamp(num('#ipMaskY'), 0, 1),
        w: clamp(num('#ipMaskW'), 0.02, 1), h: clamp(num('#ipMaskH'), 0.02, 1),
        feather: clamp(num('#ipMaskFeather'), 0, 0.5),
        invert: Boolean(document.querySelector('#ipMaskInvert')?.checked),
      };
    }, 'mask', { source: 'inspector' });
  };
  ['#ipMaskOn', '#ipMaskShape', '#ipMaskX', '#ipMaskY', '#ipMaskW', '#ipMaskH', '#ipMaskFeather', '#ipMaskInvert'].forEach((id) => {
    document.querySelector(id)?.addEventListener('change', commitMask);
    document.querySelector(id)?.addEventListener('input', commitMask);
  });
}

export function renderBlend(item) {
  const modes = S.config?.blendModes || { normal: '正常' };
  return `<div class="inspector-section" id="blendSection">
    <div class="inspector-title">${icon('layers')}混合模式${resetBtn('blend', '混合模式')}</div>
    <label class="field"><span>叠加方式</span>
      <select id="ipBlend">${Object.entries(modes).map(([key, label]) => `<option value="${key}"${key === (item.blend || 'normal') ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>
      <em>满屏叠加时可做滤色、正片叠底、柔光等合成。</em>
    </label>
  </div>`;
}

export function bindBlend(item) {
  document.querySelector('#ipBlend')?.addEventListener('change', (event) => {
    mutate(() => { item.blend = event.target.value; }, 'blend', { source: 'inspector' });
  });
}
