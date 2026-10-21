import { dirname, join } from 'node:path';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { writeJsonAtomic, withFileLock } from './atomic-json-file.mjs';

// One durable request per repo/PR/head. Completed records remain as idempotency tombstones.
const requestDir = env => join(resolveCoordinationRoot({ env }), 'drain-red-team-requests');
const requestKey = ({ repo, pr, head }) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !Number.isSafeInteger(pr) || pr <= 0 || !/^[a-f0-9]{40}$/i.test(head ?? '')) throw Error('invalid red-team request');
  return `${encodeURIComponent(repo.toLowerCase())}-${pr}-${head.toLowerCase()}.json`;
};
export function requestDrainRedTeam(input, { env = process.env, dryRun = false, write = writeJsonAtomic } = {}) {
  if (dryRun) return { requested: false };
  try {
    const path = join(requestDir(env), requestKey(input));
    mkdirSync(dirname(path), { recursive: true });
    return withFileLock(`${path}.lock`, () => {
      try {
        const existing = JSON.parse(readFileSync(path, 'utf8'));
        return { requested: requestKey(existing) === requestKey(input) && Number.isFinite(existing.requestedAt) };
      }
      catch (e) { if (e.code !== 'ENOENT') return { requested: false }; }
      write(path, { repo: input.repo.toLowerCase(), pr: input.pr, head: input.head.toLowerCase(), requestedAt: Date.now() });
      return { requested: true };
    });
  } catch { return { requested: false }; }
}
export function readDrainRedTeamRequests({ env = process.env } = {}) {
  let names;
  try { names = readdirSync(requestDir(env)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.filter(n => n.endsWith('.json')).flatMap(name => {
    try {
      const request = JSON.parse(readFileSync(join(requestDir(env), name), 'utf8'));
      return requestKey(request) === name && Number.isFinite(request.requestedAt) && !request.consumedAt ? [request] : [];
    } catch { return []; }
  });
}
export function finishDrainRedTeamRequest(request, { env = process.env, status = 'completed' } = {}) {
  const path = join(requestDir(env), requestKey(request));
  withFileLock(`${path}.lock`, () => {
    const current = JSON.parse(readFileSync(path, 'utf8'));
    writeJsonAtomic(path, { ...current, consumedAt: Date.now(), status });
  });
}

