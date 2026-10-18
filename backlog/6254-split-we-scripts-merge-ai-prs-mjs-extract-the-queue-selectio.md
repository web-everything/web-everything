---
bornAs: xhrbbr8
kind: story
size: 5
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-hold-decision.mjs", "we:scripts/__tests__/merge-ai-prs-split.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Split we:scripts/merge-ai-prs.mjs: extract the queue-selection and hold-decision logic into modules (part 1 of 2)

we:scripts/merge-ai-prs.mjs is over 7000 lines and every drain fix lands in it, so fixes wait in line behind each other. On 2026-10-17 four open PRs (#5518, #5492, #5480, #5462) held it and five drain fixes waited behind them (xyzpgol, xrdwiud, xq7aczc, xrrtegi, red-team settings). Part 1 of 2: move the queue-selection and hold-decision functions into small modules under we:scripts/lib/ with no behavior change; the old file re-exports them. Related older card: 2784 (same goal, older and blocked). Part 2 is the next story. [A1] Executable: node --test we:scripts/__tests__/merge-ai-prs-split.test.mjs passes, and the existing drain tests pass unchanged. Priority: top (operator 2026-10-17).

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
