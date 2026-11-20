---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/author-stamp-restore.mjs", "we:scripts/lib/__tests__/author-stamp-restore.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a table-driven 'benign prose still restores' test: multi-line parenthetical, quoted line, apo… (from web-everything/web-everything#7231 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/author-stamp-restore.mjs:62` — Add a table-driven 'benign prose still restores' test: multi-line parenthetical, quoted line, apostrophe line. Pair it with each new refusal heuristic. A real Markdown tokenizer in the follow-up card would replace the line heuristics.
2. `we:scripts/lib/author-stamp-restore.mjs:148` — Add an expected-refuse test (it.fails or todo) per declared known gap, so closing the gap flips a visible test. Longer term, replace the heuristics with a real Markdown parser, as the follow-up card plans.
3. `we:scripts/lib/__tests__/author-stamp-restore.test.mjs:1000` — Require each waived audit gap to land with a test marked as a known gap (it.fails with the card ID in its name).
4. `we:scripts/lib/author-stamp-restore.mjs:167` — Table-driven accept/reject test for the allowlist regex, with one reject case per character class.
5. `we:scripts/lib/author-stamp-restore.mjs:55` — Add a deterministic regression gate covering escaped opening and closing brackets in multiline links, asserting refusal and no write; require this test to fail when escape-aware link guarding is removed.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7231@4eb4d9ba59168fa55e8f1c2e8574155d88386968

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
