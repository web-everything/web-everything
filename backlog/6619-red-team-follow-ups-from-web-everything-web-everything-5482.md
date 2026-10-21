---
bornAs: xscn78q
kind: story
size: 2
status: open
scope: ["we:scripts/review-set-label.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5482 (head bf5ff0aa5)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5482 (reviewed head `bf5ff0aa5dd96972760d4bef1170acf92f7eb20b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/review-set-label.mjs:1418` — (edge-case, degraded) A truncated comment thread causes missing-only recovery to revoke valid producer readiness.
   - Scenario: PR #42 is OPEN, non-draft, at head H, with only ready-to-merge. Its trusted acceptance marker for H is comment 101, outside readPrState's first 100 comments. Run we:conveyor/rearm-review.mjs 42 --repo=o/n --only-if=missing --expect-head=H. Both acceptance checks inspect the truncated page, so recovery allows adding review:pending and removing ready-to-merge despite the unchanged accepted head. A read-only CLI probe confirmed this decision and zero readComments calls; putting the same marker inside the visible page correctly refuses recovery. Both checks should read the complete thread before trea
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
