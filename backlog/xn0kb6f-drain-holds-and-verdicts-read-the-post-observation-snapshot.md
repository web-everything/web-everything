---
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs-observation-snapshot.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Drain holds and verdicts read the post-observation snapshot in the same pass

Found at PR #5492 (head fa23a3d), operator-carded as expedite under decision xugqjw1: in the drain main pass (we:scripts/merge-ai-prs.mjs:6275) the ledger observation is appended, but the holds and verdicts that follow still read the snapshot taken before it, so a head-moved or carried row written in this pass is not seen until the next pass. Fix: re-read or fold the new rows into the snapshot after the observation append, with a bounded cost. Priority: expedite (operator 2026-10-18, review-stringency expedite outcome).

## Acceptance

- [A1] **Executable** — `node --test we:scripts/__tests__/merge-ai-prs-observation-snapshot.test.mjs` fails before this item lands and passes after. Planned cases:
  - `head-moved and carried observations update same-pass holds and verdicts` (we:scripts/__tests__/merge-ai-prs-observation-snapshot.test.mjs) — both the hold and the verdict read the rows appended in this pass.
  - `snapshot refresh reads only the appended rows` (we:scripts/__tests__/merge-ai-prs-observation-snapshot.test.mjs) — the refresh reads the ledger from the pre-append offset, never the whole file.

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
