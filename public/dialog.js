// Kopis-styled modal dialog + toast system. Promise-based API:
//   await dialog.confirm({ title, message, confirmLabel, danger })  -> boolean
//   await dialog.alert({ title, message, variant: 'error'|'info' }) -> void
//   toast(message, { variant: 'success'|'error'|'info', duration })

const VARIANTS = {
  info:    { icon: 'info',          color: 'text-primary',   bg: 'bg-primary/10' },
  success: { icon: 'check_circle',  color: 'text-secondary', bg: 'bg-secondary/10' },
  error:   { icon: 'error',         color: 'text-error',     bg: 'bg-error/10' },
  warn:    { icon: 'warning',       color: 'text-tertiary',  bg: 'bg-tertiary/10' },
};

function ensureRoot() {
  let root = document.getElementById('dialog-root');
  if (root) return root;
  root = document.createElement('div');
  root.id = 'dialog-root';
  document.body.appendChild(root);
  const toastRoot = document.createElement('div');
  toastRoot.id = 'toast-root';
  toastRoot.className = 'fixed top-20 right-6 z-[60] flex flex-col gap-2 pointer-events-none';
  document.body.appendChild(toastRoot);
  return root;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showModal({ title, message, body, variant = 'info', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, showCancel = true }) {
  return new Promise((resolve) => {
    const root = ensureRoot();
    const v = VARIANTS[variant] || VARIANTS.info;
    const wrap = document.createElement('div');
    wrap.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 dialog-backdrop';
    wrap.innerHTML = `
      <div class="dialog-card bg-surface-container-lowest rounded-xl shadow-[0px_24px_60px_rgba(33,37,41,0.25)] w-full max-w-md overflow-hidden">
        <div class="p-6 flex gap-4">
          <div class="${v.bg} ${v.color} w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0">
            <span class="material-symbols-outlined">${v.icon}</span>
          </div>
          <div class="flex-1 min-w-0">
            <h3 class="text-base font-bold text-on-surface mb-1">${escapeHtml(title)}</h3>
            ${message ? `<p class="text-sm text-on-surface-variant whitespace-pre-wrap break-words">${escapeHtml(message)}</p>` : ''}
            ${body || ''}
          </div>
        </div>
        <div class="px-6 py-4 bg-surface-container-low/40 flex justify-end gap-2 border-t border-outline-variant/10">
          ${showCancel ? `<button data-act="cancel" class="px-4 py-2 rounded-lg text-sm font-bold text-on-surface-variant hover:bg-surface-container-high transition-colors">${escapeHtml(cancelLabel)}</button>` : ''}
          <button data-act="confirm" class="px-4 py-2 rounded-lg text-sm font-bold text-white shadow-md transition-all ${danger ? 'bg-error hover:opacity-90 shadow-error/20' : 'bg-gradient-to-br from-primary to-primary-container hover:opacity-95 shadow-primary/30'}">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `;

    const close = (result) => {
      wrap.classList.add('dialog-closing');
      setTimeout(() => wrap.remove(), 140);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter') close(true);
    };

    wrap.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'confirm') close(true);
      else if (act === 'cancel') close(false);
      else if (e.target === wrap) close(false); // backdrop click
    });
    document.addEventListener('keydown', onKey);
    root.appendChild(wrap);
    // Focus the confirm button for keyboard users.
    setTimeout(() => wrap.querySelector('[data-act="confirm"]')?.focus(), 0);
  });
}

export const dialog = {
  confirm({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, variant = 'info' } = {}) {
    return showModal({ title, message, confirmLabel, cancelLabel, danger, variant, showCancel: true });
  },
  async alert({ title, message, variant = 'info', confirmLabel = 'OK' } = {}) {
    await showModal({ title, message, variant, confirmLabel, showCancel: false });
  },
  // Custom modal with arbitrary body HTML — used for upgrade error details, etc.
  custom(opts) {
    return showModal(opts);
  },
};

let toastSeq = 0;
export function toast(message, { variant = 'info', duration = 3500, title } = {}) {
  ensureRoot();
  const root = document.getElementById('toast-root');
  const v = VARIANTS[variant] || VARIANTS.info;
  const id = `toast-${++toastSeq}`;
  const el = document.createElement('div');
  el.id = id;
  el.className = 'toast-item pointer-events-auto bg-surface-container-lowest rounded-xl shadow-[0px_18px_36px_rgba(33,37,41,0.18)] border border-outline-variant/10 min-w-[280px] max-w-[420px]';
  el.innerHTML = `
    <div class="px-4 py-3 flex items-start gap-3">
      <div class="${v.bg} ${v.color} w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0">
        <span class="material-symbols-outlined text-[18px]">${v.icon}</span>
      </div>
      <div class="flex-1 min-w-0 text-sm">
        ${title ? `<p class="font-bold text-on-surface leading-tight">${escapeHtml(title)}</p>` : ''}
        <p class="text-on-surface-variant whitespace-pre-wrap break-words">${escapeHtml(message)}</p>
      </div>
      <button data-close class="p-1 -m-1 text-outline hover:text-on-surface rounded-full">
        <span class="material-symbols-outlined text-[16px]">close</span>
      </button>
    </div>
  `;
  el.querySelector('[data-close]').addEventListener('click', () => dismiss());
  const dismiss = () => {
    el.classList.add('toast-closing');
    setTimeout(() => el.remove(), 180);
  };
  const update = (newMessage, newTitle) => {
    const titleEl = el.querySelector('p.font-bold');
    const msgEl = el.querySelectorAll('p')[titleEl ? 1 : 0];
    if (msgEl) msgEl.textContent = newMessage;
    if (titleEl && newTitle != null) titleEl.textContent = newTitle;
  };
  root.appendChild(el);
  if (duration > 0) setTimeout(dismiss, duration);
  return { dismiss, update };
}
