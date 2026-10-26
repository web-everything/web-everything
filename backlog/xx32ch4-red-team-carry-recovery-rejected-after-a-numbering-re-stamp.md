---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/red-team-carry-io.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# red-team carry recovery rejected after a numbering re-stamp

we:scripts/lib/red-team-carry-io.mjs:33 eligible() rejects carry recovery when a normal numbering re-stamp changes reviewed-sha. Found by red-team result c5b9ec756f895007 on PR 5942 (R133 card-and-approve).

## Acceptance

- [A1] **Executable** — a scoped vitest case: carry recovery succeeds after a numbering re-stamp changes reviewed-sha, still fails for a real head change.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: first slice, nothing excluded yet.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: to be assessed when the card is picked up (red-team c5b9ec756f895007).
2. **Truncated reads** — n/a: to be assessed when the card is picked up (red-team c5b9ec756f895007).
3. **Shared state files** — n/a: to be assessed when the card is picked up (red-team c5b9ec756f895007).
4. **Fail closed** — n/a: to be assessed when the card is picked up (red-team c5b9ec756f895007).
5. **Identity scoping** — n/a: to be assessed when the card is picked up (red-team c5b9ec756f895007).
6. **State over time** — n/a: to be assessed when the card is picked up (red-team c5b9ec756f895007).
7. **Who wrote it** — n/a: to be assessed when the card is picked up (red-team c5b9ec756f895007).
