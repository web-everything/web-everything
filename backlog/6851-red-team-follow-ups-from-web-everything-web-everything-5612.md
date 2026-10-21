---
bornAs: xnrz17j
kind: story
size: 2
status: open
scope: ["we:scripts/operations/card-batch-io.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5612 (head 5c4a3a165)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5612 (reviewed head `5c4a3a165aeb43de7db9f68827fd3b079b8b5e66`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/card-batch-io.mjs:235` — (edge-case, degraded) GitHub-terminal batches remain eligible for repeated seal jobs after retirement
   - Scenario: Start with the targeted stuck state: sealedAt and pr are present, seal.step is ready, and GitHub reports MERGED. Admission archives that state unchanged and opens its successor. sealDueBatches recursively scans the archive and only excludes sealFailure or step=label-on-green, so the retired ready state launches another seal worker. Two successive scans in the probe both launched the retired archive. With the merged branch deleted, workers refuse head-mismatch and subsequent ticks keep relaunching them. Retirement must record terminal status that both scanning and publication honor.
   - Claude's re-check: demonstrated break

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
