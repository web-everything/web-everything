---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/readiness/dispatch-plan.mjs", "we:scripts/operations/deliver-item-wrapper.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs", "we:scripts/readiness/__tests__/dispatch-plan.test.mjs", "we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a daemon test: a prepare-item settle row with groupDropped:[#M] means #M is excluded from the… (from web-everything/web-everything#5187 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/build-dispatch-daemon.mjs:1112` — Add a daemon test: a prepare-item settle row with groupDropped:[#M] means #M is excluded from the next prepare pool. Longer term, one shared 'collect drops from settled rows of either kind' helper.
2. `we:scripts/readiness/dispatch-plan.mjs:829` — Have the daemon overlay rawScope (or the card's scope) onto the grouping rows. Add a daemon test with projectBuildQueueRow-shaped rows: stripped scope plus cards from different repos with no locus must not group.
3. `we:scripts/operations/deliver-item-wrapper.mjs:770` — Add a lint or check:standards rule that unsandboxed wrapper reads of lane-resident files use lstat plus a size cap, and that thrown messages never embed raw file content. Until then, have the drop-file reader reject symlinks and report only a line number.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5187@8514f37068d19f6cc68610f0c9f50eefe01f0508

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
