---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/dispatch-eligibility-shadow.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7585 (head ba61b663f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7585 (reviewed head `ba61b663fb873bb1a7cab82f8731ed65f7acb121`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/dispatch-eligibility-shadow.mjs:108` — (edge-case, degraded) The local-reader snapshot still invokes inherited source-owned setters.
   - Scenario: Create a PR whose prototype defines readerEvidence with a getter and setter over shared sourceEvidence, initially 'source'. In readLocals, assign snapshot.readerEvidence = 'local'. Object.create preserves that prototype, so the inherited setter executes and sourceEvidence becomes 'local'; the original PR now also reads 'local'. The probe recorded one setter invocation and coverage.complete=true. Assignment should create a snapshot-local property without invoking the source-owned setter or changing source evidence.
   - Class: live-reproduced (basis: A read-only probe executed the unchanged shadow and fact function bodies with the real pure eligibility function. Using commentsComplete=false avoided the unavailable red-team parser dependency. The inherited setter ran and changed source evidence despite the claimed isolation of top-level reader writes.)
   - Also class: coverage-or-style
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
