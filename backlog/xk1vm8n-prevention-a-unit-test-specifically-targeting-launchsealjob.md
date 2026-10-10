---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/card-batch-file.mjs", "we:scripts/operations/card-batch-io.mjs", "we:scripts/operations/card-batch-seal.mjs", "we:scripts/operations/health-file-request-land.mjs", "we:scripts/operations/__tests__/card-batch-file.test.mjs", "we:scripts/operations/__tests__/card-batch-io.test.mjs", "we:scripts/operations/__tests__/card-batch-seal.test.mjs", "we:scripts/operations/__tests__/health-file-request-land.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — A unit test specifically targeting launchSealJob to assert it calls spawn with the correct detach… (from web-everything/web-everything#4780 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/card-batch-file.mjs:61` — A unit test specifically targeting launchSealJob to assert it calls spawn with the correct detached flags and correctly pipes to the log.
2. `we:scripts/operations/card-batch-io.mjs:17` — A dedicated unit test for cardBatchStateDir to guarantee its resolution cascade remains stable.
3. `we:scripts/operations/card-batch-seal.mjs:10` — Unit tests that verify the output of renderBatchBody and memberSource under varying inputs.
4. `we:scripts/operations/health-file-request-land.mjs:144` — A test simulating a successful exit with invalid JSON to verify it gracefully falls back.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4780@d842efa514cc4d0c615d13b5ae25ade606675848

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
