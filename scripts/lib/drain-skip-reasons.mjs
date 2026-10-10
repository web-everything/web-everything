/**
 * @file scripts/lib/drain-skip-reasons.mjs
 * @description Card 122 slice 1 — WHY each considered PR did not land in a drain pass. Pure, no I/O: LOGGING ONLY,
 *   it changes no merge decision. `we:scripts/merge-ai-prs.mjs` feeds it the pass's own buckets and gets back one
 *   structured row per considered-but-not-landed PR, which rides `result.skipReasons` (the `--json` output), a
 *   one-line stderr summary (the only channel that reaches the daemon log), and the same JSON on a
 *   `merge-ai-prs · skip-reasons: {...}` line a coroner / perf-snapshot can grep and parse.
 *
 * Row shape: `{ num, repo, kind, reason, source }`. `kind` is a short stable code (see KINDS); `reason` is the
 * drain's own verbatim text; `source` names the bucket it came from.
 */

export const SKIP_KINDS = Object.freeze([
  'unknown-mergeability', 'conflicting', 'behind', 'checks-pending', 'review-hold', 'cap', 'head-moved',
  'couple-held', 'blocked-by', 'overlap-yield', 'rebuilt-pending-ci', 'merge-failed', 'parked',
  // Former "other" bucket, now named: every skip says which rule held it.
  'not-certified', 'off-base', 'codeql-failed', 'empty-body', 'stale-read', 'escalated',
  'partner-pending', 'ready-not-reached', 'red-main-hold', 'unrecognized-reason',
]);

/** Map a drain reason string to a stable kind. Order matters: the most specific signal wins. */
export function classifySkipReason(reason) {
  const r = String(reason ?? '');
  if (/^red-main-hold\b/.test(r)) return 'red-main-hold'; // we:scripts/lib/red-main-hold.mjs — main is red, only the fix PR lands
  if (/mergeable=UNKNOWN|merge state UNKNOWN/i.test(r)) return 'unknown-mergeability';
  if (/mergeable=CONFLICTING|DIRTY/.test(r) && !/BEHIND⇒/.test(r)) return 'conflicting';
  if (/\bBEHIND\b/.test(r)) return 'behind';
  if (/review hold|review:(changes|human|pending)|awaiting review|review acceptance/i.test(r)) return 'review-hold';
  if (/required check .* (is not green|direct read failed)|checks? pending|not green/i.test(r)) return 'checks-pending';
  if (/^head moved|head moved since/i.test(r)) return 'head-moved';
  if (/\bcap\b|max-merges|merge limit/i.test(r)) return 'cap';
  if (/^not AI-generated|not human-cleared/.test(r)) return 'not-certified';
  if (/^base is not /.test(r)) return 'off-base';
  if (/CodeQL/i.test(r)) return 'codeql-failed';
  if (/empty\/whitespace description/.test(r)) return 'empty-body';
  if (/could not re-read the PR fresh|head SHA .*unknown|fresh re-read carried no head/.test(r)) return 'stale-read';
  if (/tamper|test-gaming|escalat/i.test(r)) return 'escalated';
  // Still named, never "other": the verbatim reason rides on the row so the next rule is a one-line addition.
  return 'unrecognized-reason';
}

const keyOf = (x) => `${x?.repo ?? ''}#${x?.num}`;

/**
 * @param {object} p
 * @param {Array<{num,repo?,decision?,reason?}>} p.verdicts  every PR considered this pass
 * @param {Array<{num,repo?}>} [p.merged]
 * @param {Array<{num,repo?,detail?}>} [p.failedMerges]
 * @param {Array<{num,repo?,reason}>} [p.revalidationAborted]
 * @param {Array<number>} [p.pendingRebased]
 * @param {Array<{num,repo?,reason?,role?}>} [p.coupleHeld]
 * @param {Array<{num,repo?,waitOn?,overlapYield?}>} [p.deferred]
 * @param {Array<{num,repo?,reasons?}>} [p.parked]
 * @returns {Array<{num:number,repo:string|null,kind:string,reason:string,source:string}>}
 */
export function buildSkipReasons({ verdicts = [], merged = [], failedMerges = [], revalidationAborted = [], pendingRebased = [], coupleHeld = [], deferred = [], parked = [] } = {}) {
  const landed = new Set(merged.map(keyOf));
  const rows = new Map();
  const put = (x, kind, reason, source) => {
    const k = keyOf(x);
    if (landed.has(k) || rows.has(k)) return; // the first (most specific) bucket wins; a landed PR has no skip reason
    rows.set(k, { num: Number(x.num), repo: x.repo ?? null, kind, reason: String(reason ?? ''), source });
  };
  for (const x of failedMerges) put(x, 'merge-failed', x.detail, 'failedMerges');
  for (const x of revalidationAborted) put(x, classifySkipReason(x.reason), x.reason, 'revalidationAborted');
  const rebased = new Set(pendingRebased.map(Number));
  for (const v of verdicts) if (rebased.has(Number(v.num))) put(v, 'rebuilt-pending-ci', 'rebuilt onto main this pass; checks re-running, lands on a later pass', 'pendingRebased');
  for (const x of coupleHeld) put(x, 'couple-held', x.reason, 'coupleHeld');
  for (const x of deferred) {
    const wait = (x.waitOn || []).map(String);
    if (x.overlapYield || wait.some((w) => w.startsWith('overlap-yield:'))) put(x, 'overlap-yield', wait.join(', '), 'deferred');
    else put(x, 'blocked-by', `blockedBy unlanded: ${wait.join(', ')}`, 'deferred');
  }
  for (const x of parked) put(x, 'parked', (x.reasons || []).join('; '), 'parked');
  for (const v of verdicts) {
    if (v.decision === 'merge') continue;
    let kind = classifySkipReason(v.reason);
    if (kind === 'unrecognized-reason' && v.escalated === 'yes') kind = 'escalated';
    put(v, kind, v.reason, 'skipped');
  }
  // Listed ready at pass start but never landed and never reported by a bucket above. Name the cause: a couple
  // partner (same item) that did not land, else the pass simply ended before reaching it.
  for (const v of verdicts) {
    if (v.decision !== 'merge') continue;
    const partner = v.item == null ? null : verdicts.find((o) => o !== v && o.item != null && String(o.item) === String(v.item)
      && keyOf(o) !== keyOf(v) && !landed.has(keyOf(o)));
    if (partner) {
      const pr = rows.get(keyOf(partner));
      put(v, 'partner-pending', `couple partner ${keyOf(partner)} did not land (${pr ? pr.kind : 'ready, not reached'}${pr?.reason ? `: ${pr.reason}` : ''})`, 'unaccounted');
    } else {
      put(v, 'ready-not-reached', 'ready at pass start; the pass ended before it was reached (cap, budget or dependency order)', 'unaccounted');
    }
  }
  return [...rows.values()];
}

/** One-line human summary, e.g. `skipped 2: #12 unknown-mergeability, #14 review-hold`. */
export function formatSkipSummary(rows) {
  if (!rows || !rows.length) return 'skipped 0';
  return `skipped ${rows.length}: ${rows.map((r) => `#${r.num} ${r.kind}`).join(', ')}`;
}

/** The machine-readable stderr line (the daemon log is the only channel that survives `--json`). */
export function formatSkipReasonsLine(rows) {
  return `merge-ai-prs · skip-reasons: ${JSON.stringify(rows || [])}`;
}
