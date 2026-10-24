---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/host-load.mjs", "we:scripts/lib/verify-settings.mjs", "we:scripts/lib/tree-watchdog.mjs", "we:scripts/verify-lane.mjs", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/lib/__tests__/host-load.test.mjs", "we:scripts/lib/__tests__/verify-settings.test.mjs", "we:scripts/lib/__tests__/tree-watchdog.test.mjs"]
dateOpened: "2026-10-22"
tags: []
---

# Prevention — Add a fixture-based test with a representative healthy-host vm_stat/swapusage pair (no swap in us… (from web-everything/web-everything#5768 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/host-load.mjs:29` — Add a fixture-based test with a representative healthy-host vm_stat/swapusage pair (no swap in use) asserting admitted:true. Alternatively, give review dispatch the same bounded `maxWaitMs` fall-through that heavy-admission has. File as a backlog item.
2. `we:scripts/lib/verify-settings.mjs:51` — Add a verify-lane test for 'timer starts after slot acquisition'. This is a test-plan mapping, not a lint-decidable defect.
3. `we:scripts/lib/tree-watchdog.mjs:23` — Add a verify-lane test where the gate exits but a descendant holds the pipe, asserting the root pid is not signalled after 'exit'. Make the watchdog take a root-alive callback or a stop-on-exit hook. Longer term, a lint or standards rule that any delayed SIGKILL of a stored pid re-checks that the pid is still the owned child.
4. `we:scripts/verify-lane.mjs:653` — Add the held-slot, short-ceiling verify-lane test described above. Add a review-lens check that every prose guarantee in a settings comment maps to a named test.
5. `we:scripts/__tests__/verify-lane.test.mjs` — Add deterministic lifecycle tests that independently control admission release and phase completion, and assert the timeout budget starts anew after each admission.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5768@268cc4526e79f1dda2f34d2d6945ceb5b0bf6b72

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
