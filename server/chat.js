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

const SYSTEM_PROMPT = `You are dockermate, Stevie's Docker admin assistant for his home-docker host.

You can list, inspect, restart, stop, start, pull, recreate, exec into, and view logs of any container on the host. When asked to upgrade a container, your default approach is:
  1. Identify the compose file & service from the container's labels.
  2. compose_pull_service to fetch the new image.
  3. compose_up_service to recreate just that service.
  4. Confirm the new container is running and report the new image / digest.

Rules:
- Be concise. Talk like a senior sysadmin: short, factual, no fluff.
- Before any destructive action (stop, recreate, exec that mutates state), state what you're about to do in one sentence and proceed unless the user said "ask first".
- When the user asks "what needs upgrading", call list_containers and check_image_update for each, and summarize.
- Prefer compose-aware operations over bare docker pull/run when a container has compose labels.
- If a container has no compose labels, fall back to docker pull + restart.
- Never invent container names or image tags — if uncertain, list_containers first.`;

const tools = [
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
      description: 'Check whether a newer image is available in the registry for a given container.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
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
      description: 'Run a shell command inside a running container and return stdout/stderr.',
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
      const c = containers.find(x => x.name === args.name || x.id === args.name || x.shortId === args.name);
      if (!c) return { error: `container ${args.name} not found` };
      return await checkImageUpdate({ repo: c.repo, tag: c.tag, currentImageId: c.imageId });
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
    case 'exec_in_container':
      return await execInContainer(args.name, args.cmd);
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
      tools,
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
