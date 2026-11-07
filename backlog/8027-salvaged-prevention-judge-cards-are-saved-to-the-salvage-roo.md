---
bornAs: xwpwkhn
kind: story
size: 5
status: open
scope: ["we:scripts/operations/land-prevention-card.mjs", "we:scripts/lib/lane-card-salvage.mjs", "we:scripts/lib/salvage-index.mjs", "we:scripts/conveyor/health-smells/untracked-backlog-card.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Salvaged prevention/judge cards are saved to the salvage root and the lane is declared clean, but nothing eve…

Flow-sim gap R7c-G1, class K3 (one-shot step, no re-driver). Failing input: A daemon-spawned `land-prevention-card` job (review-loop or approval-time) has acquired a lane and file-item wrote `backlog/x<hash>we:-prevention-....md` (untracked). PR is already review:accepted (review-loop resumes accept on 'queued'). The job fails BEFORE `git add`/commit lands the card, e.g. `git commit` is rejected by a h… Cited: we:scripts/operations/land-prevention-card.mjs:761-775, we:scripts/lib/lane-card-salvage.mjs:94-170, we:scripts/lib/salvage-index.mjs:92-96, we:scripts/lib/salvage-index.mjs:23, we:scripts/lib/salvage-index.mjs:72-77. Soak-break sketch: Fixture: a lane with an untracked we:backlog/x1abc23-prevention-foo.md and a lease; salvage root in a tmp dir; land step stubbed to fail at commit. Action: run landPreventionCard failure path, then refreshSalvageIndex with now = +15 days, then scan origin/mai…

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
