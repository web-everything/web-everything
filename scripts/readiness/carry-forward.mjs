// carry-forward — the PURE closeout status-reconciliation decision for the /workflow (parallel) orchestrator.
//
// CANONICAL, TESTED home of the carry-forward / reopen logic (proved by `__tests__/carry-forward.test.mjs`).
// The orchestrator `we:.claude/skills/batch-backlog-items/parallel-execute.workflow.js` runs in the Workflow
// JS sandbox (no `import`, no fs), so it INLINE-MIRRORS these functions — keep the two in sync; this module +
// its test are the spec. Same pattern as `lane-partition.mjs`.
//
// THE PROBLEM (#2072/#2086). Every batched item is flipped `open→active` at the central pre-claim (Phase 2),
// but ONLY items whose lane LANDED get flipped to `resolved`. An item that failed to integrate — a serial-lane
// carry/drop, a WE-only replay that never landed, a cross-repo-partial, or a reconcile-reclassified
// `stranded` — is otherwise left `status: active` on WE main with NO claim in claims.json. That is a FALSE
// ownership signal: `readiness --select` excludes an `active` item as "owned", so it silently drops out of the
// pool though nobody is working it. Closeout must reconcile every such entry back to `open` so it honestly
// re-enters the next pack.
//
// THE DECISION (the bug-prone part this extraction makes reviewable — a wrong call cascades across 12+ items
// per batch, as the 2026-07-01 closeout showed):
//   • An item is REOPENED iff it did NOT resolve (`status !== 'resolved'`) AND this run is the one that flipped
//     it active (`claimedThisRun` membership). The claim-scope is the safety boundary (#2072): never touch an
//     item another session owns. As a legacy fallback, an EMPTY `claimedThisRun` means "scope unknown" → reopen
//     every un-resolved entry (the pre-#2072 behaviour); a non-empty set makes the boundary structural.
//   • `dropped:"taken"` cannot occur in this set — setup skips already-active items — but the claim-scope
//     filter makes that structural rather than incidental.
//   • Dedup by num: a cross-repo item appears once per repo in the ledger, but is one backlog card to reopen.

// The terminal outcome of one ledger entry, for reporting + the reopen decision. Pure.
//   'resolved'  — landed clean (counted in the burndown).
//   'reopen'    — un-resolved AND this run claimed it → flip active→open at closeout.
//   'foreign'   — un-resolved but NOT claimed by this run (another session owns it) → leave untouched.
export function classifyEntry(entry, claimedThisRun) {
  if (entry?.status === 'closed') return 'closed';
  if (!entry || entry.status === 'resolved') return 'resolved';
  const claimedKnown = claimedThisRun && claimedThisRun.size > 0;
  if (!claimedKnown) return 'reopen'; // scope unknown → legacy: reopen every un-resolved entry
  return claimedThisRun.has(String(entry.num)) ? 'reopen' : 'foreign';
}

// The deduped, ordered set of item nums to reopen (active→open) at closeout. `ledger` is the run's item
// results ({ num, status, … }); `claimedThisRun` is the Set of nums THIS run flipped open→active at pre-claim.
// Pure + deterministic (preserves first-seen ledger order) so the workflow and its test agree exactly.
export function computeReopenSet(ledger, claimedThisRun) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(ledger) ? ledger : []) {
    if (!entry) continue;
    if (classifyEntry(entry, claimedThisRun) !== 'reopen') continue;
    const num = String(entry.num);
    if (seen.has(num)) continue;
    seen.add(num);
    out.push(num);
  }
  return out;
}

// Full closeout partition of a ledger into { resolved, reopen, foreign } num-lists (deduped, order-preserving)
// — the reviewable one-call summary of where every item ended up. `reopen` is exactly `computeReopenSet`.
export function partitionCloseout(ledger, claimedThisRun) {
  const buckets = { resolved: [], closed: [], reopen: [], foreign: [] };
  const seen = { resolved: new Set(), closed: new Set(), reopen: new Set(), foreign: new Set() };
  for (const entry of Array.isArray(ledger) ? ledger : []) {
    if (!entry) continue;
    const bucket = classifyEntry(entry, claimedThisRun);
    const num = String(entry.num);
    if (seen[bucket].has(num)) continue;
    seen[bucket].add(num);
    buckets[bucket].push(num);
  }
  return buckets;
}
