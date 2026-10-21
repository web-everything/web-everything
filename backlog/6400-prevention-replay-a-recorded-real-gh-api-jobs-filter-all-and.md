---
bornAs: xf8uerk
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/red-main-quarantine-io.mjs", "we:scripts/conveyor/health-smells/red-main-quarantined-test.mjs", "we:scripts/lib/red-main-quarantine.mjs", "we:scripts/lib/__tests__/red-main-quarantine-io.test.mjs", "we:scripts/conveyor/health-smells/__tests__/red-main-quarantined-test.test.mjs", "we:scripts/lib/__tests__/red-main-quarantine.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Replay a recorded real gh api …/jobs?filter=all and filter=latest pair for a re-run in the fixtur… (from web-everything/web-everything#5283 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/red-main-quarantine-io.mjs:175` — Replay a recorded real `gh api …/jobs?filter=all` and `filter=latest` pair for a re-run in the fixture. Assert both that rerun-passed fires only where a job is both failing and has a later green attempt, and that the real data cannot produce that state.
2. `we:scripts/conveyor/health-smells/red-main-quarantined-test.mjs:16` — Add a test that resolves settings with `fileCardPerEntry` false and asserts that both the plan and the smell stay silent. Alternatively, make the smell read the same resolved setting through the safety-net result.
3. `we:scripts/lib/red-main-quarantine.mjs:170` — Add a we:ci.yml contract test: every job matched by `unitJobPattern` must have a step invoking `quarantine-skip` with the matching `--job`. File it as the first item of the wiring follow-up so the mode flip is gated on it.
4. `we:scripts/conveyor/health-smells/red-main-quarantined-test.mjs:18` — Add a deterministic integration test that passes an explicitly false fileCardPerEntry setting through the safety net and filing smell and asserts zero filing signs, with a true-setting control asserting a sign.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5283@1014f5d0b22c3bdaf8046d9c91e7000224bcd5a4

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
