import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listContainers, getLogs, pullImage, restartContainer } from './docker.js';
import { checkImageUpdate } from './registry.js';
import { runCompose } from './compose.js';
import { chat } from './chat.js';
import { createJob, getJob, updateJob, appendStep } from './jobs.js';
import { requireAuth } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

// Health check stays public — no credential required, no container/host
// data returned. Everything else under /api/* requires auth (see
// server/auth.js): a verified Cloudflare Access JWT and/or the shared
// secret, whichever is configured. Fails closed if neither is configured.
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api', requireAuth);

app.get('/api/containers', async (_req, res) => {
  try {
    const containers = await listContainers();
    res.json(containers);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Lazily check updates one at a time so the page can stream them in.
app.get('/api/containers/:name/update-status', async (req, res) => {
  try {
    const containers = await listContainers();
    const c = containers.find(x => x.name === req.params.name);
    if (!c) return res.status(404).json({ error: 'not found' });
    const status = await checkImageUpdate({ repo: c.repo, tag: c.tag, currentImageId: c.imageId });
    res.json({ name: c.name, ...status });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/containers/:name/logs', async (req, res) => {
  try {
    const tail = Number(req.query.tail) || 200;
    const text = await getLogs(req.params.name, tail);
    res.type('text/plain').send(text);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Upgrade a container in-place. This kicks off an async job and returns a
// jobId immediately — the actual pull+recreate is run in the background and
// the UI polls /api/jobs/:id. Doing it this way avoids Cloudflare's 100s
// response timeout for slow image pulls (e.g. multi-GB images).
app.post('/api/containers/:name/upgrade', async (req, res) => {
  try {
    const containers = await listContainers();
    const c = containers.find(x => x.name === req.params.name);
    if (!c) return res.status(404).json({ error: 'not found' });

    const job = createJob({ kind: 'upgrade', target: c.name });

    // Run in the background.
    runUpgrade(job.id, c).catch((err) => {
      updateJob(job.id, { state: 'failed', error: String(err.message || err), finishedAt: Date.now() });
    });

    res.status(202).json({ jobId: job.id, target: c.name, mode: c.composeFile ? 'compose' : 'pull+restart' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

async function runUpgrade(jobId, c) {
  updateJob(jobId, { state: 'running' });

  if (c.composeFile && c.composeService) {
    appendStep(jobId, { step: 'compose pull', state: 'running' });
    const pull = await runCompose(c.composeFile, c.composeWorkingDir, ['pull', c.composeService], { timeoutMs: 30 * 60 * 1000 });
    // Replace the running step with the final one.
    const job = getJob(jobId);
    job.steps[job.steps.length - 1] = { step: 'compose pull', ...pull };
    if (pull.exitCode !== 0) {
      updateJob(jobId, { state: 'failed', error: `compose pull exited ${pull.exitCode}`, finishedAt: Date.now() });
      return;
    }

    appendStep(jobId, { step: 'compose up -d', state: 'running' });
    const up = await runCompose(c.composeFile, c.composeWorkingDir, ['up', '-d', c.composeService], { timeoutMs: 10 * 60 * 1000 });
    const job2 = getJob(jobId);
    job2.steps[job2.steps.length - 1] = { step: 'compose up -d', ...up };
    if (up.exitCode !== 0) {
      updateJob(jobId, { state: 'failed', error: `compose up exited ${up.exitCode}`, finishedAt: Date.now() });
      return;
    }
  } else {
    appendStep(jobId, { step: 'docker pull', state: 'running' });
    const pulled = await pullImage(c.image);
    const job = getJob(jobId);
    job.steps[job.steps.length - 1] = { step: 'docker pull', summary: pulled.summary };
    appendStep(jobId, { step: 'restart', state: 'running' });
    await restartContainer(c.name);
    const job2 = getJob(jobId);
    job2.steps[job2.steps.length - 1] = { step: 'restart', ok: true };
  }

  const after = (await listContainers()).find(x => x.name === c.name);
  const status = after ? await checkImageUpdate({ repo: after.repo, tag: after.tag, currentImageId: after.imageId }) : null;
  updateJob(jobId, {
    state: 'done',
    result: { state: after?.state, imageId: after?.imageId, status, image: after?.image, tag: after?.tag },
    finishedAt: Date.now(),
  });
}

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
    const result = await chat(messages);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`dockermate listening on :${PORT}`);
});
