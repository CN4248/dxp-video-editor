export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function icon(name, cls = 'icon') {
  return `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

export function fmtTime(seconds, decimals = 1) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const secText = secs.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
  if (hours > 0) return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secText}`;
  return `${String(minutes).padStart(2, '0')}:${secText}`;
}

export function fmtTimeShort(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  if (total >= 60) {
    const minutes = Math.floor(total / 60);
    const secs = Math.floor(total % 60);
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }
  return `${total.toFixed(1)}s`;
}

export function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${value} B`;
}

export function fmtDate(stamp) {
  if (!stamp) return '—';
  const date = new Date(stamp * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fmtAgo(stamp) {
  if (!stamp) return '—';
  const diff = Date.now() / 1000 - stamp;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return fmtDate(stamp);
}

export function debounce(fn, wait = 250) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function toast(message, type = 'info', timeout = 3600) {
  const box = $('#toasts');
  if (!box) return;
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  const iconName = type === 'ok' ? 'check' : type === 'err' ? 'alert' : 'info';
  item.innerHTML = `${icon(iconName)}<div>${escapeHtml(message)}</div>`;
  box.appendChild(item);
  setTimeout(() => {
    item.classList.add('out');
    setTimeout(() => item.remove(), 240);
  }, timeout);
}

export function openModal(selector) {
  const modal = typeof selector === 'string' ? $(selector) : selector;
  if (!modal) return;
  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
}

export function closeModal(selector) {
  const modal = typeof selector === 'string' ? $(selector) : selector;
  if (!modal) return;
  modal.classList.add('hidden');
  if (!$$('.modal-backdrop:not(.hidden)').length) document.body.classList.remove('modal-open');
}

export function closeAllModals() {
  $$('.modal-backdrop').forEach((modal) => modal.classList.add('hidden'));
  document.body.classList.remove('modal-open');
}

let confirmResolver = null;

export function confirmDialog(title, text, okLabel = '确认') {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = okLabel;
  openModal('#confirmModal');
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

export function settleConfirm(value) {
  closeModal('#confirmModal');
  if (confirmResolver) {
    confirmResolver(value);
    confirmResolver = null;
  }
}

export function bindModalBasics() {
  document.addEventListener('click', (event) => {
    const close = event.target.closest('.modal-close');
    if (close) {
      closeModal(close.closest('.modal-backdrop'));
      if (close.closest('#confirmModal')) settleConfirm(false);
    }
    const backdrop = event.target.classList && event.target.classList.contains('modal-backdrop') ? event.target : null;
    if (backdrop) {
      closeModal(backdrop);
      if (backdrop.id === 'confirmModal') settleConfirm(false);
    }
  });
  $('#confirmOk').addEventListener('click', () => settleConfirm(true));
  $('#confirmCancel').addEventListener('click', () => settleConfirm(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('#confirmModal').classList.contains('hidden')) {
        settleConfirm(false);
        return;
      }
      closeAllModals();
    }
  });
}

export function byteRateLabel(crf) {
  if (crf <= 19) return '高质量';
  if (crf <= 22) return '标准';
  return '小体积';
}

export function mediaUrl(src) {
  const value = String(src || '');
  if (value.startsWith('builtin/')) {
    const rest = value.slice('builtin/'.length).split('/').map(encodeURIComponent).join('/');
    return `/builtin/${rest}`;
  }
  return `/api/media?path=${encodeURIComponent(value)}`;
}
