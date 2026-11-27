---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/ci/fetch-main-history.sh"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — For each defensive guard, add a test case that only that guard rejects, or drop the guard. A muta… (from web-everything/web-everything#7605 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/ci/fetch-main-history.sh:86` — For each defensive guard, add a test case that only that guard rejects, or drop the guard. A mutation-testing pass over shell guards would catch this class.
2. `we:scripts/ci/fetch-main-history.sh:36` — Normalize trailing separators before constructing sibling paths and add a deterministic 'save accepts a cache directory with a trailing slash' regression test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7605@4b4459d069ce62ddab033c42c6d6a71d81bf0680

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
