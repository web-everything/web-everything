---
bornAs: x2wgeya
kind: story
size: 5
status: open
scope: ["we:scripts/operations/open-pr*"]
dateOpened: "2026-10-25"
tags: []
---

# Card size is never checked against the real diff

[held entry 290] (coroner 2026-10-13, held) Card size is never checked against the real diff. #5025 (card 4815, size 3) opened at +1,036 lines / 11 files and landed at +1,553 / 13 files (4 files outside scope:); 4 re-prepares only refreshed citations, and split only fires on size>8. Today's code PRs: >438 changed lines = 0.96 extra review rounds vs 0.04 at <=438 (rho 0.51, n=55). Fix idea: prepare re-estimates size from must-haves + edge cases + touched-file size every pass; open-pr compares the diff to size and scope: and, past a threshold, refuses and routes to split / re-size (settings knob). Evidence: PR #5025, we:coroner2.json changeRequests.correlation (linesChanged). Scope: we:scripts/operations/open-pr*, prepare rules, split-backlog-item. Size 5.

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
