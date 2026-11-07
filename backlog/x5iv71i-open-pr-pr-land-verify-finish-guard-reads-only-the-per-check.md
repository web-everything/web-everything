---
kind: story
size: 5
status: open
scope: ["we:scripts/pr-land.mjs", "we:scripts/lib/lane-verify.mjs", "we:scripts/verify-lane.mjs", "we:scripts/lib/review-ci-gate-io.mjs", "we:scripts/conveyor/reconcile-pass.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# open-pr/pr-land verify finish-guard reads only the per-checkout marker, though a sha-keyed green ledger exist…

Flow-sim gap R5a-G3, class K12 (identity keyed by location, not content). Failing input: Sha S verified green in lane-A (marker .lane-verify in lane-A's git dir; also a ledger record <coordinationRoot>we:verify-green/S.json, recorded by verify-lane for a clean default-gate green). A fixer or an open-pr caller runs in lane-B checked out at S (or a descendant whose lane-relevant set is unchanged).' 'open-pr / pr-land -… Cited: we:scripts/pr-land.mjs:967, we:scripts/pr-land.mjs:973, we:scripts/lib/lane-verify.mjs:221-225, we:scripts/lib/lane-verify.mjs:591-640, we:scripts/lib/lane-verify.mjs:194. Soak-break sketch: Fixture: temp coordination root with verify-green/<S>.json status green; lane clone B at S with no .lane-verify. Action: resolveFinishGuardVerdict (or pr-land --dry-run) from B. Assert: ok:true (ledger vouches for S). Fails today: status 'absent', refused.

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
