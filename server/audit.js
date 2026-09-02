import fs from 'node:fs';

// Append-only audit trail for the chatbot's mutating tool calls (issue #15).
//
// Every entry is printed to stdout (so it lands in `docker logs`), and
// optionally also appended to a file when CHAT_AUDIT_LOG_FILE is set — so an
// operator can reconstruct exactly what the bot proposed, whether it was
// confirmed/blocked/cancelled, and what happened when it ran.
const AUDIT_LOG_FILE = process.env.CHAT_AUDIT_LOG_FILE || null;

const SECRET_KEY_RE = /pass|secret|token|key|credential|auth/i;

// Redact object values whose key name looks secret-ish. Best-effort only —
// this cannot inspect free-form strings like an exec `cmd`, so operators
// should still assume audit log contents are sensitive.
export function redactArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : v;
  }
  return out;
}

// Keep individual log lines bounded (e.g. exec output, compose stdout).
export function summarize(value, max = 2000) {
  let str;
  try {
    str = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    str = String(value);
  }
  if (str == null) return str;
  return str.length > max ? `${str.slice(0, max)}…[truncated ${str.length - max} chars]` : str;
}

/**
 * Write one structured audit entry. Never throws — a logging failure must
 * never break the chat flow or hide that a privileged action ran.
 */
export function auditLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try {
    console.log(`[chat-audit] ${line}`);
  } catch {
    // stdout write failed; nothing more we can do.
  }
  if (AUDIT_LOG_FILE) {
    try {
      fs.appendFileSync(AUDIT_LOG_FILE, `${line}\n`);
    } catch (e) {
      console.error('[chat-audit] failed to write CHAT_AUDIT_LOG_FILE:', e.message || e);
    }
  }
}
