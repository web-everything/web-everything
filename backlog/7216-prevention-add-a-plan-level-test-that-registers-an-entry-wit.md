---
bornAs: x6rk3c2
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/lib/__tests__/daemon-rebuild-stack-tops.test.mjs", "we:docs/agent/testing.md", "we:scripts/lib/daemon-rebuild/__tests__/plan.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add a plan-level test that registers an entry with reason auto-rebase of base and asserts the bas… (from web-everything/web-everything#5937 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/plan.mjs:428` — Add a plan-level test that registers an entry with reason `auto-rebase of <base>` and asserts the base is not deferred behind it. Longer term, add a check:standards rule requiring every guard in we:scripts/lib/daemon-rebuild/plan.mjs ordering code to be referenced by a test name.
2. `we:scripts/lib/daemon-rebuild/plan.mjs:436` — Write the guard as a property test: for any list order and overlay set, deferral never changes the relative order of non-container established overlays. Failing that, add a regression case with an established intervening overlay.
3. `we:scripts/lib/daemon-rebuild/plan.mjs:424` — Per-guard negative-test checklist for ordering/deferral logic. Longer term, a mutation-testing gate over we:scripts/lib/daemon-rebuild/plan.mjs that fails when a guard condition can be flipped without a test going red.
4. `we:scripts/lib/__tests__/daemon-rebuild-stack-tops.test.mjs:390` — Add the named regression to CI with all deferral prerequisites satisfied except stackMode, and verify that removing the mode guard fails it.
5. `we:scripts/lib/daemon-rebuild/plan.mjs:428` — Add a CI regression that independently faults the containing-tip ancestry query and checks ordering and the base's decision.
6. `we:scripts/lib/daemon-rebuild/plan.mjs:426` — Identify or add the named CI test with established exact-tip containment, asserting original-before-repair processing and preserved conflict/loss handling.
7. `we:scripts/lib/__tests__/daemon-rebuild-stack-tops.test.mjs:390` — Add the discriminating regression and a targeted mutation check that removes the stackMode guard and requires this named test to fail.
8. `we:docs/agent/testing.md:37` — Add named fault-injection cases for each ancestry proof and require a targeted mutation of the containing-tip status check to redden its corresponding test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5937@593a669bb500eef1a3d961c436693c76095b92f3

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
