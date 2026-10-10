---
bornAs: xgqwuq5
kind: story
size: 5
priority: high
status: resolved
scope: ["we:scripts/verify-lane.mjs", "we:scripts/lib/verify-lane-gate.mjs", "we:scripts/readiness/test-selection.mjs", "we:scripts/lib/lane-verify.mjs", "we:scripts/lib/verify-settings.mjs", "we:scripts/verify-settings.json"]
dateOpened: "2026-10-09"
dateResolved: "2026-10-09"
tags: []
---

# Incremental verify for fix rounds: since-last-green test selection

Fix rounds re-select tests from the whole PR diff vs origin/main (we:scripts/verify-lane.mjs via we:scripts/lib/verify-lane-gate.mjs#resolveDefaultGate), median ~4.3 min tests + ~1.8 min check:standards per round. Add verify.selection = pr | since-last-green (default since-last-green, policy cascade in we:scripts/lib/verify-settings.mjs): when an earlier head of this PR has a clean-tree default-gate green (recorded in a shared green ledger written beside the lane marker), select tests and scope check:standards from <green>..HEAD, only when green is an ancestor of HEAD, no merge commits in the range, and the merge-base with origin/main is unchanged; otherwise fall back to full-PR selection; a blocked delta (config/deps) falls back too. describeGate logs the mode and why. CI and the merge gate are unchanged; markers stay keyed to the exact HEAD.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/verify-since-last-green.test.mjs` fails before (no `selection` setting, no ledger) and passes after: a fixer-only commit after a ledger green selects only the delta; a main merge, a rebase, a missing/red/torn ledger record, and a config change in the delta all fall back to whole-PR selection; the marker for an earlier head never satisfies the gate for HEAD.
- [A2] **Wiring** — `we:scripts/__tests__/verify-lane.test.mjs` ("a green records the ledger…"): a real `verify` green writes the ledger record and the next `request` logs `selection mode: since-last-green — delta <sha>..HEAD only`; `WE_VERIFY_SELECTION=pr` logs `selection mode: pr`.
- [A3] **Must refuse on error** — any git failure, unreadable ledger, non-ancestor green, merge commit in range, or moved merge-base selects the whole PR (today's gate), never a narrower one.
- [A4] **Must treat non-code inputs cautiously** — a delta touching config/deps (`LOCAL_FULL_SUITE_TRIGGERS`) is resolved under the whole-PR rules; check:standards is scoped to the delta under the existing policy only.

## Non-goals

- [N1] CI and the merge gate are unchanged (CI still runs the full required suite; pr-land still needs a green marker for the exact HEAD).
- [N2] No ledger pruning yet (one ~200-byte file per clean green; revisit if the directory grows past ~10k files).

## Edge cases this change must handle

1. **Untrusted text** — ledger keys must be 40-hex shas (path traversal refused); records are parsed as JSON and must name the same sha with status green.
2. **Truncated reads** — a torn/partial ledger file parses as invalid and means "no green" (whole-PR selection).
3. **Shared state files** — ledger writes are atomic (temp + rename) into `<coordination root>/verify-green/`; written only from pool lanes (`/.lanes/`) or an explicit `WE_VERIFY_GREEN_LEDGER_DIR`, so test fixtures never write there.
4. **Fail closed** — every unknown falls back to the whole-PR selection (A3).
5. **Identity scoping** — a record is keyed by commit sha; it only counts when that sha is a strict ancestor of HEAD within this PR's own commits (same merge-base, no merges).
6. **State over time** — a green recorded with a dirty tree, an explicit `--gate=` override, or a whole-gate admission fallback, or a run that skipped its gate (the card-only skip) is never recorded, so a ledger entry always describes the commit itself under the default gate.
7. **Who wrote it** — a forged record can only narrow a LOCAL selection; it never blesses a landing (marker keyed to HEAD) and CI still runs everything. The card-only skip is judged on the WHOLE PR (CI's definition), never on the delta: a doc-only fixer commit on a PR that carries code still runs a (delta) gate.
