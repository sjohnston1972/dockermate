import OpenAI from 'openai';
import {
  listContainers, inspectContainer, getLogs,
  startContainer, stopContainer, restartContainer,
  pullImage, execInContainer,
} from './docker.js';
import { checkImageUpdate } from './registry.js';
import { runCompose } from './compose.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ---------------------------------------------------------------------------
// exec_in_container policy (issue #13)
//
// The container mounts the Docker socket, so exec into any container is
// effectively root on the host. It is OFF by default and only usable when a
// human deliberately opts in via config (see .env.example / README) — the
// capability is never silently dropped, just gated behind deliberate config.
// ---------------------------------------------------------------------------
const CHAT_ALLOW_EXEC = /^(1|true|yes)$/i.test(process.env.CHAT_ALLOW_EXEC || '');
const EXEC_CONTAINER_ALLOWLIST = parseList(process.env.CHAT_EXEC_CONTAINER_ALLOWLIST);
const EXEC_COMMAND_ALLOWLIST = parseList(process.env.CHAT_EXEC_COMMAND_ALLOWLIST);

function parseList(v) {
  if (!v || !v.trim()) return null; // null = no additional restriction
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

// Returns a human-readable policy error string, or null if the exec call is
// allowed to proceed.
function execPolicyError(args) {
  if (!CHAT_ALLOW_EXEC) {
    return 'exec is disabled by policy (set CHAT_ALLOW_EXEC=true to opt in — see .env.example)';
  }
  const name = args?.name;
  if (EXEC_CONTAINER_ALLOWLIST && !EXEC_CONTAINER_ALLOWLIST.includes(name)) {
    return `container "${name}" is not on the exec allowlist (CHAT_EXEC_CONTAINER_ALLOWLIST)`;
  }
  if (EXEC_COMMAND_ALLOWLIST) {
    const cmd = String(args?.cmd || '').trim();
    const allowed = EXEC_COMMAND_ALLOWLIST.some((prefix) => cmd === prefix || cmd.startsWith(`${prefix} `));
    if (!allowed) {
      return 'command is not on the exec command allowlist (CHAT_EXEC_COMMAND_ALLOWLIST)';
    }
  }
  return null;
}

const SYSTEM_PROMPT = `You are dockermate, Stevie's Docker admin assistant for his home-docker host.

You can list, inspect, restart, stop, start, pull, recreate, exec into, and view logs of any container on the host. exec_in_container may be disabled or restricted (specific containers/commands only) by server policy — if so it returns a policy error instead of running; report that error to Stevie rather than retrying. When asked to upgrade a container, your default approach is:
  1. Identify the compose file & service from the container's labels.
  2. compose_pull_service to fetch the new image.
  3. compose_up_service to recreate just that service.
  4. Confirm the new container is running and report the new image / digest.

Rules:
- Be concise. Talk like a senior sysadmin: short, factual, no fluff.
- Before any destructive action (stop, recreate, exec that mutates state), state what you're about to do in one sentence and proceed unless the user said "ask first".
- For "what needs upgrading?" type questions, use check_all_updates (one call) — do NOT loop check_image_update per container.
- When using check_image_update for a single container, pass the CONTAINER name (e.g. "kopis-postgres"), never an image reference.
- A status of "unknown" with reason="no remote digest" means the image was built locally and has no registry to compare against — report it as "locally built, no registry to check" rather than as a failure.
- Prefer compose-aware operations over bare docker pull/run when a container has compose labels.
- If a container has no compose labels, fall back to docker pull + restart.
- Never invent container names or image tags — if uncertain, list_containers first.`;

const ALL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_containers',
      description: 'List all containers on the host with image, version (tag), state, status, ports, and compose labels.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_container',
      description: 'Return the full docker inspect output for a container.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Container name or id.' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_logs',
      description: 'Tail the logs of a container.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          tail: { type: 'number', description: 'Number of lines (default 200).' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_image_update',
      description: 'Check whether a newer image is available in the registry for a single container. Use the CONTAINER name (e.g. "kopis-postgres"), not the image reference. To check all containers at once, prefer check_all_updates instead.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Container name (not image ref).' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_all_updates',
      description: 'Check every container on the host for image updates in one call. Returns an array of {name, image, status, localDigest, remoteDigest, reason}. status is one of: update_available, up_to_date, unknown. Locally-built images (no remote registry) report status=unknown with reason="no remote digest" — that means the image was built here, not that the check failed.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pull_image',
      description: 'Pull the latest image for a given image reference (e.g. ghcr.io/foo/bar:latest).',
      parameters: {
        type: 'object',
        properties: { image: { type: 'string' } },
        required: ['image'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_container',
      description: 'Start a stopped container.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_container',
      description: 'Stop a running container.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'restart_container',
      description: 'Restart a container.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compose_pull_service',
      description: 'Run "docker compose pull <service>" against the compose file that owns the named container.',
      parameters: { type: 'object', properties: { name: { type: 'string', description: 'Container name.' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compose_up_service',
      description: 'Run "docker compose up -d <service>" against the compose file that owns the named container. Use this after compose_pull_service to recreate a container with the new image.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exec_in_container',
      description: 'Run a shell command inside a running container and return stdout/stderr. May be disabled or allowlist-restricted by server policy.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          cmd: { type: 'string', description: 'Shell command to run, e.g. "ls /app".' },
        },
        required: ['name', 'cmd'],
      },
    },
  },
];

// Don't even advertise exec_in_container to the model when it's disabled by
// policy, on top of the runtime check in runTool below (issue #13
// acceptance criteria: "Optionally omit the tool from the tools array
// entirely when disabled").
function getTools() {
  if (CHAT_ALLOW_EXEC) return ALL_TOOLS;
  return ALL_TOOLS.filter((t) => t.function.name !== 'exec_in_container');
}

async function runTool(name, args) {
  switch (name) {
    case 'list_containers': {
      const containers = await listContainers();
      return containers.map(c => ({
        name: c.name,
        image: c.image,
        repo: c.repo,
        tag: c.tag,
        state: c.state,
        status: c.status,
        health: c.health,
        ports: c.ports,
        composeProject: c.composeProject,
        composeService: c.composeService,
      }));
    }
    case 'inspect_container': {
      const info = await inspectContainer(args.name);
      return {
        Name: info.Name,
        Image: info.Config?.Image,
        State: info.State,
        Mounts: info.Mounts,
        NetworkSettings: { Networks: Object.keys(info.NetworkSettings?.Networks || {}) },
        Env: info.Config?.Env,
        RestartCount: info.RestartCount,
      };
    }
    case 'get_logs':
      return await getLogs(args.name, args.tail || 200);
    case 'check_image_update': {
      const containers = await listContainers();
      const c = containers.find(x =>
        x.name === args.name || x.id === args.name || x.shortId === args.name || x.image === args.name
      );
      if (!c) return { error: `container ${args.name} not found — pass the container name, not the image ref` };
      return { name: c.name, image: c.image, ...await checkImageUpdate({ repo: c.repo, tag: c.tag, currentImageId: c.imageId }) };
    }
    case 'check_all_updates': {
      const containers = await listContainers();
      const results = await Promise.all(containers.map(async (c) => {
        const r = await checkImageUpdate({ repo: c.repo, tag: c.tag, currentImageId: c.imageId });
        return { name: c.name, image: c.image, ...r };
      }));
      return results;
    }
    case 'pull_image':
      return await pullImage(args.image);
    case 'start_container':
      return await startContainer(args.name);
    case 'stop_container':
      return await stopContainer(args.name);
    case 'restart_container':
      return await restartContainer(args.name);
    case 'compose_pull_service':
    case 'compose_up_service': {
      const containers = await listContainers();
      const c = containers.find(x => x.name === args.name);
      if (!c) return { error: `container ${args.name} not found` };
      if (!c.composeFile || !c.composeService) {
        return { error: `container ${args.name} has no compose labels — fallback to pull_image + restart_container` };
      }
      const opArgs = name === 'compose_pull_service'
        ? ['pull', c.composeService]
        : ['up', '-d', c.composeService];
      return await runCompose(c.composeFile, c.composeWorkingDir, opArgs);
    }
    case 'exec_in_container': {
      const policyError = execPolicyError(args);
      if (policyError) return { error: policyError };
      return await execInContainer(args.name, args.cmd);
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

export async function chat(history) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history];
  for (let hop = 0; hop < 12; hop++) {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools: getTools(),
      tool_choice: 'auto',
    });
    const msg = resp.choices[0].message;
    messages.push(msg);
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { reply: msg.content || '', messages };
    }
    for (const call of msg.tool_calls) {
      let result;
      try {
        const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        result = await runTool(call.function.name, args);
      } catch (e) {
        result = { error: String(e.message || e) };
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 30000),
      });
    }
  }
  return { reply: '(too many tool hops — aborting)', messages };
}
