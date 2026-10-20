---
bornAs: x4dd26n
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/card-batch-io.mjs", "we:scripts/operations/__tests__/card-batch-io.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Add the check-standards rule from card xuloryt: every throw in the recovery functions must map to… (from web-everything/web-everything#5612 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/card-batch-io.mjs:167` — Add the check-standards rule from card xuloryt: every `throw` in the recovery functions must map to a named refusal case in the table-driven test.
2. `we:scripts/operations/card-batch-io.mjs:226` — Extend the xuloryt standards rule to cover the admission-side recovery precheck, so that every refusal condition in the recovery path needs a named case.
3. `we:scripts/operations/__tests__/card-batch-io.test.mjs:165` — Add the xuloryt convention check (check:standards rule): every invalid-evidence throw in `respoolClosed` must map to a named table-driven case.
4. `we:scripts/operations/card-batch-io.mjs:228` — Extend the xuloryt refusal-mapping convention to cover the admission-side identity guard in `admitCard`, not just `respoolClosed`.
5. `we:scripts/operations/__tests__/card-batch-io.test.mjs:121` — Keep the named behavioral assertions as durable gates and perform mutation probes separately; add a test lint rule rejecting literal replacement of production-module source inside unit tests.
6. `we:scripts/operations/__tests__/card-batch-io.test.mjs` — Extend the named refusal table with these stored-state and ancestry cases, and implement the proposed deterministic guard-to-test mapping check.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5612@5c4a3a165aeb43de7db9f68827fd3b079b8b5e66

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
