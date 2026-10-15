---
bornAs: xmiwsa0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/land-prevention-card.mjs", "we:scripts/operations/__tests__/land-prevention-card.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a drain call to the batch seal job or a cron/loop. Record attempt count and age on spool entr… (from web-everything/web-everything#5231 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/land-prevention-card.mjs:373` — Add a drain call to the batch seal job or a cron/loop. Record attempt count and age on spool entries, and surface entries older than N hours in a standards or health check.
2. `we:scripts/operations/land-prevention-card.mjs:415` — Request `author,isCrossRepository` in the `--json` fields. Reject PRs where isCrossRepository is true or the author is not the prevention bot. Add a fold test with a cross-repository PR that expects `notFolded`.
3. `we:scripts/operations/land-prevention-card.mjs:365` — Add a drain test with a traversal `rel`. Longer term, a lint rule could require a negative test for any new path regex guarding file writes.
4. `we:scripts/operations/land-prevention-card.mjs:361` — Add a parameterized test with pre-existing, distinct file bytes and assert exact restoration after both successful admission and a thrown admission error; include it in the normal test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5231@d9441ba295646abe60eabddd93d26e04e290ba30

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
