// Compare a running container's image digest against the latest digest in the registry.
// Supports Docker Hub (library/* and user images) and GHCR. Falls back to "unknown" otherwise.

import { docker } from './docker.js';

const tokenCache = new Map(); // key: registry|repo -> { token, expires }

export async function checkImageUpdate({ repo, tag, currentImageId }) {
  if (!repo || !tag) return { status: 'unknown', reason: 'no repo/tag' };
  try {
    const { registry, path } = parseRepo(repo);
    const remoteDigest = await getRemoteDigest(registry, path, tag);
    if (!remoteDigest) return { status: 'unknown', reason: 'no remote digest' };

    const localDigests = await getLocalRepoDigests(currentImageId);
    const localDigest = localDigests.find(d => d.repo === path || d.repo.endsWith('/' + path) || d.repo === repo)?.digest
      || localDigests[0]?.digest
      || null;

    if (!localDigest) return { status: 'unknown', reason: 'no local digest', remoteDigest };
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
  if (!res.ok) throw new Error(`auth failed (${service}): ${res.status}`);
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
      Accept: [
        'application/vnd.docker.distribution.manifest.v2+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.oci.image.index.v1+json',
      ].join(', '),
    },
  });
  if (!res.ok) return null;
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
