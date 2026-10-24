---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/judge-sweep-facts.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5857 (head e4619f996)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5857 (reviewed head `e4619f996c426a750342de3964f33fbf3042d02d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/judge-sweep-facts.mjs:20` — (edge-case, degraded) A terminally parked fix loop suppresses judgment for an idle, at-cap PR
   - Scenario: Reproduced through createJudgeSweepFactsReader and buildJudgeSweepBundle: a PR has round=5, cap=5, status:at-round-limit, no running jobs or CI, no referrals, and a valid kind:'park' fix-loop row from five minutes ago. Include the producer's canonical fix-loop-exhausted stand-down comment. With evidenceErrors=[], the bundle returns needsJudgment:false and reason:'fix-loop active (&lt;60 min)'. The park producer explicitly stands down to the operator queue and stops dispatching repairs, so this PR should return needsJudgment:true, reason:'at-cap'. The timestamp-only shortcut mistakes terminal acti
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
