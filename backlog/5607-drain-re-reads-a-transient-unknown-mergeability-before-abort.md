---
bornAs: xu4r9lk
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Drain re-reads a transient UNKNOWN mergeability before aborting a cascade candidate

Live 2026-10-09: accepted ready-to-merge PRs (#4602 46+ min, #4578, #4591) skipped every pass as unknown-mergeability/revalidationAborted. Each cascade merge moves main; GitHub resets other PRs' mergeable to UNKNOWN while it recomputes; the pre-merge fresh re-read seconds later saw UNKNOWN and refused the rest, so a pass landed 1-2 PRs. Fix: bounded re-read (4 x 3s, env WE_DRAIN_UNKNOWN_MERGEABLE_RETRIES) only for that refusal; fails closed as before.

## Acceptance

- [A1] **Executable** — `npm run test:unit` on we:scripts/__tests__/merge-ai-prs-revalidation-unknown-mergeability.test.mjs: fails on main (the retry helpers do not exist; a single UNKNOWN read refuses) and passes after.
- [A2] **Must refuse on error** — a fresh read that misses, moves the head, turns CONFLICTING or fails a check is refused at once, never retried; an UNKNOWN that never resolves within the bound returns the same refusal as before (tested).
- [A3] **Must keep every other input cautious** — only the classifier's own `not mergeable (mergeable=UNKNOWN)` refusal is retried; every merge-gate guard (head pin, required check, CodeQL, review hold, body) is re-evaluated on each re-read by the unchanged `revalidateForMerge`. No docs, config or data paths are involved.

Hint: the endpoint hint does not apply — no receive or write endpoint is added.

## Non-goals

- [N1] Does not change any merge-gate guard, the cascade order, or the pass-start classification; it only re-reads before a transient refusal stands.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reads GitHub's own `mergeable` field; no comment or body text decides the retry.
2. **Truncated reads** — a missed/unparseable read returns null and is refused at once (no retry).
3. **Shared state files** — n/a: no state written.
4. **Fail closed** — the bound (default 4 re-reads × 3 s) is hard; past it the UNKNOWN refusal stands.
5. **Identity scoping** — each re-read is pinned to the head the pass-start decision judged (`expectedHeadSha`).
6. **State over time** — a re-read reflects any change since (label removed, push, red check) and refuses on it.
7. **Who wrote it** — n/a: no authored input.
