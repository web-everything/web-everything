---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/review-label-provider.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5854 (head c6eccfeb4)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5854 (reviewed head `c6eccfeb4feccd428a81729db57ef14e03f00e7a`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/review-label-provider.mjs:168` — (edge-case, degraded) Concurrent deletion lets an incomplete thread pass the new completeness proof
   - Scenario: Start with 201 comments, with trusted human clearance for the current head at position 101. The embedded snapshot and REST page one contain comments 1–100. After page one is fetched, a commenter deletes their own comment 1. REST page two now contains original comments 102–201, skipping clearance comment 101. The combined read contains 200 unique IDs, covers every embedded comment, and matches GraphQL totalCount=200, despite retaining deleted comment 1 and omitting live clearance comment 101. The probe confirmed readComments accepts this result and enrichment returns commentsComplete=true with
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
