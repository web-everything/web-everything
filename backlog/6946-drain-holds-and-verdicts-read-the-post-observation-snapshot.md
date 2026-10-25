---
bornAs: xn0kb6f
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
  - `failed snapshot refresh holds PRs with rows appended this pass` (we:scripts/__tests__/merge-ai-prs-observation-snapshot.test.mjs) — fault injection: the refresh read fails, and every PR with a row appended this pass is held, not merged.
  - `short snapshot refresh read holds PRs with rows appended this pass` (we:scripts/__tests__/merge-ai-prs-observation-snapshot.test.mjs) — fault injection: the refresh read succeeds but returns (a) fewer bytes than this pass appended and (b) a final row cut off mid-line. Each counts as a failed refresh: every PR with a row appended this pass is held, not merged, and no verdict is taken from the partial rows.
  - `appended row for the same PR number in another repo leaves this PR unchanged` (we:scripts/__tests__/merge-ai-prs-observation-snapshot.test.mjs) — a head-moved row appended this pass for PR N in a sibling repo does not hold or change the verdict of PR N in this repo; a row for PR N in this repo does.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No change to what the ledger records; only when the pass reads it.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — appended rows are parsed by the existing ledger reader; a malformed row is handled as it is today.
2. **Truncated reads** — the refresh reads from the pre-append offset; a short or failed read counts as a failed refresh (see Fail closed; cases `short snapshot refresh read holds PRs with rows appended this pass`, `failed snapshot refresh holds PRs with rows appended this pass`).
3. **Shared state files** — the ledger is append-only and the drain pass is its writer; the refresh reads only the range this pass appended.
4. **Fail closed** — if the refresh fails, every PR with a row appended this pass is held for this pass, never merged on the stale snapshot (case `failed snapshot refresh holds PRs with rows appended this pass`).
5. **Identity scoping** — rows are matched by repo and PR number (case `appended row for the same PR number in another repo leaves this PR unchanged`).
6. **State over time** — the core of this card: rows written in a pass are visible to that pass's holds and verdicts.
7. **Who wrote it** — n/a: only the drain writes the ledger.
