// Compare a running container's image digest against the latest digest in the registry.
// Supports Docker Hub (library/* and user images) and GHCR. Falls back to "unknown" otherwise.

import { docker } from './docker.js';

const tokenCache = new Map(); // key: registry|repo -> { token, expires }

// A registry call that failed for a reason that says nothing about whether
// the image/tag exists -- rate-limiting, an auth hiccup, or the registry
// being briefly unavailable. Distinct from a plain "not found" (404), which
// legitimately means there's no such tag/manifest to compare against.
class RegistryError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'RegistryError';
    this.status = status;
    this.retryable = retryable;
  }
}

function isRetryableStatus(status) {
  return status === 429 || status === 401 || status === 403 || status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bounded retry with backoff, only for errors explicitly marked retryable
// (429 rate-limit, 401/403 auth hiccup, 5xx). A non-retryable failure (e.g.
// a plain network error, or a 404) is rethrown immediately.
async function withRetry(fn, { attempts = 3, baseDelayMs = 250 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!(e instanceof RegistryError) || !e.retryable || i === attempts - 1) throw e;
      await sleep(baseDelayMs * 2 ** i);
    }
  }
  throw lastErr;
}

function transientReason(e) {
  if (e.status === 429) return 'rate-limited';
  if (e.status === 401 || e.status === 403) return 'auth-error';
  if (e.status >= 500) return 'registry-unavailable';
  return 'registry-error';
}

export async function checkImageUpdate({ repo, tag, currentImageId }) {
  if (!repo || !tag) return { status: 'unknown', reason: 'no repo/tag' };
  const { registry, path } = parseRepo(repo);

  let remoteDigest;
  try {
    remoteDigest = await withRetry(() => getRemoteDigest(registry, path, tag));
  } catch (e) {
    if (e instanceof RegistryError && e.retryable) {
      // Transient registry failure (rate-limit/auth/5xx), not "no registry to
      // check". Report it as a distinct, clearly-retryable error status
      // rather than folding it into the same "unknown" bucket the UI uses
      // for locally-built images.
      return { status: 'error', reason: transientReason(e), retryable: true };
    }
    return { status: 'unknown', reason: String(e.message || e) };
  }

  try {
    if (!remoteDigest) return { status: 'unknown', reason: 'no remote digest' };

    const localDigests = await getLocalRepoDigests(currentImageId);
    // Only compare against a RepoDigests entry that actually belongs to the
    // repo we just queried the registry for. An image can carry RepoDigests
    // for several unrelated repos (pulled/tagged/pushed under more than one
    // name); comparing the remote digest of `path` against a digest from a
    // different repo is meaningless and can produce a false positive/negative.
    // So: no arbitrary fallback to localDigests[0] here.
    const match = localDigests.find(d => d.repo === path || d.repo.endsWith('/' + path) || d.repo === repo);
    if (!match) {
      return { status: 'unknown', reason: `no matching local digest for ${path}`, remoteDigest };
    }

    const localDigest = match.digest;
    const updateAvailable = localDigest !== remoteDigest;
    return { status: updateAvailable ? 'update_available' : 'up_to_date', localDigest, remoteDigest };
  } catch (e) {
    return { status: 'unknown', reason: String(e.message || e) };
  }
}

function parseRepo(repo) {
  // e.g. ghcr.io/danny-avila/librechat -> registry=ghcr.io path=danny-avila/librechat
  // e.g. ankane/pgvector -> registry=registry-1.docker.io path=ankane/pgvector
  // e.g. mongo -> registry=registry-1.docker.io path=library/mongo
  const slash = repo.indexOf('/');
  const first = slash === -1 ? '' : repo.slice(0, slash);
  if (first.includes('.') || first.includes(':') || first === 'localhost') {
    return { registry: first, path: repo.slice(slash + 1) };
  }
  if (slash === -1) return { registry: 'registry-1.docker.io', path: 'library/' + repo };
  return { registry: 'registry-1.docker.io', path: repo };
}

async function getAuthToken(registry, path) {
  const key = `${registry}|${path}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.token;

  let tokenUrl, service;
  if (registry === 'registry-1.docker.io') {
    tokenUrl = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${path}:pull`;
    service = 'registry.docker.io';
  } else if (registry === 'ghcr.io') {
    tokenUrl = `https://ghcr.io/token?service=ghcr.io&scope=repository:${path}:pull`;
    service = 'ghcr.io';
  } else {
    // Try a generic token endpoint; many registries follow the same pattern.
    tokenUrl = `https://${registry}/token?service=${registry}&scope=repository:${path}:pull`;
    service = registry;
  }
  const res = await fetch(tokenUrl);
  if (!res.ok) {
    throw new RegistryError(`auth failed (${service}): ${res.status}`, {
      status: res.status,
      retryable: isRetryableStatus(res.status),
    });
  }
  const json = await res.json();
  const token = json.token || json.access_token;
  tokenCache.set(key, { token, expires: Date.now() + 4 * 60 * 1000 });
  return token;
}

async function getRemoteDigest(registry, path, tag) {
  const token = await getAuthToken(registry, path);
  const res = await fetch(`https://${registry}/v2/${path}/manifests/${encodeURIComponent(tag)}`, {
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${token}`,
      // A manifest-list/index digest and a platform-specific manifest digest
      // are two different, non-comparable digests. `docker pull` requests the
      // list/index types first, and for a multi-arch tag that is what gets
      // recorded in the local image's RepoDigests. So we request the list/
      // index media types at a higher q-value here too, to make the registry
      // prefer returning the same (index) digest Docker stored locally —
      // rather than letting server-default content negotiation pick a
      // platform-specific manifest and produce a permanent false "update
      // available" on multi-arch images. The single-manifest types are kept
      // as a lower-priority fallback for tags that are not multi-arch.
      Accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.manifest.v1+json;q=0.5',
        'application/vnd.docker.distribution.manifest.v2+json;q=0.5',
      ].join(', '),
    },
  });
  if (!res.ok) {
    if (isRetryableStatus(res.status)) {
      throw new RegistryError(`manifest fetch failed (${registry}): ${res.status}`, {
        status: res.status,
        retryable: true,
      });
    }
    // Genuine "no such tag/manifest" (404) or another non-retryable client
    // error -- there is nothing to compare against, but this is not a
    // transient registry problem.
    return null;
  }
  return res.headers.get('docker-content-digest');
}

async function getLocalRepoDigests(imageId) {
  if (!imageId) return [];
  try {
    const info = await docker.getImage(imageId).inspect();
    return (info.RepoDigests || []).map(rd => {
      const at = rd.lastIndexOf('@');
      return { repo: rd.slice(0, at), digest: rd.slice(at + 1) };
    });
  } catch {
    return [];
  }
}
