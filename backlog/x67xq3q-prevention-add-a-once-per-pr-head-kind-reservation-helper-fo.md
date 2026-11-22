---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/review-loop/round-end-gates.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/lib/review-loop/intake.mjs", "we:scripts/lib/review-loop/__tests__/intake.test.mjs", "we:scripts/lib/review-loop/__tests__/round-end-gates.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a once-per-(PR, head, kind) reservation helper for daemon events, and a test convention that… (from web-everything/web-everything#7313 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/review-loop/round-end-gates.mjs:27` — Add a once-per-(PR, head, kind) reservation helper for daemon events, and a test convention that every emitter has a two-tick idempotency fixture. Not captured by an existing gate, so file it with the A4b card.
2. `we:scripts/conveyor/reconcile-pass.mjs:1927` — Add a test-fixture rule that every new reconcile-pass injection point has a throwing-dependency case. Cheapest guard: wrap the load in try/catch that falls back to `enforce: off` and logs.
3. `we:scripts/conveyor/reconcile-pass.mjs:1926` — Add a test in we:reconcile-pass-required-checks.test.mjs: a throwing loadIntake must not abort the pass in shadow or off mode. Wrap the settings load in a degrade-to-off fallback that notes the failure. Fold this into the A4b enforce prerequisites.
4. `we:scripts/lib/review-loop/round-end-gates.mjs:59` — Extract the entry block into an exported main(stdin, deps) function and test that the production readHead is passed. A standards rule could require every stated guarantee in prose to name a test.
5. `we:scripts/lib/review-loop/round-end-gates.mjs:28` — Add a test that two identical ticks emit one event per (pr, head, kind). Dedupe on a head-keyed marker or on the last event for that PR, before A4b flips enforce on.
6. `we:scripts/lib/review-loop/intake.mjs:65` — Add a test with a PR whose repo differs from cwd and assert it is read through a repo-aware source or reported as an explicit non-gated skip. Add this to the A4b prerequisites.
7. `we:scripts/lib/review-loop/__tests__/intake.test.mjs:43` — Extend the named reader test to assert the merge-base arguments contain the pinned head and intended base reference; include a divergent-history fixture when writable test execution is available.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7313@2dcdb85fe126eb217cddcbbdb29bba78b81f82d9

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
