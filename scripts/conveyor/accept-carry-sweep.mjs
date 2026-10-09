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
 *   carries the clearance only on a byte-identical strict reviewed-diff (`decideAcceptCarryForward`); otherwise it
 *   refuses and nothing changes. This sweep never touches a label itself.
 *
 *   Attempted at most once per PR head per process: a refusal (changed diff) is not retried until the head moves.
 */
import { spawnSync } from 'node:child_process';

import { resolveAcceptCarryForward, latestAcceptRecord } from '../lib/accept-carry-forward.mjs';

const SET_LABEL = new URL('../review-set-label.mjs', import.meta.url).pathname;
const names = (labels) => (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
const attempted = new Set();

/** Pure: which open PRs are owed a carry-forward attempt. */
export function planAcceptCarry(prs, { setting = 'off' } = {}) {
  if (setting !== 'on') return [];
  const out = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    const labels = names(pr?.labels);
    if (!labels.includes('review:human') || labels.includes('review:changes')) continue;
    const head = typeof pr?.headRefOid === 'string' ? pr.headRefOid.toLowerCase() : '';
    const rec = latestAcceptRecord(pr?.comments);
    if (!rec || !rec.humanCleared || !head || rec.sha === head || rec.laterBodyDerivedHold) continue;
    out.push({ num: Number(pr.number), head, from: rec.sha });
  }
  return out;
}

function defaultRunRestamp({ repo, num, head, from }) {
  const r = spawnSync(process.execPath, [SET_LABEL, String(num), ...(repo ? [`--repo=${repo}`] : []), '--to=restamp',
    '--actor=review-daemon', '--channel=accept-carry-forward',
    `--reason=head moved ${from} → ${head} by a mechanical pass; carry the operator clearance if the net diff is unchanged (card xu7kxtt)`],
  { encoding: 'utf8', timeout: 180_000 });
  const last = String(r.stdout || r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`;
  return { ok: r.status === 0, detail: last.slice(0, 300) };
}

/**
 * IO shell. @returns {Array<{num:number, carry:'carried'|'refused', detail:string}>}
 */
export function sweepAcceptCarry({ prs, repo = null, dryRun = false, setting = resolveAcceptCarryForward().value, runRestamp = defaultRunRestamp } = {}) {
  const results = [];
  for (const c of planAcceptCarry(prs, { setting })) {
    const key = `${repo ?? ''}#${c.num}@${c.head}`;
    if (attempted.has(key)) continue;
    if (dryRun) { results.push({ num: c.num, carry: 'would-try', detail: `${c.from.slice(0, 9)} → ${c.head.slice(0, 9)}` }); continue; }
    attempted.add(key);
    let r;
    try { r = runRestamp({ repo, ...c }); } catch (e) { r = { ok: false, detail: String(e?.message ?? e).split('\n')[0] }; }
    results.push({ num: c.num, carry: r.ok ? 'carried' : 'refused', detail: r.detail });
  }
  return results;
}

/** Test seam: forget the once-per-head memory. */
export function _resetAcceptCarryMemo() { attempted.clear(); }
