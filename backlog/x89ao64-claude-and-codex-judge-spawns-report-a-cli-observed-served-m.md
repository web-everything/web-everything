---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/judge-spawn.mjs", "we:scripts/lib/codex-judge-spawn.mjs", "we:scripts/lib/__tests__/judge-spawn.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Claude and Codex judge spawns report a CLI-observed served model for counted review seats

PR #7337 adds a cross-vendor admission check to we:scripts/operations/cli-adapter.mjs createDefaultJudge: a counted correctness/security/red-team seat carrying reviewContext is accepted only when the outcome carries a CLI-observed servedModel (modelObserved), else it throws 'WAIT: observed reviewer model missing or not cross-vendor'. Neither we:scripts/lib/judge-spawn.mjs judgeSpawn nor we:scripts/lib/codex-judge-spawn.mjs codexJudgeSpawn returns servedModel, so in production every claude/codex counted seat would WAIT. Have both spawns report the model the CLI actually served (claude stream modelUsage / codex session evidence; never the requested model), with producer-side tests that run the real parsers. Blocks PR #7337 accept. Found by the fix-7337 conflict round.

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
