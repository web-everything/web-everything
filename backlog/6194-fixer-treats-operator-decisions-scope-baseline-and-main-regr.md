---
bornAs: xkt0ix9
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/", "we:scripts/worker-brief.mjs", "we:scripts/operations/"]
dateOpened: "2026-10-17"
tags: []
---

# Fixer treats operator decisions, scope baseline and main-regression checks as binding brief input

Operator 2026-10-17: "we have to keep improving the fixer", meaning no direct Codex passes on conveyor PRs except in emergencies. The orchestrator Codex briefs succeeded where the fixer looped (#5403, 13 rounds) because they carried: (1) the operator decision comment verbatim (block X, card Y), treated as binding input; (2) a scope-baseline: <sha> marker the fixer resets to, plus an explicit out-of-scope list (for example x5tbryq); (3) for guard and gate PRs, a required regression check against origin/main, with a deny test per shape main denies; (4) all blocked findings fixed in one round. Build: parse the sanctioned operator decision comments (review-set-label and stand-down-answer bodies) into a structured brief section; add scope-baseline and out-of-scope marker support in the fixer reset path (coordinate with the repeated-finding reset in #5463); add a guard or gate classifier (the touch set includes scripts/guard-*.mjs or gate files) that requires the main-regression step; bundle all blocked findings into one round (coordinate with the joined fix round in #5465). Live cases: #5403, #5461.

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
