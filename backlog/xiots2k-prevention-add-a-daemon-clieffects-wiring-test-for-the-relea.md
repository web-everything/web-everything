---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/conveyor/prepare-failure-policy.mjs", "we:scripts/lib/pr-limit.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:scripts/conveyor/__tests__/prepare-failure-policy.test.mjs", "we:scripts/lib/__tests__/pr-limit.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a daemon cliEffects wiring test for the release closures. A lint rule that requires an inject… (from web-everything/web-everything#5164 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:2111` — Add a daemon `cliEffects` wiring test for the release closures. A lint rule that requires an injected callback's real implementation to be referenced by some test would also catch this.
2. `we:scripts/conveyor/prepare-failure-policy.mjs` — Add a policy-level cap on pr-limit auto-releases per card within a window, with a test that cycles release then refuse and asserts the card ends held. A review lens could also require every auto-release path to name its retry budget.
3. `we:scripts/lib/pr-limit.mjs` — Describe every ref kind an exception-authority change affects in the PR text or the `we:scripts/lib/pr-limit.mjs` header comment. Reviewers should compare the description against the regex alternation.
4. `we:skills-src/conveyor/build-dispatch-daemon.mjs:2120` — Add a deterministic test of the production clearance predicate covering branch grants, global disablement, below-limit counts, and incomplete or failing count observations.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5164@5c5c233de09911fa2cc6f5c5ed5f488bd4eec0ea

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
