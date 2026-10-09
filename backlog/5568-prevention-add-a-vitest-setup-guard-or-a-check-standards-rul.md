---
bornAs: xy4u70c
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/review-daemon.mjs", "we:scripts/conveyor/prep-review.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs", "we:scripts/conveyor/__tests__/prep-review.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a vitest setup guard, or a check:standards rule, that fails any test that reaches the real gh… (from web-everything/web-everything#4453 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/review-daemon.mjs:904` — Add a vitest setup guard, or a `check:standards` rule, that fails any test that reaches the real `gh` or `judgeSpawn` without an injected fake. Make new default-on daemon stages default to a no-op under `VITEST`.
2. `we:scripts/conveyor/prep-review.mjs:245` — Anchor the marker to the start of the comment body (drop the `m` flag). Add a test: a trusted comment with the marker mid-body, e.g. `x\n&lt;!-- prep-review: head=… blocked=1 --&gt;`, is ignored by `priorPrepReviews`, `prepNoteCoversHead` and `stageOwnsHold`. I did not run a mutation (no tools used); the test that should redden is a new case in `we:prep-review.test.mjs` under 'a note is bound to the head it reviewed'.
3. `we:scripts/conveyor/prep-review.mjs` — Extend the named exclusion test into a table of existing review labels, allowing changes only when trusted prep history establishes a stage-owned repair; run it as a deterministic CI gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4453@55a4d105412b368cb97f55866a7ee761715eb2c6

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
