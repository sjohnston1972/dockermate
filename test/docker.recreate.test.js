// Plain node:test — no test runner is set up in this repo yet.
// Run with: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecreateSpec } from '../server/docker.js';

// A representative `docker inspect` result for a standalone container
// created with:
//   docker run -d --name demo \
//     -p 8081:80 -e FOO=bar -v demo-data:/data \
//     --restart unless-stopped --network bridge nginx:latest
const SAMPLE_INSPECT = {
  Id: 'abc123oldcontainerid',
  Name: '/demo',
  Image: 'sha256:oldimageid00000000000000000000000000000000000000000000000000',
  Config: {
    Image: 'nginx:latest',
    Env: ['FOO=bar', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
    Cmd: ['nginx', '-g', 'daemon off;'],
    Entrypoint: ['/docker-entrypoint.sh'],
    Labels: { 'com.example.owner': 'steven' },
    ExposedPorts: { '80/tcp': {} },
    WorkingDir: '',
    User: '',
    Tty: false,
    OpenStdin: false,
    StopSignal: 'SIGQUIT',
    Healthcheck: undefined,
  },
  HostConfig: {
    Binds: ['demo-data:/data'],
    PortBindings: { '80/tcp': [{ HostIp: '', HostPort: '8081' }] },
    RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
    NetworkMode: 'bridge',
    CapAdd: null,
    CapDrop: null,
    Privileged: false,
    ContainerIDFile: '',
  },
  NetworkSettings: {
    Networks: {
      bridge: {
        Aliases: ['demo-alias'],
        IPAMConfig: { IPv4Address: '' },
      },
    },
  },
};

test('buildRecreateSpec preserves name, image, env, ports, volumes, restart policy', () => {
  const spec = buildRecreateSpec(SAMPLE_INSPECT);

  assert.equal(spec.name, 'demo');
  assert.equal(spec.Image, 'nginx:latest');
  assert.deepEqual(spec.Env, SAMPLE_INSPECT.Config.Env);
  assert.deepEqual(spec.Cmd, SAMPLE_INSPECT.Config.Cmd);
  assert.deepEqual(spec.Entrypoint, SAMPLE_INSPECT.Config.Entrypoint);
  assert.deepEqual(spec.Labels, SAMPLE_INSPECT.Config.Labels);
  assert.deepEqual(spec.ExposedPorts, { '80/tcp': {} });

  // Volumes / binds
  assert.deepEqual(spec.HostConfig.Binds, ['demo-data:/data']);

  // Published ports
  assert.deepEqual(spec.HostConfig.PortBindings, { '80/tcp': [{ HostIp: '', HostPort: '8081' }] });

  // Restart policy
  assert.deepEqual(spec.HostConfig.RestartPolicy, { Name: 'unless-stopped', MaximumRetryCount: 0 });

  // Network + alias preserved, ContainerIDFile stripped
  assert.deepEqual(spec.NetworkingConfig.EndpointsConfig.bridge.Aliases, ['demo-alias']);
  assert.equal('ContainerIDFile' in spec.HostConfig, false);
});

test('buildRecreateSpec does not mutate the inspect data it was given', () => {
  const before = JSON.stringify(SAMPLE_INSPECT);
  buildRecreateSpec(SAMPLE_INSPECT);
  assert.equal(JSON.stringify(SAMPLE_INSPECT), before);
});

test('buildRecreateSpec overrides.image pins to a specific ref (rollback use case)', () => {
  const spec = buildRecreateSpec(SAMPLE_INSPECT, { image: SAMPLE_INSPECT.Image });
  assert.equal(spec.Image, 'sha256:oldimageid00000000000000000000000000000000000000000000000000');
  // Everything else about the spec (ports, env, volumes) is unaffected by the override.
  assert.deepEqual(spec.HostConfig.PortBindings, { '80/tcp': [{ HostIp: '', HostPort: '8081' }] });
});

test('buildRecreateSpec overrides.name can rename the container (e.g. rollback avoiding a name clash)', () => {
  const spec = buildRecreateSpec(SAMPLE_INSPECT, { name: 'demo-restored' });
  assert.equal(spec.name, 'demo-restored');
});
