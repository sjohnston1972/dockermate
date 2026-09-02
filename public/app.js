import { dialog, toast } from './dialog.js';
import { apiFetch } from './auth.js';

const grid = document.getElementById('grid');
const summary = document.getElementById('summary');
const search = document.getElementById('search');
const refreshBtn = document.getElementById('refresh-btn');
const checkUpdatesBtn = document.getElementById('check-updates-btn');
const viewCardsBtn = document.getElementById('view-cards-btn');
const viewListBtn = document.getElementById('view-list-btn');

let containers = [];
let updateStatus = {}; // name -> { status, localDigest, remoteDigest }
const upgradingNames = new Set();
let viewMode = localStorage.getItem('dockermate-view') === 'list' ? 'list' : 'cards';

async function loadContainers() {
  const res = await apiFetch('/api/containers');
  containers = await res.json();
  render();
}

function stateColor(state) {
  if (state === 'running') return 'bg-secondary text-secondary';
  if (state === 'exited' || state === 'dead') return 'bg-error text-error';
  return 'bg-tertiary text-tertiary';
}

function uptimeText(startedAt, state) {
  if (!startedAt || state !== 'running') return '—';
  const ms = Date.now() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function tile(c) {
  const filter = search.value.toLowerCase();
  if (filter && !`${c.name} ${c.image} ${c.composeProject || ''}`.toLowerCase().includes(filter)) return '';
  const upd = updateStatus[c.name];
  const updateAvailable = upd?.status === 'update_available';
  const upToDate = upd?.status === 'up_to_date';
  const sc = stateColor(c.state);
  const stateBg = sc.split(' ')[0] + '/10';
  const stateText = sc.split(' ')[1];

  const upgrading = upgradingNames.has(c.name);
  let updateBadge = '';
  if (upgrading) {
    updateBadge = `<span class="text-[10px] font-bold bg-primary/10 text-primary px-2 py-1 rounded-full uppercase tracking-tighter flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-primary dot-pulse"></span>Upgrading…</span>`;
  } else if (updateAvailable) {
    updateBadge = `<button data-upgrade="${c.name}" class="text-[10px] font-bold bg-primary text-white px-2.5 py-1 rounded-full uppercase tracking-tighter flex items-center gap-1 hover:bg-primary-container transition-colors shadow-sm shadow-primary/30" title="docker compose pull + up -d ${c.composeService || c.name}"><span class="material-symbols-outlined text-[12px]">upgrade</span>Update</button>`;
  } else if (upToDate) {
    updateBadge = `<span class="text-[10px] font-bold bg-secondary/10 text-secondary px-2 py-1 rounded-full uppercase tracking-tighter">Latest</span>`;
  } else if (upd?.status === 'error') {
    // Transient registry failure (rate-limited/auth/unavailable) -- distinct
    // from "Local", which means there's no registry to check in the first
    // place. Visibly different styling (warning color) so it doesn't read
    // as "this image was built here".
    updateBadge = `<span class="text-[10px] font-bold bg-error/15 text-error px-2 py-1 rounded-full uppercase tracking-tighter" title="${upd.reason || 'registry error'}">Retry</span>`;
  } else if (upd?.status === 'unknown') {
    const isLocal = upd.reason === 'no remote digest';
    updateBadge = `<span class="text-[10px] font-bold bg-outline-variant/30 text-on-surface-variant px-2 py-1 rounded-full uppercase tracking-tighter" title="${upd.reason || ''}">${isLocal ? 'Local' : 'Unchecked'}</span>`;
  }

  return `
    <div class="container-card bg-surface-container-lowest rounded-xl shadow-[0px_24px_48px_rgba(33,37,41,0.04)] p-6 flex flex-col gap-4 ${updateAvailable && !upgrading ? 'tile-pulse' : ''}" data-name="${c.name}">
      <div class="card-header flex justify-between items-start">
        <div class="flex items-center gap-3 min-w-0">
          <span class="material-symbols-outlined text-primary bg-primary/10 p-2 rounded-lg">deployed_code</span>
          <div class="min-w-0">
            <p class="text-base font-bold text-on-surface truncate" title="${c.name}">${c.name}</p>
            <p class="text-[10px] text-outline uppercase font-bold tracking-widest truncate" title="${c.composeProject || 'standalone'}">${c.composeProject ? c.composeProject + '/' + c.composeService : 'standalone'}</p>
          </div>
        </div>
        <span class="card-badge">${updateBadge}</span>
      </div>

      <div class="card-version flex items-baseline gap-2">
        <span class="version-tag text-2xl font-extrabold text-on-surface -tracking-[0.02em] truncate" title="${c.tag || 'latest'}">${c.tag || 'latest'}</span>
        <span class="text-xs text-on-surface-variant truncate" title="${c.repo || ''}">${shortRepo(c.repo)}</span>
      </div>

      <div class="card-stats grid grid-cols-3 gap-2 text-center pt-2 border-t border-surface-container-low">
        <div>
          <p class="text-[10px] text-outline uppercase font-bold tracking-widest">State</p>
          <p class="text-sm font-bold ${stateText} flex items-center justify-center gap-1">
            <span class="w-1.5 h-1.5 rounded-full ${stateBg}"></span>
            ${c.state}
          </p>
        </div>
        <div>
          <p class="text-[10px] text-outline uppercase font-bold tracking-widest">Uptime</p>
          <p class="text-sm font-bold text-on-surface">${uptimeText(c.startedAt, c.state)}</p>
        </div>
        <div>
          <p class="text-[10px] text-outline uppercase font-bold tracking-widest">Restarts</p>
          <p class="text-sm font-bold text-on-surface">${c.restartCount}</p>
        </div>
      </div>

      ${c.ports.length ? `<div class="card-ports flex flex-wrap gap-1 pt-1"><span class="text-[10px] text-outline uppercase font-bold tracking-widest mr-1">Ports</span>${c.ports.map(p => `<span class="text-[10px] font-bold bg-outline-variant/20 text-on-surface-variant px-2 py-0.5 rounded">${p}</span>`).join('')}</div>` : ''}
      ${c.health ? `<div class="card-health text-[10px] text-outline uppercase font-bold tracking-widest">Health: <span class="text-on-surface">${c.health}</span></div>` : ''}
    </div>
  `;
}

function shortRepo(r) {
  if (!r) return '';
  if (r.length > 38) return '…' + r.slice(-36);
  return r;
}

function render() {
  const tiles = containers.map(tile).filter(Boolean).join('');
  grid.innerHTML = tiles || '<div class="col-span-full text-center text-on-surface-variant py-16">No containers match.</div>';
  const running = containers.filter(c => c.state === 'running').length;
  const updates = Object.values(updateStatus).filter(u => u.status === 'update_available').length;
  summary.textContent = `${containers.length} containers · ${running} running · ${updates} update${updates === 1 ? '' : 's'} available`;
}

function applyViewMode() {
  const isList = viewMode === 'list';
  grid.classList.toggle('is-list', isList);
  // Tailwind grid columns only apply in card mode; .is-list overrides via flex.
  viewCardsBtn.setAttribute('aria-pressed', String(!isList));
  viewListBtn.setAttribute('aria-pressed', String(isList));
}

function setViewMode(mode) {
  viewMode = mode === 'list' ? 'list' : 'cards';
  localStorage.setItem('dockermate-view', viewMode);
  applyViewMode();
}

async function checkUpdates() {
  checkUpdatesBtn.disabled = true;
  checkUpdatesBtn.classList.add('opacity-60');
  try {
    // One request for every container's update status, instead of looping
    // a per-container fetch (which used to re-list/re-inspect every
    // container on the host once per container checked).
    const res = await apiFetch('/api/containers/update-status');
    const json = await res.json();
    if (Array.isArray(json)) {
      for (const entry of json) {
        updateStatus[entry.name] = entry;
      }
    }
  } catch (e) {
    for (const c of containers) {
      updateStatus[c.name] = { status: 'unknown', reason: String(e) };
    }
  }
  render();
  checkUpdatesBtn.disabled = false;
  checkUpdatesBtn.classList.remove('opacity-60');
}

refreshBtn.addEventListener('click', loadContainers);
search.addEventListener('input', render);
checkUpdatesBtn.addEventListener('click', checkUpdates);
viewCardsBtn.addEventListener('click', () => setViewMode('cards'));
viewListBtn.addEventListener('click', () => setViewMode('list'));
applyViewMode();

grid.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-upgrade]');
  if (!btn) return;
  const name = btn.dataset.upgrade;
  if (upgradingNames.has(name)) return;

  const ok = await dialog.confirm({
    title: `Upgrade ${name}?`,
    message: `Pull the latest image and recreate "${name}". The container will briefly go offline while it's recreated.`,
    confirmLabel: 'Upgrade',
    cancelLabel: 'Cancel',
    variant: 'info',
  });
  if (!ok) return;

  upgradingNames.add(name);
  render();
  const progressToast = toast(`Pulling latest image…`, { title: name, variant: 'info', duration: 0 });

  try {
    // Kick off the job (returns immediately with a jobId).
    const startRes = await fetchJson(`/api/containers/${encodeURIComponent(name)}/upgrade`, { method: 'POST' });
    if (!startRes.ok) throw new Error(startRes.error || `kickoff failed (${startRes.status})`);
    const { jobId } = startRes.body;

    // Poll the job until it terminates. Up to ~30 minutes.
    const finalJob = await pollJob(jobId, {
      onStep: (step) => { progressToast.update?.(`${step}…`, name); },
      maxMs: 30 * 60 * 1000,
    });

    progressToast.dismiss();

    if (finalJob.state === 'done') {
      if (finalJob.result?.status) updateStatus[name] = { name, ...finalJob.result.status };
      toast(`${name} upgraded successfully`, { variant: 'success', title: 'Done' });
    } else {
      const last = finalJob.steps?.[finalJob.steps.length - 1];
      const detail = last
        ? `${last.step}\n\n${(last.stderr || last.stdout || finalJob.error || '(no output)').slice(-1500)}`
        : finalJob.error || 'failed';
      await dialog.custom({
        title: `Upgrade failed: ${name}`,
        message: 'The upgrade did not complete. Last step output:',
        body: `<pre class="dialog-detail">${escapeHtmlSafe(detail)}</pre>`,
        confirmLabel: 'Dismiss',
        showCancel: false,
        variant: 'error',
      });
    }
  } catch (err) {
    progressToast.dismiss();
    await dialog.alert({ title: `Upgrade error: ${name}`, message: err.message, variant: 'error' });
  } finally {
    upgradingNames.delete(name);
    await loadContainers();
  }
});

