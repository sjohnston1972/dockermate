# dockermate

A self-hosted dashboard + chatbot for the Docker host it runs on.

- **Tile grid** of every container — image, version (tag), state, uptime, restarts, ports, health.
- **Soft pulse** on any tile whose registry digest differs from the local image — a one-glance "this needs upgrading" signal.
- **Bottom-right chatbot** (OpenAI / ChatGPT) with **full container control**: list, inspect, logs, pull, start/stop/restart, `docker compose pull` + `up -d` against the owning compose file, and `exec` into running containers.
- **Compose-aware upgrades** — when a container has compose labels, the bot recreates it via its original compose file rather than a bare `docker run`, preserving env, volumes, and network config.
- **Cloudflare Access** in front of the public hostname, so the only auth surface is your IdP.

Built for [@sjohnston1972](https://github.com/sjohnston1972)'s home-docker host. Designed to be easy to drop onto any single-host Docker Desktop / Docker Engine setup.

## Stack

| Layer | What |
|---|---|
| Backend | Node.js 20, Express, [`dockerode`](https://github.com/apocas/dockerode), `openai` SDK |
| Frontend | Static HTML + vanilla JS + Tailwind (CDN), Material Symbols, Inter |
| Container | Single image with `docker` CLI + compose plugin baked in |
| Ingress | Cloudflare Tunnel + Access (self-hosted app) |

## Quick start

```bash
cp .env.example .env
# edit .env — set OPENAI_API_KEY at minimum

docker compose --env-file .env up -d --build
```

The container has no host port mapping by default — it expects to be reached on the `net_core` Docker network (e.g. via a Cloudflare Tunnel pointed at `http://dockermate:8080`). To run it standalone, add a port mapping in `docker-compose.yml`:

```yaml
    ports:
      - "8095:8080"
```

…and browse to `http://localhost:8095`.

## How it talks to Docker

| Need | Mount |
|---|---|
| List/inspect/start/stop/restart/exec/pull | `/var/run/docker.sock:/var/run/docker.sock` (Docker Desktop on Windows transparently bridges this to the named pipe) |
| `docker compose pull/up` against your compose files | `C:/docker:/docker` (or wherever your compose tree lives — adjust the bind mount) |

The container's `docker compose` finds each service's compose file via the standard `com.docker.compose.project.config_files` label set on every compose-managed container, then rewrites the host path to its in-container view.

## Image-update detection

For each running container, dockermate:
1. Reads the image's local digest from `docker inspect` → `RepoDigests`.
2. Looks up the same `repo:tag`'s **remote** digest via the registry's `HEAD /v2/<repo>/manifests/<tag>` (Docker Hub & GHCR supported out of the box; other OCI registries fall back to the same generic token endpoint).
3. If the digests differ, the tile pulses and the bot reports it as needing an upgrade.

No image is pulled during the check — only manifest HEAD requests.

## Chatbot

Uses OpenAI's tool-calling. The model has access to:

| Tool | What it does |
|---|---|
| `list_containers` | Full inventory, including compose labels |
| `inspect_container` | Trimmed `docker inspect` |
| `get_logs` | Tail logs (default 200 lines) |
| `check_image_update` | Per-container registry digest check |
| `pull_image` | `docker pull <ref>` |
| `start_container` / `stop_container` / `restart_container` | Lifecycle |
| `compose_pull_service` / `compose_up_service` | Compose-aware upgrade |
| `exec_in_container` | Run a shell command inside a container |

Default model is `gpt-4o-mini`. Set `OPENAI_MODEL=gpt-4o` (or any other tool-capable model) to change it.

## Security

- **Authoritative gate is Cloudflare Access** — there is no app-level auth. If you publish this without Access (or equivalent), anyone reaching the URL can do anything `docker.sock` can do, including running arbitrary commands inside any container.
- The chatbot can call `exec_in_container` and `compose_*` operations. That is intentional, but it means whoever can chat can effectively root the host. Treat the URL like SSH.
- `.env` is gitignored. Don't commit it.

## Layout

```
.
├── CLAUDE.md             # AI-assistant brief for working in this repo
├── Dockerfile
├── docker-compose.yml
├── package.json
├── public/               # Static frontend (HTML/CSS/JS)
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── server/               # Express + tools
    ├── index.js          # HTTP API
    ├── docker.js         # dockerode wrappers
    ├── compose.js        # spawn `docker compose ...`
    ├── registry.js       # remote digest lookups
    └── chat.js           # OpenAI tool-calling loop
```

## License

MIT. Use at your own risk — see Security above.
