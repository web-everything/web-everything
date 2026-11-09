---
bornAs: xvo03lx
kind: story
size: 5
status: open
scope: ["we:scripts/review-set-label.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/conveyor/convert-advisory-dispatch.mjs", "we:scripts/lib/advisory-labels.mjs", "we:scripts/conveyor/advisory-label-sweep.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# clear-human leaves review:awaiting-advisory behind; restamp-with-carry strips it

Flow-sim gap R3-G3, class K10 (hold without a settler). Failing input: PR parked by drain/pr-land with review:human + review:awaiting-advisory (MAP:6454, we:pr-land.mjs:1230-1234) and the advisory panel has not posted yet.' 'operator runs review-set-label --to=clear-human. Cited: we:scripts/review-set-label.mjs:473-476, we:scripts/review-set-label.mjs:602-605, we:scripts/operations/review-pr.mjs:3244, we:scripts/conveyor/convert-advisory-dispatch.mjs:378-380, we:scripts/lib/advisory-labels.mjs:182. Soak-break sketch: stuck stray label: PR reads review:accepted + awaiting-advisory (we:health-smells/review-label-conflict.mjs:36 flags it; we:operator-queue.mjs:215 raises 'label/comment disagreement' when an advisory comment exists). Does not block the drain (no drain reader)…

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
