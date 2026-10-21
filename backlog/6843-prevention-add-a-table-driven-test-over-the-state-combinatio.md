---
bornAs: x5laqh4
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/card-batch-seal-io.mjs", "we:scripts/lib/card-batch-settings.mjs", "we:scripts/operations/__tests__/card-batch-seal-io.test.mjs", "we:scripts/lib/__tests__/card-batch-settings.test.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Prevention — Add a table-driven test over the state combinations {sealFailure, verifyRetryAfter, seal} for sea… (from web-everything/web-everything#5800 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/card-batch-seal-io.mjs:323` — Add a table-driven test over the state combinations {sealFailure, verifyRetryAfter, seal} for sealDueBatches. A mutation-testing gate on the seal-io module would catch unguarded conditions of this kind.
2. `we:scripts/operations/card-batch-seal-io.mjs:225` — Track a cumulative re-arm count (for example `verifyRearms`), escalate to sealFailure past a ceiling, and add a test that pins the ceiling.
3. `we:scripts/lib/card-batch-settings.mjs:151` — Add a deterministic, parameterized precedence test covering each winning settings layer with distinct nondefault values, and run it in the existing test gate.
4. `we:scripts/lib/card-batch-settings.mjs:150` — Add a deterministic precedence test matrix using distinct nondefault values for every layer, including a valid environment override.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5800@240061ecb1912ff1ef4c69535e5aa34503cf5f28

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
