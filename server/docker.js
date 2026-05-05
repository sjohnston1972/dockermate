import Docker from 'dockerode';

export const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export async function listContainers() {
  const raw = await docker.listContainers({ all: true });
  return Promise.all(raw.map(async (c) => {
    const inspect = await docker.getContainer(c.Id).inspect().catch(() => null);
    const labels = c.Labels || {};
    const composeProject = labels['com.docker.compose.project'] || null;
    const composeService = labels['com.docker.compose.service'] || null;
    const composeFile = labels['com.docker.compose.project.config_files'] || null;
    const composeWorkingDir = labels['com.docker.compose.project.working_dir'] || null;
    const imageRef = c.Image;
    const { repo, tag } = parseImageRef(imageRef);
    const imageId = inspect?.Image || null;
    const created = inspect?.Created || null;
    const startedAt = inspect?.State?.StartedAt || null;
    const health = inspect?.State?.Health?.Status || null;
    const restartCount = inspect?.RestartCount ?? 0;
    const ports = (c.Ports || [])
      .filter(p => p.PublicPort)
      .map(p => `${p.PublicPort}:${p.PrivatePort}/${p.Type}`);
    return {
      id: c.Id,
      shortId: c.Id.slice(0, 12),
      name: (c.Names?.[0] || '').replace(/^\//, ''),
      image: imageRef,
      repo,
      tag,
      imageId,
      state: c.State,
      status: c.Status,
      health,
      created,
      startedAt,
      restartCount,
      ports,
      composeProject,
      composeService,
      composeFile,
      composeWorkingDir,
    };
  }));
}

export async function inspectContainer(idOrName) {
  return docker.getContainer(idOrName).inspect();
}

export async function getLogs(idOrName, tail = 200) {
  const container = docker.getContainer(idOrName);
  const stream = await container.logs({ stdout: true, stderr: true, tail, follow: false, timestamps: false });
  return stripDockerLogHeaders(stream);
}

export async function startContainer(idOrName) {
  await docker.getContainer(idOrName).start();
  return { ok: true };
}

export async function stopContainer(idOrName, timeout = 10) {
  await docker.getContainer(idOrName).stop({ t: timeout });
  return { ok: true };
}

export async function restartContainer(idOrName, timeout = 10) {
  await docker.getContainer(idOrName).restart({ t: timeout });
  return { ok: true };
}

export async function pullImage(imageRef) {
  return new Promise((resolve, reject) => {
    docker.pull(imageRef, (err, stream) => {
      if (err) return reject(err);
      const events = [];
      docker.modem.followProgress(stream, (e2, output) => {
        if (e2) return reject(e2);
        resolve({ events: output, summary: output[output.length - 1] });
      }, (event) => events.push(event));
    });
  });
}

export async function execInContainer(idOrName, cmd) {
  const container = docker.getContainer(idOrName);
  const exec = await container.exec({
    Cmd: Array.isArray(cmd) ? cmd : ['sh', '-lc', cmd],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const out = await new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
  const inspect = await exec.inspect();
  return { exitCode: inspect.ExitCode, output: stripDockerLogHeaders(out) };
}

function stripDockerLogHeaders(buf) {
  // Docker multiplexed stream: 8-byte header per chunk (stream type, 0,0,0, 4-byte big-endian length).
  const out = [];
  let i = 0;
  while (i < buf.length) {
    if (buf.length - i < 8) { out.push(buf.slice(i)); break; }
    const len = buf.readUInt32BE(i + 4);
    out.push(buf.slice(i + 8, i + 8 + len));
    i += 8 + len;
  }
  return Buffer.concat(out).toString('utf8');
}

function parseImageRef(ref) {
  // e.g. ghcr.io/danny-avila/librechat:latest -> { repo, tag }
  if (!ref) return { repo: null, tag: null };
  const at = ref.indexOf('@');
  const cleaned = at > -1 ? ref.slice(0, at) : ref;
  const lastColon = cleaned.lastIndexOf(':');
  const lastSlash = cleaned.lastIndexOf('/');
  if (lastColon > lastSlash) {
    return { repo: cleaned.slice(0, lastColon), tag: cleaned.slice(lastColon + 1) };
  }
  return { repo: cleaned, tag: 'latest' };
}
