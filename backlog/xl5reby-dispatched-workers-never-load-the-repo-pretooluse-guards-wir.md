---
kind: task
status: active
scaffoldedBy: "dispatch-guards"
dateScaffolded: "2026-10-08"
dateOpened: "2026-10-08"
tags: []
---

# Dispatched workers never load the repo PreToolUse guards: wire them into each worker's settings

Dispatched claude --bg workers start in a scratch dir and never load we:.claude/settings.json, so we:scripts/guard-bash.mjs, we:scripts/guard-lane.mjs etc never run for them (1,224 sessions). The dispatcher writes the repo PreToolUse guard hooks (absolute paths) into each worker's own local settings. Needs human review (safety).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
