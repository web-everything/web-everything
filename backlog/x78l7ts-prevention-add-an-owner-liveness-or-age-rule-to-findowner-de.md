---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/main-ci-red-core.mjs", "we:scripts/conveyor/health-smells/__tests__/main-ci-red.test.mjs", "we:scripts/conveyor/__tests__/main-ci-red-core.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add an owner-liveness or age rule to findOwner/decideOwner (a 'dispatched' entry with no live ses… (from web-everything/web-everything#4527 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/main-ci-red-core.mjs:343` — Add an owner-liveness or age rule to findOwner/decideOwner (a 'dispatched' entry with no live session and no owning PR after N minutes re-opens the owner or escalates). Add a replay test where the owner session vanishes mid-window.
2. `we:scripts/conveyor/health-smells/__tests__/main-ci-red.test.mjs:197` — Spawn two real child processes against one temp dir, or inject a lock seam that records acquisition. Assert the lock is taken around the reserve step.
3. `we:scripts/conveyor/main-ci-red-core.mjs` — Add a deterministic graph regression test covering acyclic chains and use actual cycle detection when selecting PRs to combine.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4527@4da6555f2125d7bbd457698fd22bee8570e2fde0

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
