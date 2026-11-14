---
kind: story
size: 8
status: open
scope: ["we:scripts/lib/red-team-check-run.mjs", "we:scripts/lib/red-team-result-label-sync.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Redesign the red-team result, seal and label pipeline around one validated schema

Opus design, morning (2026-11-14). Tonight 4 separate fixes (PR #6787, PR #6606 slice 1, card-only pending, result-on-head sync) each hit new fail-opens from the same root: free-form result/comment parsing, empty-seal defaults and per-path validation. Build one versioned validated result schema; positive-evidence-only seals; one label-sync reader; cross-host safe publication. Positive evidence for a not-owed publish means: readable, finished, result is not-owed, sealed, 0 breaks, current head, re-read at publish; everything else refuses (PR #6787 parked 01:32 ET; needed before the red-team gate can go back to 'both'). Parked branches: lane/redteam-carry-publisher, lane/result-on-head-label-sync; PR #6787 merged with fail-opens (fix in flight). Related card 8188.

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
