---
kind: task
status: open
scope: ["we:scripts/worker-brief.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Worker brief step 5 should use only the Forge-allowed npm run test:unit form

we:scripts/worker-brief.mjs step 5 tells workers to run the red step as 'we:scripts/readiness/heavy-admission.mjs run -- npx vitest run <file>'. Forge refuses npx (command-not-allowed), so every worker red step falls back to the Mac (lane-49 twice on 2026-11-13). The same block also says 'npm run test:unit -- <files>'. Use only that form. Red-first test: the generated brief has no 'npx vitest'.

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

## Duplicate admission

Checked with capability-search and a backlog scan on 2026-11-14; no open card covers this exact change.
