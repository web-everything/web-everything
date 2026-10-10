/**
 * @file scripts/conveyor/accept-carry-sweep.mjs
 * @description Card xu7kxtt (#5472) — the review daemon's recovery pass for an operator clearance that a mechanical
 *   pass re-held after the head moved. Live #4535 (2026-10-09): cleared by the operator at fcc29ce1; the merge queue
 *   refreshed it onto main (143107a87, net diff byte-identical); the drain re-parked `review:human`; the review daemon
 *   then paused (`head 143107a87 was already reviewed 1 time(s)`), so the PR waited forever for a second approval.
 *
 *   PLAN (pure): a PR is a candidate when it carries `review:human` (no `review:changes`), its latest trusted accept
 *   record is a `clear-human` on an OLDER head, and no body-derived hold came after it. The candidate is handed to the
 *   ONE sanctioned writer, `review-set-label.mjs --to=restamp`, which re-reads the PR, computes the live net diff and
 *   carries the clearance only on a byte-identical strict reviewed-diff (`decideAcceptCarryForward`) AND only when the
 *   standing `review:human` is provably the drain's own mechanical park (`decideMechanicalHold`: its ledgered row paired
 *   with its label add), never a deliberate hold; otherwise it refuses and nothing changes. This sweep never touches a
 *   label itself, and it plans from the comment thread alone: the restamp CLI is the one authority on both proofs.
 *
 *   The child runs in the PR repo's OWN checkout (the CLI reads the net diff off its cwd); no checkout → not attempted.
 *   A DECISION (carried, or refused for a changed diff / unproven hold) is attempted once per PR head per process. A read
 *   miss (spawn error, timeout, gh failure, unreadable diff / timeline / ledger) is not a decision: it is retried with
 *   exponential backoff ({@link transientBackoffMs}, capped at 30 min) and never given up on.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveAcceptCarryForward, latestAcceptRecord } from '../lib/accept-carry-forward.mjs';
import { repoProfile } from '../lib/repo-profile.mjs';

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

/** Pure: which open PRs are owed a carry-forward attempt. */
export function planAcceptCarry(prs, { setting = 'off' } = {}) {
  if (setting !== 'on') return [];
  const out = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    const labels = names(pr?.labels);
    if (!labels.includes('review:human') || labels.includes('review:changes')) continue;
    const head = typeof pr?.headRefOid === 'string' ? pr.headRefOid.toLowerCase() : '';
    // Planning reads the thread only (no `reviews` channel here: the list call has none); the restamp CLI it dispatches reads
    // the PR's formal reviews itself and is the one authority on a standing review.
    const rec = latestAcceptRecord(pr?.comments);
    if (!rec || !rec.humanCleared || !head || rec.sha === head || rec.laterBodyDerivedHold || rec.laterVerdict) continue;
    out.push({ num: Number(pr.number), head, from: rec.sha });
  }
  return out;
}

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
    `--reason=head moved ${from} → ${head} by a mechanical pass; carry the operator clearance if the net diff is unchanged (card xu7kxtt)`],
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
 * IO shell. @returns {Array<{num:number, carry:'carried'|'refused'|'retry', detail:string}>}
 *   `retry` = a read miss / crash: not remembered as a refusal, tried again next tick (bounded).
 */
export function sweepAcceptCarry({ prs, repo = null, dryRun = false, setting = resolveAcceptCarryForward().value, runRestamp = defaultRunRestamp, now = Date.now } = {}) {
  const results = [];
  for (const c of planAcceptCarry(prs, { setting })) {
    const key = `${repo ?? ''}#${c.num}@${c.head}`;
    if (attempted.has(key)) continue;
    if (dryRun) { results.push({ num: c.num, carry: 'would-try', detail: `${c.from.slice(0, 9)} → ${c.head.slice(0, 9)}` }); continue; }
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
