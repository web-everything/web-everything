---
bornAs: x38tlu2
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/main-red-recovery.mjs", "we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs", "we:scripts/conveyor/__tests__/main-red-recovery.test.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Prevention — Route every consumer of the rebase and missing-run caps through one shared resolver and one count… (from web-everything/web-everything#4825 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/main-red-recovery.mjs:863` — Route every consumer of the rebase and missing-run caps through one shared resolver and one counter wrapper that takes main state. Add a parity test over those consumers that fails when a call site omits the options.
2. `we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs` — Add a deterministic parameterized test placing the sole live claim at each chain position and asserting zero refreshes and fetches before deferral.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4825@64e2e751f1d4448ec8eeda030b060e0da3db6fa9

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
