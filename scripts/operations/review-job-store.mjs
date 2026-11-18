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

import { pidAlive } from '../lib/pid-alive.mjs';

import { defaultListAgents } from './dispatch-lane-io.mjs';
import { listWrappedWorkerAgents } from './worker-wrapper-launch.mjs';

export { pidAlive } from '../lib/pid-alive.mjs';

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
 * NEVER throws: missing directories mean no jobs; unreadable evidence carries an incomplete marker.
 */
export function listReviewJobAgents({ dir = reviewJobsDir(), isAlive = pidAlive, readOnly = false } = {}) {
  let names;
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json') && !n.endsWith('.exit.json') && !n.endsWith('.ended.json')); } catch (error) {
    return error?.code === 'ENOENT' ? [] : incompleteListing('review-jobs-unreadable');
  }
  const rows = [];
  const incomplete = [];
  for (const name of names) {
    const slug = name.slice(0, -'.json'.length);
    const rec = SLUG_RE.test(slug) ? readJobRecord(slug, dir) : null;
    if (!rec || rec.slug !== slug || !Number.isInteger(rec.pid) || rec.pid <= 0) { incomplete.push('review-job-unreadable'); continue; }
    let alive;
    try { alive = isAlive(rec.pid); } catch { /* Unknown liveness is incomplete evidence. */ }
    if (typeof alive !== 'boolean') { incomplete.push('review-job-liveness-unknown'); continue; }
    if (!alive) { if (!readOnly) try { rmSync(join(dir, name), { force: true }); } catch { /* best effort */ } continue; }
    rows.push(jobRecordToAgentRow(rec));
  }
  return incomplete.length ? Object.defineProperty(rows, 'incomplete', { value: incomplete }) : rows;
}

function incompleteListing(reason) {
  return Object.defineProperty([], 'incomplete', { value: [reason] });
}

/**
 * `claude agents --json` + the live review jobs + (117 S3b) the wrapped run-to-completion workers — the ONE merged
 * listing reconcile and review-status-tag read. A wrapped fix / ci-heal / review has no `claude agents` row; its v2
 * completion record stands in for one (`worker-wrapper-launch.mjs#listWrappedWorkerAgents`).
 */
export function listAgentsWithReviewJobs({
  readOnly = false, listAgents = () => defaultListAgents(), listJobs = opts => listReviewJobAgents(opts), listWrapped = () => listWrappedWorkerAgents(),
} = {}) {
  const listed = listAgents();
  const agents = Array.isArray(listed) ? listed : incompleteListing('agents-unreadable');
  let jobs = [];
  try { jobs = readOnly ? listJobs({ readOnly: true }) : listJobs(); }
  catch { jobs = incompleteListing('review-jobs-unreadable'); }
  if (!Array.isArray(jobs)) jobs = incompleteListing('review-jobs-unreadable');
  // Not swallowed, unlike `jobs`: a wrapped fix / ci-heal / review is a live-session population readers decide on by its
  // ABSENCE (no live fixer -> dispatch one), so a failed listing aborts the read exactly as a failed `claude agents` does.
  const wrappedResult = listWrapped();
  const wrapped = Array.isArray(wrappedResult) ? wrappedResult : incompleteListing('wrapped-workers-unreadable');
  const merged = [...agents, ...jobs, ...wrapped];
  // A spread drops non-enumerable evidence from every source, not only wrapped workers.
  const gaps = [agents, jobs, wrapped].filter(rows => Object.hasOwn(rows, 'incomplete'))
    .map(rows => rows.incomplete?.length ? rows.incomplete : ['agents-incomplete']);
  return gaps.length ? Object.defineProperty(merged, 'incomplete', { value: gaps.length === 1 ? gaps[0] : gaps.flat() }) : merged;
}
