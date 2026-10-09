---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/run.mjs", "we:scripts/operations/open-pr.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# open-pr reports complete and exits 0 when it refused to open the PR (soak-waiver missing)

Live 2026-10-09 ~14:21 ET: `node we:scripts/operations/run.mjs open-pr --ref=lane/stacked-pr-restack ... --json` exited 0 and printed stopped:'complete' with one applied effect, but its run record (run id open-pr-6a90a4b2-576d-4264-bea3-43e7a4b5de51) shows the submit effect's result was outcome:'refused', reason:'soak-declaration', pr:null — the soak precheck (WE_PR_OPEN_SOAK_PRECHECK) wanted a soak break scenario or a soak-waiver line. No PR existed; only a gh pr list showed it. An agent reading the exit code or the default render thinks the PR is open. Fix: when the open-pr submit effect's outcome is 'refused' (any reason), the operation's verdict must say refused with the reason and the CLI must exit non-zero; add a test over the open-pr operation (we:scripts/operations/open-pr.mjs) with a refused submit result. Prove on a live refused open-pr.

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
