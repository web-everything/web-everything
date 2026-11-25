---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-list-paged.mjs", "we:scripts/lib/heavy-cache.mjs", "we:scripts/lib/__tests__/pr-list-paged-delta.test.mjs", "we:scripts/lib/__tests__/pr-list-paged.test.mjs", "we:scripts/lib/__tests__/heavy-cache.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Have listedPrFiles return null when pr.heavyReadError or pr.rowsComplete === false. Add a unit te… (from web-everything/web-everything#7511 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/pr-list-paged.mjs:420` — Have listedPrFiles return null when pr.heavyReadError or pr.rowsComplete === false. Add a unit test that a deferred row yields listedFiles null and listedFilesComplete false. Longer term, a lint or standards rule that every consumer of row.files goes through listedPrFiles.
2. `we:scripts/lib/pr-list-paged.mjs:386` — Defer the single row (heavyReadError 'labels-incomplete') instead of rejecting the page. Add a test that one 101-label PR among six leaves the other five hydrated.
3. `we:scripts/lib/heavy-cache.mjs:88` — Add a tri-state helper (absent, present or unknown) in pr-snapshot-store and have loadHeavyStore drop all entries on unknown. Add a test that makes statSync return EACCES. A lint rule against bare catch-alls in evidence-consuming modules would be the deterministic gate.
4. `we:scripts/lib/__tests__/pr-list-paged-delta.test.mjs:170` — Add a check:standards rule that a PR description's 'to be quoted in a PR comment' acceptance item is either linked to a comment or listed as an open item before merge.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7511@635e2bf25229acdc13f2fe6e619415020632050c

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
