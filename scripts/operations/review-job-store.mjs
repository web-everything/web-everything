/**
 * @file scripts/operations/review-job-store.mjs
 * @description x26lw6u — the JOB RECORD store for `we:scripts/operations/review-job.mjs`, kept apart from the
 * job's arc so the two readers that merge job rows into their agent listing
 * (`we:scripts/conveyor/reconcile-pass.mjs#defaultReadAgents`, `we:scripts/conveyor/review-status-tag.mjs`)
 * import a small fs-only module, not the whole dispatch graph. See `review-job.mjs`'s header ("LIVENESS WITHOUT
 * A TRANSCRIPT") for why these rows exist and what reads them.
 *
 * A record is `<dir>/<slug>.json` = `{ slug, pr, repo, pid, startedAt, cwd, actorId? }`, written atomically.
 * The pid IS the liveness signal: a live pid is a running job, a dead one is pruned on read.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultListAgents } from './dispatch-lane-io.mjs';
import { listWrappedWorkerAgents } from './worker-wrapper-launch.mjs';

/** The checkout this module lives in — the same root `dispatch-lane-io.mjs#REPO_ROOT` resolves. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The `kind` a job's synthetic listing row carries — never a real `claude agents` kind, so nothing that acts
 *  on sessions (`claude stop`, transcript reads) can mistake it for one. */
export const REVIEW_JOB_KIND = 'review-job';

// ── WHERE JOB RECORDS LIVE ─────────────────────────────────────────────────────────────────────────────────────

/** `<root>/.operations/review-jobs` — gitignored (`.operations/`), resolved by SCRIPT LOCATION like the
 *  completion store, so the dispatching daemon, the job and every reader agree on one directory.
 *  `OPERATION_REVIEW_JOBS_DIR` overrides it (tests). */
export function reviewJobsDir(env = process.env, root = REPO_ROOT) {
  const o = env?.OPERATION_REVIEW_JOBS_DIR;
  return o && String(o).trim() ? resolve(String(o).trim()) : join(root, '.operations', 'review-jobs');
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function assertSlug(slug) {
  if (!SLUG_RE.test(String(slug ?? ''))) throw new TypeError(`review-job: invalid job slug ${JSON.stringify(slug)}`);
}
export function jobRecordPath(slug, dir = reviewJobsDir()) { assertSlug(slug); return join(dir, `${slug}.json`); }
export function jobLogPath(slug, dir = reviewJobsDir()) { assertSlug(slug); return join(dir, `${slug}.log`); }

/** Three-valued pid probe, same contract as `reconcile-pass.mjs#probePid` (EPERM = alive, ESRCH = dead). */
export function pidAlive(pid, kill = (p, s) => process.kill(p, s)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/** @returns {object|null} the record, or null when absent/unparseable (an unparseable record is not a live job). */
export function readJobRecord(slug, dir = reviewJobsDir()) {
  try { return JSON.parse(readFileSync(jobRecordPath(slug, dir), 'utf8')); } catch { return null; }
}

/** Atomic write (temp + rename). */
export function writeJobRecord(record, dir = reviewJobsDir()) {
  const path = jobRecordPath(record.slug, dir);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
  return record;
}

/** Remove the record — only when it is still OURS (`pid` matches), so a job never deletes a successor's. */
export function removeJobRecord(slug, pid, dir = reviewJobsDir()) {
  const rec = readJobRecord(slug, dir);
  if (rec && rec.pid !== pid) return false;
  try { rmSync(jobRecordPath(slug, dir), { force: true }); return true; } catch { return false; }
}

/**
 * PURE — may `pid` take the job slot for `slug`, given what is on disk? Free when there is no record, the
 * record is already ours, or its pid is dead (a crashed job left it behind).
 * @returns {{ok:boolean, heldBy?:number}}
 */
export function decideJobClaim(existing, pid, isAlive) {
  if (!existing || !Number.isInteger(existing.pid)) return { ok: true };
  if (existing.pid === pid) return { ok: true };
  if (isAlive(existing.pid)) return { ok: false, heldBy: existing.pid };
  return { ok: true };
}

/**
 * PURE — the listing row a live job record stands for. Same field names `claude agents --json` uses, so
 * `bindAgents` (by `name`), `enrichAgents` (`pid`, `cwd`), `markSelfReportedDone` (`startedAt`) and
 * `deriveReviewStatus` (`state`) read it with no special case.
 */
export function jobRecordToAgentRow(record) {
  return {
    id: `job-${record.pid}`,
    name: String(record.slug),
    kind: REVIEW_JOB_KIND,
    state: 'working',
    pid: record.pid,
    cwd: String(record.cwd || REPO_ROOT),
    startedAt: Date.parse(record.startedAt) || record.startedAt,
    sessionId: null,
    pr: record.pr ?? null,
    repo: record.repo ?? null,
  };
}

/**
 * Every live review job, as listing rows. A record whose pid is dead is PRUNED (the job crashed or was killed
 * before its own cleanup) and never returned — a dead job must not keep a PR looking busy forever.
 * NEVER throws: an unreadable directory answers `[]` (no jobs), the same "absence is not liveness" direction.
 */
export function listReviewJobAgents({ dir = reviewJobsDir(), isAlive = pidAlive } = {}) {
  let names;
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const rows = [];
  for (const name of names) {
    const slug = name.slice(0, -'.json'.length);
    const rec = SLUG_RE.test(slug) ? readJobRecord(slug, dir) : null;
    if (!rec || !Number.isInteger(rec.pid)) continue;
    if (!isAlive(rec.pid)) { try { rmSync(join(dir, name), { force: true }); } catch { /* best effort */ } continue; }
    rows.push(jobRecordToAgentRow(rec));
  }
  return rows;
}

/**
 * `claude agents --json` + the live review jobs + (117 S3b) the wrapped run-to-completion workers — the ONE merged
 * listing reconcile and review-status-tag read. A wrapped fix / ci-heal / review has no `claude agents` row; its v2
 * completion record stands in for one (`worker-wrapper-launch.mjs#listWrappedWorkerAgents`).
 */
export function listAgentsWithReviewJobs({
  listAgents = () => defaultListAgents(), listJobs = () => listReviewJobAgents(), listWrapped = () => listWrappedWorkerAgents(),
} = {}) {
  const listed = listAgents();
  const agents = Array.isArray(listed) ? listed : [];
  let jobs = [];
  try { jobs = listJobs() ?? []; } catch { jobs = []; }
  let wrapped = [];
  try { wrapped = listWrapped() ?? []; } catch { wrapped = []; }
  return [...agents, ...jobs, ...wrapped];
}
