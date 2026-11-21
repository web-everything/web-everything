---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/ci-heal-loop.mjs", "we:scripts/conveyor/await-verify-loop.mjs", "we:scripts/conveyor/__tests__/ci-heal-loop.test.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon-ci-heal-loop.test.mjs", "we:scripts/conveyor/__tests__/await-verify-loop.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a loop-level test asserting runCiHealLoop forwards bootHead/bootIdentity to the iteration; ge… (from web-everything/web-everything#7248 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/ci-heal-loop.mjs:196` — Add a loop-level test asserting runCiHealLoop forwards bootHead/bootIdentity to the iteration; generally, test each captured-at-boot value at its hand-off point.
2. `we:scripts/conveyor/ci-heal-loop.mjs:88` — Give start() a `respectGap` option (or have the controller check `now()-lastStart`) and add a test: child exits 1, two ticks inside minGapMs spawn once.
3. `we:scripts/conveyor/await-verify-loop.mjs:330` — Add a SIGTERM handler in the child that releases the cycle/read locks (or sets a stop flag checked at iteration boundaries), with a test that SIGTERM during an iteration releases the lock.
4. `we:scripts/conveyor/ci-heal-loop.mjs:195` — Doc note: comments asserting fail-closed behaviour should cite the test that pins it; no script gate is practical.
5. `we:scripts/conveyor/ci-heal-loop.mjs:193` — Add a table-driven test over decideRecloneBlock/cloneDispatchBlock covering every null combination (marker, idNow, knownIdentity). Longer term, make the child refuse to start the loop when boot identity is unknown.
6. `we:scripts/conveyor/__tests__/ci-heal-loop.test.mjs:335` — Add an iteration-argument assertion: expect(iteration).toHaveBeenCalledWith(expect.objectContaining({ bootIdentity: 'boot-id' })) in the runCiHealLoop test, plus one test through the default dispatchBlock with an injected identityOf and readState.
7. `we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon-ci-heal-loop.test.mjs:46` — Extract the main() wiring into an exported factory (supervisor, controller, effects, exits) and test it with fakes. Alternatively add a soak break that runs the real daemon tick against a stub child.
8. `we:scripts/conveyor/await-verify-loop.mjs:295` — Add a deterministic lifecycle test that arms a retry, calls halt, fires the timer, and asserts no spawn until explicit start.
9. `we:scripts/conveyor/ci-heal-loop.mjs:86` — Enforce restart eligibility centrally in the supervisor and add a deterministic fake-clock test that interleaves controller ticks, spawn failures, and retry callbacks.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7248@483424db36c723c0d2332fa32fdb34cad833ad16

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
