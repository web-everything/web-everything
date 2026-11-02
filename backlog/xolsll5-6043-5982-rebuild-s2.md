---
kind: story
size: 2
status: open
scope: ["we:pr-comment-read-baseline.json"]
dateOpened: "2026-11-02"
tags: []
---

# #6043 (#5982 rebuild S2)

MED priority hint. - (2026-10-28 16:48 ET) #6043 (#5982 rebuild S2): (a) diff noisy because #6036 sits on an older main — refresh #6036 onto main, then rebase #6043 on it and run the converge panel; (b) we:pr-comment-read-baseline.json was grown to allow comments(first:100) — snapshot throws (no truncation), S3 must add paging and shrink the baseline back.

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
