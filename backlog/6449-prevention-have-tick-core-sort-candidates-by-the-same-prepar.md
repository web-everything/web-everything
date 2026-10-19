---
bornAs: x4wy59t
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/tick-core.mjs", "we:scripts/operations/prepare-batch.mjs", "we:scripts/operations/review-loop-cli.mjs", "we:scripts/operations/prepare-pr.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/conveyor/prepare-policy-settings.mjs", "we:scripts/conveyor/__tests__/prepare-policy-settings.test.mjs", "we:scripts/conveyor/__tests__/tick-core.test.mjs", "we:scripts/operations/__tests__/prepare-batch.test.mjs", "we:scripts/operations/__tests__/review-loop-cli.test.mjs", "we:scripts/operations/__tests__/prepare-pr.test.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Have tick-core sort candidates by the same prepareAheadNums order (a shared comparator) instead o… (from web-everything/web-everything#5486 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/tick-core.mjs:1306` — Have tick-core sort candidates by the same `prepareAheadNums` order (a shared comparator) instead of a second hand-written ranking, and add a table test of fresh/stale × priority/non-priority with one slot.
2. `we:scripts/operations/prepare-batch.mjs:33` — A lint rule or review lens against catch blocks that drop the error, plus an assertion that dropped-card reasons include the underlying (redacted) message.
3. `we:scripts/operations/review-loop-cli.mjs:451` — For each new guard conjunct, add a test that fails when only that conjunct is removed. A review-lens checklist item or a mutation-style CI check would catch this class.
4. `we:scripts/operations/prepare-pr.mjs:45` — Add a table-driven refusal test: one case per `throw` in verifyPrepareBatchPr, each asserted by message. A lint or standards rule could require every `throw` in a verify* publication guard to be named in a test.
5. `we:scripts/operations/probation-build-run.mjs:1119` — Centralize redaction in the `sh`/`trySh`/`node` wrappers inside realIo so every captured output is redacted once. Alternatively, add a lint that flags `.out` or `.stdout` slices inside realIo that don't pass through redactSecrets.
6. `we:scripts/operations/review-loop-cli.mjs:451` — Seat a Claude security juror on a card-only diff whose frontmatter `scope:` or `blockedBy` changed, and keep `seatsByTouchSet=false` as a hard override to the full roster. Add a test asserting that override.
7. `we:scripts/conveyor/prepare-policy-settings.mjs:7` — Add a required parameterized boundary test covering minimum, maximum, and immediately out-of-range values for bounded prepare settings.
8. `we:scripts/conveyor/__tests__/prepare-policy-settings.test.mjs` — Add a table-driven boundary test for 100 and 101 across configuration and environment layers, asserting both the effective value and its source.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5486@dfb22d51c23bf2ba4c870bace7f350f985799949

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
