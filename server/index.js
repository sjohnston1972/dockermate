import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listContainers, getLogs } from './docker.js';
import { checkImageUpdate } from './registry.js';
import { chat } from './chat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

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
