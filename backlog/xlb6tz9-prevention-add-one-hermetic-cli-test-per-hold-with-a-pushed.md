---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/merge-ai-prs-net-diff-computation.test.mjs", "we:scripts/__tests__/pr-merge-gate.test.mjs", "we:scripts/lib/pr-merge-gate.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/__tests__/pr-merge-gate.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add one hermetic CLI test per hold, with a pushed-after-listing head and an empty diff, and one f… (from web-everything/web-everything#7222 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/merge-ai-prs-net-diff-computation.test.mjs:996` — Add one hermetic CLI test per hold, with a pushed-after-listing head and an empty diff, and one for a no-clone sibling-repo PR that must stay clean. Where practical, replace the source-regex wiring tests with a behavioural check.
2. `we:scripts/__tests__/pr-merge-gate.test.mjs:599` — When adding a negative test for a strengthening, run each case against the base and keep only the cases that are red there.
3. `we:scripts/lib/pr-merge-gate.mjs:183` — Pass `--src-prefix=a/ --dst-prefix=b/` (or `--default-prefix`) in the computeNetDiffText argv, and add the flags to its argv assertion test.
4. `we:scripts/merge-ai-prs.mjs:6684` — Add one CLI-level negative test per hold reason (failing diff, head mismatch, no-clone preserved). Also add a standards rule that wiring regex tests must be paired with a behavioural test for any new hold branch.
5. `we:scripts/lib/pr-merge-gate.mjs:199` — Pass explicit `--src-prefix=a/ --dst-prefix=b/` in computeNetDiffText, and add an argv-pin test beside the existing `--no-ext-diff` one.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7222@ca2e3d37fc93ee0cadc8ece933dcb3e6a4dde866

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
