---
bornAs: x9hf8a0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xl6u8qo-codex-sandbox-can-write-the-coordination-dir-free-scope-regi.md", "we:backlog/xcmo9wr-operations-match-a-checkout-when-the-repo-slug-and-origin-di.md", "we:backlog/xvs6bsd-free-scope-claims-files-not-directories-and-treats-a-stack-b.md"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — A card-lint requirement that a card widening a permission or sandbox list states the exact path g… (from web-everything/web-everything#5547 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/xl6u8qo-codex-sandbox-can-write-the-coordination-dir-free-scope-regi.md:14` — A card-lint requirement that a card widening a permission or sandbox list states the exact path granted and a test asserting a path just outside it is still denied.
2. `we:backlog/xcmo9wr-operations-match-a-checkout-when-the-repo-slug-and-origin-di.md:14` — Fill the Identity scoping edge-case line before a card becomes buildable. Enforce that with the same card-lint that rejects TODO placeholders.
3. `we:backlog/xvs6bsd-free-scope-claims-files-not-directories-and-treats-a-stack-b.md:14` — Add a card-lint rule that a card relaxing a conflict or claim check must name a test where a non-qualifying claimant is still refused.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #4706, finding 5 → #5360, finding 6 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5547@093130d419ad0d7b8b8e1a05f07a860d141803ef

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
