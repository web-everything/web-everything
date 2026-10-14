---
bornAs: xwb5txn
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:tools/drain-daemon/daemon.mjs", "we:tools/drain-daemon/__tests__/daemon.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Wrap calls into optional WE modules in a shared safe-call helper, or add a test that stubs a throwing tic… (from plateauapp/plateau-app#224 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:tools/drain-daemon/daemon.mjs:274` — Wrap calls into optional WE modules in a shared safe-call helper, or add a test that stubs a throwing tick() and asserts feedLoop survives. A lint rule against un-awaited async calls outside try blocks would also catch it.
2. `we:tools/drain-daemon/daemon.mjs:632` — Check pause in the heartbeat tick (kill children when PAUSE_PATH appears), and add a unit test that runs the heartbeat with a pause file present and a live fast-drain handle. More generally, add a lens or test checklist item that every long-lived merge-capable child is covered by each revocation signal (lease, pause, exit-3).

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#224@631e809bcd0c33954f12384edc9ffbbbc6cd9869

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
