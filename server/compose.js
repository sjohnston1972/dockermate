// Run docker compose commands against a service's owning compose file.
// The host's C:/docker tree is mounted at /docker inside our container, so we
// rewrite Windows paths to the in-container view.

import { spawn } from 'node:child_process';

export function hostPathToContainer(p) {
  if (!p) return p;
  // C:\docker\net-core\foo -> /docker/net-core/foo
  return p.replace(/\\/g, '/').replace(/^[Cc]:\/docker/, '/docker');
}

export function runCompose(composeFile, workingDir, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const file = hostPathToContainer(composeFile);
  const cwd = hostPathToContainer(workingDir) || '/docker';
  const finalArgs = ['compose', '-f', file, ...args];
  return runCmd('docker', finalArgs, { cwd, timeoutMs });
}

export function runCmd(cmd, args, { cwd, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: stdout.slice(-20000),
        stderr: stderr.slice(-20000),
        cmd: `${cmd} ${args.join(' ')}`,
        cwd,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout: '', stderr: String(err), cmd: `${cmd} ${args.join(' ')}`, cwd });
    });
  });
}
