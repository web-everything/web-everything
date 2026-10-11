/**
 * @file scripts/conveyor/accept-carry-sweep.mjs
 * @description Card xu7kxtt (#5472) — the review daemon's recovery pass for an operator clearance that a mechanical
 *   pass re-held after the head moved. Live #4535 (2026-10-09): cleared by the operator at fcc29ce1; the merge queue
 *   refreshed it onto main (143107a87, net diff byte-identical); the drain re-parked `review:human`; the review daemon
 *   then paused (`head 143107a87 was already reviewed 1 time(s)`), so the PR waited forever for a second approval.
 *
 *   PLAN (pure): a PR is a candidate when it carries the drain's own mechanical park, `review:held-mechanical` (PR #4631,
 *   operator ruling 2026-10-10 ~14:20 ET, option a: a label only the drain writes, so its presence proves the hold is
 *   mechanical), and NO `review:human` (a person's hold, never removed automatically, whenever it was set) nor
 *   `review:changes` — whatever its thread says and whatever the setting (see {@link planAcceptCarry}). The candidate is
 *   handed to the ONE sanctioned writer, `review-set-label.mjs --to=restamp`, which re-reads the full thread and formal
 *   reviews, computes the live net diff and lifts the drain's label only on a proven carry of a `clear-human` record
 *   (`decideAcceptCarryForward`); on a decided refusal it hands the hold to the operator (`review:human`), on a read miss
 *   it leaves it for a retry. This sweep never touches a label itself: the restamp CLI is the one authority on the proof.
 *
 *   The child runs in the PR repo's OWN checkout (the CLI reads the net diff off its cwd); no checkout → not attempted.
 *   A DECISION (carried, or refused for a changed diff / unproven hold) is attempted once per PR head per process. A read
 *   miss (spawn error, timeout, gh failure, unreadable diff / reviews / thread) is not a decision: it is retried with
 *   exponential backoff ({@link transientBackoffMs}, capped at 30 min) and never given up on.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveAcceptCarryForward, latestAcceptRecord } from '../lib/accept-carry-forward.mjs';
import { repoProfile } from '../lib/repo-profile.mjs';
import { REVIEW_LABELS } from '../lib/review-escalation.mjs';

const SET_LABEL = new URL('../review-set-label.mjs', import.meta.url).pathname;
const names = (labels) => (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
/** Heads whose outcome is settled (carried, or refused by a DECISION): never re-attempted until the head moves. */
const attempted = new Set();
/** Heads that only hit a read miss / crash: `{ n, next }` — retried with exponential backoff, never given up on (an outage
 *  longer than any fixed attempt count must not strand the PR on `review:human`). */
const transient = new Map();
export const TRANSIENT_BACKOFF_BASE_MS = 60_000;
export const TRANSIENT_BACKOFF_MAX_MS = 30 * 60_000;
export const transientBackoffMs = (n) => Math.min(TRANSIENT_BACKOFF_BASE_MS * 2 ** Math.max(0, n - 1), TRANSIENT_BACKOFF_MAX_MS);

/**
 * Pure: which open PRs are owed a carry-forward attempt. EVERY PR standing on the drain's mechanical park (and no
 * `review:human` / `review:changes`) is planned, whatever its thread says and whatever the setting: the restamp CLI is the
 * ONE decider, and it either lifts the drain label (proven carry) or hands the hold to the operator (any decided refusal,
 * incl. the setting off). A thread-only pre-filter here would disagree with the CLI's full read (the list call caps
 * comments and has no reviews) and strand the PR on a drain label no operator view shows (PR #4631 round 10 self-review).
 * `setting` is kept for the callers' signature; it no longer gates planning.
 */
export function planAcceptCarry(prs, { setting: _setting = 'off' } = {}) {
  const out = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    const labels = names(pr?.labels);
    if (!labels.includes(REVIEW_LABELS.heldMechanical) || labels.includes(REVIEW_LABELS.human) || labels.includes(REVIEW_LABELS.changes)) continue;
    const head = typeof pr?.headRefOid === 'string' ? pr.headRefOid.toLowerCase() : '';
    if (!head) continue;
    // `from` only labels the log line / reason; the CLI re-reads the full thread and formal reviews itself.
    const rec = latestAcceptRecord(pr?.comments);
    out.push({ num: Number(pr.number), head, from: rec?.sha ?? null });
  }
  return out;
}

