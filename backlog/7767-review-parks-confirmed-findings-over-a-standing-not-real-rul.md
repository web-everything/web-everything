---
bornAs: xe8a4e6
kind: story
size: 2
status: open
scope: ["we:agent-memory-src/draft-alone-does-not-hold-a-pr.md"]
dateOpened: "2026-11-02"
tags: []
---

# Review parks "confirmed findings" over a standing not-real ruling

MED priority hint. ## (held 2026-10-25 15:29 ET) Review parks "confirmed findings" over a standing not-real ruling #5926 at 19:27Z: needs-you `ruling-needed` fired, but its only finding (we:agent-memory-src/draft-alone-does-not-hold-a-pr.md:12) already had not-real ruling review-pr-96802ad0…:0. The judge's preview found no open finding. Fix: the review park step and the needs-you emitter should subtract findings already ruled (not-real/card) on the same key before parking or raising ruling-needed. Proof: replay #5926 → no event.

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