async function fetchJson(url, opts) {
  const res = await apiFetch(url, opts);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* fall through */ }
  if (!body) return { ok: false, status: res.status, error: text.slice(0, 200) || `HTTP ${res.status}` };
  return { ok: res.ok, status: res.status, body, error: body.error };
}

async function pollJob(jobId, { onStep, maxMs = 30 * 60 * 1000, intervalMs = 1500 } = {}) {
  const start = Date.now();
  let lastStep = null;
  while (Date.now() - start < maxMs) {
    const res = await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (res.ok && res.body) {
      const job = res.body;
      if (job.step && job.step !== lastStep) {
        lastStep = job.step;
        onStep?.(job.step);
      }
      if (job.state === 'done' || job.state === 'failed') return job;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('upgrade timed out (still running on the server)');
}

function escapeHtmlSafe(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

loadContainers().then(() => {
  // Kick off update check automatically once on first load.
  checkUpdates();
});

// ---- Chat ----
const fab = document.getElementById('chat-fab');
const panel = document.getElementById('chat-panel');
const closeBtn = document.getElementById('chat-close');
const log = document.getElementById('chat-log');
const form = document.getElementById('chat-form');
const input = document.getElementById('chat-input');

const history = []; // OpenAI-style messages, persisted in-memory only

function appendMsg(role, content) {
  const div = document.createElement('div');
  div.className = role === 'user' ? 'chat-msg-user' : role === 'assistant' ? 'chat-msg-assistant' : 'chat-msg-tool';
  div.textContent = content;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

fab.addEventListener('click', () => {
  panel.classList.remove('hidden');
  fab.classList.add('hidden');
  if (history.length === 0) {
    appendMsg('assistant', "Hey — I can list, inspect, restart, upgrade and exec into any container on this host. Try: 'what needs upgrading?' or 'upgrade librechat'.");
  }
  input.focus();
});
closeBtn.addEventListener('click', () => {
  panel.classList.add('hidden');
  fab.classList.remove('hidden');
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  appendMsg('user', text);
  history.push({ role: 'user', content: text });

  const thinking = document.createElement('div');
  thinking.className = 'chat-msg-tool';
  thinking.textContent = 'thinking…';
  log.appendChild(thinking);
  log.scrollTop = log.scrollHeight;

  try {
    const res = await apiFetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });
    const json = await res.json();
    thinking.remove();
    if (json.error) {
      appendMsg('assistant', `error: ${json.error}`);
      return;
    }
    appendMsg('assistant', json.reply || '(no reply)');
    history.push({ role: 'assistant', content: json.reply || '' });

    // Refresh container view in case the bot changed state.
    loadContainers();
  } catch (e) {
    thinking.remove();
    appendMsg('assistant', `error: ${e.message}`);
    toast(`Chat request failed: ${e.message}`, { variant: 'error', title: 'Network error' });
  }
});