const short = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 9) : 'unknown');

/**
 * The checkout of `repo` the restamp child must run in. `review-set-label --to=restamp` reads the net diff off the
 * process cwd and its `--body-file` allowlist is rooted there too, so the cwd IS the repo contract (the same rule
 * `restampAcceptance` in merge-ai-prs.mjs follows with its `cloneDir`). A null `repo` means the daemon's own cwd repo.
 * @returns {string|null|undefined} the checkout path; `undefined` = inherit cwd (no repo named); `null` = none provisioned.
 */
export function defaultCloneDirFor(repo, { profileOf = repoProfile, exists = existsSync } = {}) {
  if (!repo) return undefined;
  const dir = profileOf(repo)?.checkoutPath;
  return dir && exists(join(dir, '.git')) ? dir : null;
}

/**
 * Runs the sanctioned restamp in `repo`'s own checkout and classifies the outcome. `retryable` = the attempt says
 * nothing about the PR (no checkout provisioned, spawn error / timeout / signal, a gh or crash failure, or the CLI's
 * own `retryable` refusal for a read miss); only a printed DECISION (`refused:true`) without it is settled.
 */
export function defaultRunRestamp({ repo, num, head, from }, { spawn = spawnSync, cloneDirFor = defaultCloneDirFor } = {}) {
  const cwd = cloneDirFor(repo);
  if (cwd === null) return { ok: false, retryable: true, detail: `no ${repo} checkout provisioned; not attempted` };
  const r = spawn(process.execPath, [SET_LABEL, String(num), ...(repo ? [`--repo=${repo}`] : []), '--to=restamp',
    '--actor=review-daemon', '--channel=accept-carry-forward',
    `--reason=head moved ${from || 'unknown'} → ${head} by a mechanical pass; carry the operator clearance if the net diff is unchanged (card xu7kxtt)`],
  { encoding: 'utf8', timeout: 180_000, ...(cwd ? { cwd } : {}) });
  const last = String(r.stdout || r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`;
  const detail = last.slice(0, 300);
  if (r.status === 0) return { ok: true, detail };
  if (r.error || r.status === null || r.signal) return { ok: false, retryable: true, detail: r.error ? String(r.error.message ?? r.error).split('\n')[0] : detail };
  let printed = null;
  try { printed = JSON.parse(last); } catch { /* not a decision */ }
  const decided = printed && typeof printed === 'object' && printed.refused === true;
  return { ok: false, retryable: !decided || printed.retryable === true, detail };
}

/**
 * IO shell. @returns {Array<{num:number, carry:'carried'|'refused'|'retry'|'would-try', detail:string}>}
 *   `retry` = a read miss / crash: not remembered as a refusal, retried with backoff and never given up on (see the
 *   file header). `would-try` = dry run.
 */
export function sweepAcceptCarry({ prs, repo = null, dryRun = false, setting = resolveAcceptCarryForward().value, runRestamp = defaultRunRestamp, now = Date.now } = {}) {
  const results = [];
  for (const c of planAcceptCarry(prs, { setting })) {
    const key = `${repo ?? ''}#${c.num}@${c.head}`;
    if (attempted.has(key)) continue;
    if (dryRun) { results.push({ num: c.num, carry: 'would-try', detail: `${short(c.from)} → ${short(c.head)}` }); continue; }
    if ((transient.get(key)?.next ?? 0) > now()) continue; // still backing off after a read miss
    let r;
    try { r = runRestamp({ repo, ...c }); } catch (e) { r = { ok: false, retryable: true, detail: String(e?.message ?? e).split('\n')[0] }; }
    if (r.ok || !r.retryable) { attempted.add(key); transient.delete(key); } else {
      const n = (transient.get(key)?.n ?? 0) + 1;
      transient.set(key, { n, next: now() + transientBackoffMs(n) });
    }
    results.push({ num: c.num, carry: r.ok ? 'carried' : r.retryable ? 'retry' : 'refused', detail: r.detail });
  }
  return results;
}

/** Test seam: forget the once-per-head memory. */
export function _resetAcceptCarryMemo() { attempted.clear(); transient.clear(); }
