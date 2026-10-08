---
bornAs: xepfcr5
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/build-dispatch-orphan-adopt.mjs", "we:scripts/conveyor/build-delivery-evidence.mjs", "we:scripts/conveyor/__tests__/build-dispatch-orphan-adopt.test.mjs", "we:scripts/conveyor/__tests__/build-delivery-evidence.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add one default-wiring test for the adoption pass, or extend the orphan-adopt soak break to cover… (from web-everything/web-everything#4361 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:520` — Add one default-wiring test for the adoption pass, or extend the orphan-adopt soak break to cover a delivered claim and a paused await-verify claim end to end. A lint that flags test wrappers which blanket-override production defaults would be the deterministic version.
2. `we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:395` — Give `blocked` its own longer window, or treat it as alive until a terminal state shows up. Add a `defaultSessionLiveness` test for a stale `blocked` record to pin whichever choice is made.
3. `we:scripts/conveyor/build-delivery-evidence.mjs:201` — Add a deterministic saturation regression using more than 100 matching rows with the actual delivery beyond the first page; require pagination, a narrower fallback lookup, or an explicit uncertainty result that prevents duplicate dispatch.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4361@a5938d8938a20137e76d2145e49d40ee8fff4970

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
