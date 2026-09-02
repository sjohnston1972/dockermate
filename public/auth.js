// Frontend request layer for dockermate's /api/* auth.
//
// - Cloudflare Access mode needs nothing from us: Access injects the
//   Cf-Access-Jwt-Assertion header at the edge, before the request ever
//   reaches this page's fetch() call.
// - Shared-secret mode (APP_SHARED_SECRET on the server, used for the
//   standalone/port-mapped deployment that isn't behind Access) needs the
//   browser to send `Authorization: Bearer <secret>`. apiFetch() attaches a
//   secret from localStorage if one is stored, and — only when the server
//   actually rejects a request with 403 — prompts once for it and retries.
//
// Use apiFetch() instead of fetch() for every call to /api/*.

const STORAGE_KEY = 'dockermate:auth-secret';

function getStoredSecret() {
  try {
    return localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function setStoredSecret(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable (private mode, etc.) — secret just won't persist.
  }
}

// Share one in-flight prompt across concurrent callers so a page that fires
// several requests at once (e.g. the update-check loop) doesn't pop up a
// prompt per request.
let pendingPrompt = null;

function promptForSecret() {
  if (pendingPrompt) return pendingPrompt;
  pendingPrompt = Promise.resolve().then(() => {
    const entered = window.prompt(
      'dockermate needs its shared API secret (APP_SHARED_SECRET on the server) to continue.\n' +
      'It is stored only in this browser.'
    );
    return entered ? entered.trim() : '';
  }).finally(() => {
    pendingPrompt = null;
  });
  return pendingPrompt;
}

async function doFetch(url, opts, secret) {
  const headers = new Headers(opts.headers || {});
  if (secret) headers.set('Authorization', `Bearer ${secret}`);
  return fetch(url, { ...opts, headers });
}

/**
 * fetch() wrapper for /api/* calls. Attaches the stored shared secret (if
 * any); on a 403 it prompts once for the secret, stores it, and retries.
 * Safe to call for requests to a server that doesn't require a secret at
 * all (e.g. Access-only mode) — the header is simply ignored server-side.
 */
export async function apiFetch(url, opts = {}) {
  const stored = getStoredSecret();
  let res = await doFetch(url, opts, stored);

  if (res.status === 403) {
    const entered = await promptForSecret();
    if (entered && entered !== stored) {
      const retried = await doFetch(url, opts, entered);
      if (retried.status !== 403) {
        setStoredSecret(entered);
      }
      return retried;
    }
  }

  return res;
}
