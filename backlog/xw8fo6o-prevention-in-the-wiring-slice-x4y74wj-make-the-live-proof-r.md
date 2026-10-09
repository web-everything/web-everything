---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-followup-job.mjs", "we:scripts/lib/__tests__/drain-followup-job.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — In the wiring slice (x4y74wj), make the live proof run the real entry unmodified in the prepared… (from web-everything/web-everything#4679 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-followup-job.mjs:103` — In the wiring slice (x4y74wj), make the live proof run the real entry unmodified in the prepared worktree. Have the preparer symlink or install node_modules, and add a smoke test that imports the entry's dependency graph from a bare worktree.
2. `we:scripts/lib/drain-followup-job.mjs:150` — Pass a short `waitMs` so contention throws quickly and the retry handles it. Alternatively, have the step's `heartbeat` callback also write the job record heartbeat. Add a runtime test with a step that blocks past `staleMs`.
3. `we:scripts/lib/drain-followup-job.mjs:152` — Make the step helper wrap the heartbeat so that a false return throws, and assert that behaviour in a test. If a lint exists for discarded return values of fenced primitives, use that instead.
4. `we:scripts/lib/__tests__/drain-followup-job.test.mjs:173` — Add a parameterized regression test over both steps that asserts reset-before-effects and primary-clone refusal; run it in the unit-test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4679@ee1b1f0dc9a58585a048a2cc49b0ea3d41ab152d

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
