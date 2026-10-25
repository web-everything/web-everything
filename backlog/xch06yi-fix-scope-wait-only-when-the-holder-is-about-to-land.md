---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Fix-scope: wait only when the holder is about to land

[held entry 275] (operator GO 2026-10-13 ~11:35 ET — "make it settings") Fix-scope: wait only when the holder is about to land. A real-conflict fix-scope hold today lasts only while the other fixer runs, so it never avoids the land-time conflict. New setting (e.g. fixScope.waitForLandingHolder {enabled, holderStates: [review:accepted, in merge queue]}): when the overlapping PR is accepted/queued, hold until it LANDS so the waiter starts from a main that contains it (conflict vanishes); otherwise fix in parallel and let land-time conflict handling resolve it. Documented, source layer logged. Live: #5045 held by #5164 (trial merge conflicts). Paired with regionMarginLines 20→3 (settings PR, same day).

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
