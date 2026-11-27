---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:src/wip/wip-feeds.test.ts"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Confirm the CI job has a step-level timeout. Better, add a deterministic negative test (feed wired to a n… (from plateauapp/plateau-app#248 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:src/wip/wip-feeds.test.ts:146` — Confirm the CI job has a step-level timeout. Better, add a deterministic negative test (feed wired to a never-emitting source fails by assertion) or a gate requiring the verify step to set a job timeout.
2. `we:src/wip/wip-feeds.test.ts:120` — Have the card template split 'evidence (one-off)' from 'guarantees (each with a named test)', and add a standards lint that requires a test name per guarantee bullet.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#248@7fe5fa0ba7016073c7654872a19ff978bacad415

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
