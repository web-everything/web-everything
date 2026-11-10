---
bornAs: xuj1xr3
kind: story
size: 3
status: open
related: ["5586"]
scope: ["we:scripts/conveyor/supersede-watch.mjs", "we:scripts/conveyor/supersede-rule.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Supersede watch reads only the newest 200 merged PRs and 200 open PRs; absence is read as 'no marker' (cap an…

Flow-sim gap R9b-G3, class K17 (partial page read as complete). Failing input: Repo merges more than 200 PRs inside the lookback window (live PR numbers advance ~65/day), or has more than 200 open PRs. #B merged earlier with 'Supersedes: #A'; #A still open.' 'Every tick: defaultReadMergedPrs gets 200 newest, window filter applied after the cap; #B is not in the 200, so no marker is read. Open list capped … Cited: we:scripts/conveyor/supersede-watch.mjs:25, we:scripts/conveyor/supersede-rule.mjs:34, we:scripts/conveyor/supersede-rule.mjs:336-340. Soak-break sketch: fixture: readMergedPrs stub returning 200 unrelated merged rows newer than the marker row (marker row merged 5 days ago); openNumbers includes #A. action: runSupersedeWatch with a stub exec that honours --limit. assert holds contains {pr:A, by:B} - today empt…

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
