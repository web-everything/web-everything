---
bornAs: xyg4tb8
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6789-slice-2-switch-the-red-team-evidence-reader-to-the-identity.md", "we:backlog/6788-slice-1-writer-publishes-review-run-identity-entries-backfil.md", "we:backlog/6642-standing-architecture-rules-delivery-system.md", "we:backlog/6786-per-pr-review-run-identity-index-so-the-drain-s-red-team-evi.md"]
dateOpened: "2026-10-21"
tags: []
---

# Prevention — Add a card-lint rule that every planned test file or case must be reachable from a scope entry fo… (from web-everything/web-everything#5742 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/6789-slice-2-switch-the-red-team-evidence-reader-to-the-identity.md:9` — Add a card-lint rule that every planned test file or case must be reachable from a scope entry for the file it exercises. File it with #5360.
2. `we:backlog/6788-slice-1-writer-publishes-review-run-identity-entries-backfil.md:28` — A review lens or lint checking that terms a slice's tests assert on are defined in that slice's scope or its blockedBy.
3. `we:backlog/6642-standing-architecture-rules-delivery-system.md:64` — Doc note: record rulings in one canonical place and have the other cards link to it.
4. `we:backlog/6789-slice-2-switch-the-red-team-evidence-reader-to-the-identity.md:38` — A card-template rule: any card that loosens a refusal needs a Must line naming the compensating control's trigger and sink. The existing 'loosens a refusal needs two Must lines' hint is advisory only, so it should become a deterministic check.
5. `we:backlog/6786-per-pr-review-run-identity-index-so-the-drain-s-red-team-evi.md:36` — Extend the deterministic guarantee-to-test mapping gate planned in card 5360 to require mappings for conditional fallback obligations; preparation review must check that existing-state and failure assertions actually cover those obligations.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 5 → #5473.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5742@33a282cc047aa0187bdcae2aa3a98abdb1f4072d

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
