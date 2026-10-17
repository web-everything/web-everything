/** Head-bound preparation only. A cache entry never grants permission to enqueue before CI is green. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cascadePolicy, formatCascadeSourcesLine } from './policy-cascade.mjs';
import { readSettings } from './settings-files.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { reviewCiGate } from './review-ci-gate.mjs';

export function resolvePrestageSettings({ env = process.env, tool, platform, log = () => {} } = {}) {
  const r = cascadePolicy('drain', tool ?? (env.VITEST || env.WE_UNDER_TEST ? {} : readSettings().drain), {
    env, platform, standard: { prestageWhileCiRuns: true, prestageTtlMin: 30 },
    valid: { prestageWhileCiRuns: v => typeof v === 'boolean', prestageTtlMin: v => Number.isFinite(v) && v > 0 },
  });
  log(formatCascadeSourcesLine('drain', r));
  return r;
}

export const labelSignature = labels => Array.isArray(labels)
  ? JSON.stringify(labels.map(l => typeof l === 'string' ? l : l?.name).sort()) : null;

/** Require a real row for EVERY required context, even if another check normally implies it. */
export function prestageCi(pr, requiredChecks) {
  if (!Array.isArray(requiredChecks) || !requiredChecks.length || !Array.isArray(pr?.statusCheckRollup)) return 'unknown';
  const rows = pr.statusCheckRollup;
  if (requiredChecks.some(name => !rows.some(row => (row?.name ?? row?.context) === name))) return 'unknown';
  const g = reviewCiGate({ headSha: pr.headRefOid, requiredChecks, checks: rows });
  if (g.allowed) return 'green';
  if (g.affected.length && g.affected.every(a => a.reason === 'pending')) return 'pending';
  return 'red';
}

export function createPrestageCache({ env = process.env, root = join(resolveCoordinationRoot({ env }), 'drain-prestage'), now = Date.now } = {}) {
  const path = (repo, num) => join(root, createHash('sha256').update(`${repo.toLowerCase()}#${num}`).digest('hex') + '.json');
  const drop = (repo, num) => { try { unlinkSync(path(repo, num)); } catch { /* absent */ } };
  return {
    drop,
    put(repo, num, entry) {
      num = Number(num);
      mkdirSync(root, { recursive: true });
      const dest = path(repo, num), tmp = `${dest}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...entry, version: 1, repo: repo.toLowerCase(), num, at: now(), key: `${repo.toLowerCase()}#${num}@${entry.headSha}` }));
      renameSync(tmp, dest);
    },
    get(repo, num, ttlMin) {
      num = Number(num);
      try {
        const e = JSON.parse(readFileSync(path(repo, num), 'utf8'));
        if (e.version !== 1 || e.repo !== repo.toLowerCase() || e.num !== num || !e.headSha || !Number.isFinite(e.at)
            || now() < e.at || now() - e.at >= ttlMin * 60_000) { drop(repo, num); return null; }
        return e;
      } catch { return null; }
    },
  };
}

/** No listing or gate evaluation on a hit. Unknown/stale evidence delegates to the ordinary drain. */
export async function enqueuePrestage({ cache, repo, num, settings, readPr, enqueue, withLock }) {
  if (!settings.value.prestageWhileCiRuns) return { fallback: true };
  const entry = cache.get(repo, num, settings.value.prestageTtlMin);
  if (!entry?.eligible) return { fallback: true };
  let pr;
  try { pr = await readPr(); } catch { return { fallback: true }; }
  if (!pr || pr.headRefOid !== entry.headSha || pr.state !== 'OPEN' || pr.isDraft
      || labelSignature(pr.labels) !== entry.labels || pr.body !== entry.body || pr.baseRefName !== entry.baseRefName) {
    cache.drop(repo, num);
    return { fallback: true };
  }
  const ci = prestageCi(pr, entry.requiredChecks);
  if (ci === 'red') { cache.drop(repo, num); return { enqueued: false, reason: 'required checks red' }; }
  if (ci === 'unknown') return { fallback: true };
  if (ci !== 'green') return { enqueued: false, reason: `required checks ${ci}` };
  const locked = withLock(() => enqueue(entry.candidate, entry.headSha, entry));
  if (locked.ran === false) return { enqueued: false, reason: 'merge-write mutex held' };
  const result = locked.result;
  if (result.fallback) cache.drop(repo, num);
  if (result.enqueued) cache.drop(repo, num);
  return result;
}
