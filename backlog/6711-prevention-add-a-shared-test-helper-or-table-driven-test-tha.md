---
bornAs: xcsy10y
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/__tests__/daemon-rebuild-keep-established.test.mjs", "we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/lib/daemon-rebuild/__tests__/prepare.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/plan.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Prevention — Add a shared test helper or table-driven test that runs every state.held writer through two conse… (from web-everything/web-everything#5757 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/prepare.mjs:322` — Add a shared test helper or table-driven test that runs every `state.held` writer through two consecutive ticks and asserts `since` is preserved. File it as a backlog item.
2. `we:scripts/lib/__tests__/daemon-rebuild-keep-established.test.mjs` — Add a branch-coverage threshold for scripts/lib/daemon-rebuild/*.mjs, so a new conditional that no test executes fails the build. Failing that, a review lens that asks for one test per new guard condition.
3. `we:scripts/lib/daemon-rebuild/prepare.mjs:315` — Add the named retirement regression to the required test suite, asserting successful adoption and cleared held state after retirement.
4. `we:scripts/lib/daemon-rebuild/plan.mjs:642` — Add the named established-pinned-skip regression to the required test suite so broadening the loss classification fails deterministically.
5. `we:scripts/lib/daemon-rebuild/prepare.mjs:314` — Add deterministic integration tests that consume this hold state, assert dispatch remains available, and advance a fake clock across the escalation threshold.
6. `we:scripts/lib/daemon-rebuild/prepare.mjs:316` — Add a deterministic regression test that establishes the hold, retires the conflicting overlay through the supported mechanism, and asserts the next rebuild adopts and clears held.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5757@18dd508bf19a8d3dd1cd5ceb221380dad7cb26c4

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
