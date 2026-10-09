---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xwnyn85-daemon-migrate-tool-fix-plist-rewrite-anchor-atomic-lock-tak.md"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a check:standards rule that errors on an open story card whose Acceptance section still conta… (from web-everything/web-everything#4604 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/xwnyn85-daemon-migrate-tool-fix-plist-rewrite-anchor-atomic-lock-tak.md:18` — Add a `check:standards` rule that errors on an open story card whose Acceptance section still contains 'TODO: a command' once the card is marked gated or approved. Today the rule only fires beside a mutation-proof claim.
2. `we:backlog/xwnyn85-daemon-migrate-tool-fix-plist-rewrite-anchor-atomic-lock-tak.md:14` — Add a check:standards rule that refuses to move a card from open to in-progress or ready while any `TODO:` placeholder remains in Acceptance, Non-goals, or Edge cases.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4604@503a6d985a33c12ae157cfc4f756fd0d476a70c1

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
