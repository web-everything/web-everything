---
bornAs: xc6b2yl
kind: story
size: 5
status: open
scope: ["we:scripts/lib/pr-merge-gate.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-queue-safety.mjs", "we:scripts/lib/drain-merge-strategy.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Direct merge: ready-to-merge withdrawn by a human between pass-start and merge still merges (non-local repos)

Flow-sim gap D-C1, class K6 (check-then-act race with no pin). Failing input: non-local repo (e.g. frontierui; DMS:300 enqueues()=false). PR labels at pass start [ready-to-merge], every commit Co-Authored-By Claude (isAiGeneratedPr true), CI green, MERGEABLE/CLEAN, body non-empty, no .state files involved.' 'human removes ready-to-merge in the UI after the listing but before this PR's turn in the serial … Cited: we:scripts/lib/pr-merge-gate.mjs:40, we:scripts/merge-ai-prs.mjs:7168, we:scripts/merge-ai-prs.mjs:1133, we:scripts/merge-ai-prs.mjs:1001, we:scripts/merge-ai-prs.mjs:1006. Soak-break sketch: none

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
