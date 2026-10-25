---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# One task→tier setting for both vendors, including effort

[held entry 263] (operator 2026-10-12 ~18:10 ET 'sounds good', after the Codex per-task routing lands) One task→tier setting for both vendors, including effort. A single cascade setting taskTier classifies task kinds (prepare/complex, takeover/design, ordinary fix/build/review, trivial mechanical, sampling) into tiers; each tier maps per vendor to a MODEL AND an EFFORT level: Claude (Haiku/Sonnet/Opus + Claude effort/thinking budget where the CLI supports it) and Codex (gpt-6-luna / gpt-6.1-sol / gpt-6-astra + model_reasoning_effort low…ultra). Same classification whichever vendor runs the task; per-launch log names tier, model, effort and the winning settings layer. Supersedes codex.modelByTask once proven.

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
