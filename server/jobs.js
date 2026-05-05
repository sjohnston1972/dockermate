// Tiny in-memory job registry for long-running upgrade operations.
// We intentionally keep this dead simple — no persistence; if dockermate
// restarts mid-upgrade the job is lost, which is acceptable.

import { randomUUID } from 'node:crypto';

const jobs = new Map();
const MAX_JOBS = 200;

export function createJob({ kind, target }) {
  const id = randomUUID();
  const job = {
    id,
    kind,
    target,
    state: 'queued',     // queued | running | done | failed
    step: null,
    steps: [],           // [{ step, exitCode, stdout, stderr, ... }]
    error: null,
    result: null,        // populated on success
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(id, job);
  // Trim oldest jobs if we hit the cap.
  if (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
    if (oldest) jobs.delete(oldest[0]);
  }
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch);
  return job;
}

export function appendStep(id, step) {
  const job = jobs.get(id);
  if (!job) return;
  job.steps.push(step);
  job.step = step.step;
}
