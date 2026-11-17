---
bornAs: x8yr6ds
kind: story
size: 2
status: open
dateOpened: "2026-11-16"
tags: []
---

# needs-you confirmed-break-owed-send-back honors gate card ruling

Carded break (outcome=card-queued) must count as disposition, no false needs-you

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/operations/__tests__/needs-you-feed.test.mjs we:scripts/conveyor/soak/breaks/needs-you-carded-break-false-alert.soak.test.mjs` fails before and passes after: a carded break (card-queued) yields no needs-you, an uncarded confirmed break still does.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the red-team gate itself or red-team-undecided handling.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: only the validated shared disposition reader is consulted.
2. **Truncated reads** — n/a: unchanged; index-0 hold still keeps the alert.
3. **Shared state files** — n/a: reads PR comments only.
4. **Fail closed** — an unreadable PR or missing card record keeps the alert.
5. **Identity scoping** — the card ruling must match the live head and finding.
6. **State over time** — a new head drops the old card ruling; the alert returns if the new head is uncarded.
7. **Who wrote it** — only the trusted gate author's card record counts.
