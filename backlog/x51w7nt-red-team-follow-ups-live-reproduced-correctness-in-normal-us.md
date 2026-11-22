---
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7340 (head d1fde20b4)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7340 (reviewed head `d1fde20b4f93f8a3dfcdb9433e985114b572a98e`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/merge-ai-prs.mjs:1058` — (failing-input, degraded) Production check rows omit the finding text the new diagnostic promises
   - Scenario: A merge-gate run fails with output.summary='test-gaming'. The production buildOpenPrPageQuery does not request finding fields, and mapGraphqlPr discards them even if supplied. Passing that mapped PR through describeBlockedChecks and decideGateSendBack produces only 'required check "merge-gate" FAILURE', losing the finding from both the diagnostic and send-back body. Hydrate the failed run's output before formatting it.
   - Class: live-reproduced (basis: A read-only Node probe exercised the real query builder, mapGraphqlPr, describeBlockedChecks and decideGateSendBack. The mapped row lost supplied summary/output fields and both resulting messages omitted 'test-gaming'.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break

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
