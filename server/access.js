// Cloudflare Access JWT verifier.
//
// Cloudflare Access injects a signed `Cf-Access-Jwt-Assertion` header on every
// request that passed through it. This module verifies that assertion at the
// origin: signature against the team's published JWKS, `aud` (Access
// application AUD tag), and expiry. There is no decode-without-verify path —
// `verifyAccessJwt` always cryptographically verifies before returning ok.
//
// Config (env, no defaults):
//   ACCESS_TEAM_DOMAIN  e.g. "myteam.cloudflareaccess.com"
//   ACCESS_AUD          the Access application's AUD tag
//
// Both must be set for JWT verification to be considered "configured" —
// see isAccessConfigured().

import { createRemoteJWKSet, jwtVerify } from 'jose';

const TEAM_DOMAIN = process.env.ACCESS_TEAM_DOMAIN || '';
const AUD = process.env.ACCESS_AUD || '';

// Lazily created, memoized JWKS fetcher. `jose`'s createRemoteJWKSet caches
// the key set in memory and only refetches when a `kid` isn't found locally
// (subject to cooldownDuration), so we fetch at most once per TTL rather than
// per verification call.
let jwks = null;
function getJwks() {
  if (!TEAM_DOMAIN) return null;
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`), {
      cacheMaxAge: 10 * 60 * 1000, // 10 minutes
      cooldownDuration: 30 * 1000, // don't hammer the certs endpoint on repeated unknown kids
    });
  }
  return jwks;
}

/** True when both required env vars are present. */
export function isAccessConfigured() {
  return Boolean(TEAM_DOMAIN && AUD);
}

/**
 * Verify a Cloudflare Access JWT assertion.
 *
 * @param {string} token - the raw `Cf-Access-Jwt-Assertion` header value.
 * @returns {Promise<{ok: true, claims: object} | {ok: false, reason: string}>}
 */
export async function verifyAccessJwt(token) {
  if (!isAccessConfigured()) {
    return { ok: false, reason: 'access verification not configured' };
  }
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'missing token' };
  }

  try {
    const keySet = getJwks();
    const { payload } = await jwtVerify(token, keySet, {
      audience: AUD,
    });
    return { ok: true, claims: payload };
  } catch (err) {
    return { ok: false, reason: err?.code || err?.message || 'verification failed' };
  }
}
