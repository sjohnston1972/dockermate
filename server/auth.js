// Express auth middleware for /api/* — defense-in-depth on top of Cloudflare
// Access. Enforces, per request, EITHER a verified Access JWT (Cf-Access-
// Jwt-Assertion, checked via server/access.js) OR a shared-secret bearer
// token (APP_SHARED_SECRET), whichever is configured.
//
// FAILS CLOSED: if neither is configured, every protected request is
// rejected (503) rather than allowed through. A missing env var must never
// silently disable auth.

import { timingSafeEqual } from 'node:crypto';
import { verifyAccessJwt, isAccessConfigured } from './access.js';

const SHARED_SECRET = process.env.APP_SHARED_SECRET || '';
const secretConfigured = SHARED_SECRET.length > 0;
const accessConfigured = isAccessConfigured();

if (!accessConfigured && !secretConfigured) {
  console.error('!'.repeat(70));
  console.error('dockermate: NO APP-LEVEL AUTH CONFIGURED.');
  console.error('Set ACCESS_TEAM_DOMAIN + ACCESS_AUD and/or APP_SHARED_SECRET (see .env.example).');
  console.error('Failing CLOSED: every /api/* request (except /api/health) will be rejected until this is fixed.');
  console.error('!'.repeat(70));
} else {
  const modes = [];
  if (accessConfigured) modes.push('Cloudflare Access JWT');
  if (secretConfigured) modes.push('shared secret');
  console.log(`dockermate: app-level auth enabled (${modes.join(' + ')})`);
}

function secretsEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function extractBearer(req) {
  const header = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (m) return m[1].trim();
  const alt = req.get('x-app-secret');
  return alt ? alt.trim() : '';
}

/**
 * Express middleware. Mount ahead of protected routes, e.g.
 *   app.use('/api', requireAuth)
 * after any routes (like /api/health) that must stay public.
 */
export async function requireAuth(req, res, next) {
  if (!accessConfigured && !secretConfigured) {
    console.error(`dockermate: rejecting ${req.method} ${req.originalUrl} — no app-level auth configured (fail closed)`);
    return res.status(503).json({ error: 'server misconfigured: no app-level auth configured' });
  }

  if (accessConfigured) {
    const token = req.get('Cf-Access-Jwt-Assertion');
    if (token) {
      const result = await verifyAccessJwt(token);
      if (result.ok) return next();
    }
  }

  if (secretConfigured) {
    const provided = extractBearer(req);
    if (provided && secretsEqual(provided, SHARED_SECRET)) return next();
  }

  return res.status(403).json({ error: 'forbidden' });
}
