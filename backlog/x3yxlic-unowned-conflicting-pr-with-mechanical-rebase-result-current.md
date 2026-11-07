---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/parked-pr-conflict-watch.mjs", "we:scripts/lib/rebase-drop-manifest.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Unowned conflicting PR with mechanical-rebase result 'current' is retried every sweep, uncounted and unlabell…

Flow-sim gap R9a-G4, class K14 (progress counter counts only successes). Failing input: Open PR, no review:* / ready-to-merge label, base main, GitHub mergeable CONFLICTING (stale/cached), local git merge-tree clean. 'Each sweep: computeConflictDisposition returns 'clean', rebaseDropManifest returns action 'current' (tip already on origin/main, manifest-free). Cited: we:scripts/conveyor/parked-pr-conflict-watch.mjs:1432-1433, we:scripts/conveyor/parked-pr-conflict-watch.mjs:1907-1909, we:scripts/conveyor/parked-pr-conflict-watch.mjs:1922-1923, we:scripts/conveyor/parked-pr-conflict-watch.mjs:1943-1949, we:scripts/lib/rebase-drop-manifest.mjs:240-245. Soak-break sketch: Fixture: unowned CONFLICTING PR, computeConflictDisposition => 'clean', attemptMechanicalRebase => {action:'current'}. Action: run 5 sweeps. Assert (fails today): after N sweeps a durable marker/note exists or the label is applied; today nothing is written.

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
