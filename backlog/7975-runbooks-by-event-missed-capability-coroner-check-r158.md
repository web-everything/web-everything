---
bornAs: xyk0ga9
kind: story
size: 2
status: open
scope: ["we:MEMORY.md", "we:AGENTS.md", "we:CLAUDE.md"]
dateOpened: "2026-11-02"
tags: []
---

# Runbooks-by-event + missed-capability coroner check (R158)

MED priority hint. ## (held 2026-10-27 08:52 ET) Runbooks-by-event + missed-capability coroner check (R158) (1) Promote ops runbooks (a local path) into a repo home (we:docs/agent/runbooks/ or skills), keyed by daemon-event kind. The needs-you emitters add a runbook pointer field. Next runbooks: daemon-frozen (established-overlay-conflict), pr-ready-not-merging, merge-queue-stuck. (2) Coroner step: for each incident, run capability-search on its symptom; flag "missed existing capability" and append a runbook line. (3) context-sweep gains a byte budget for the always-loaded files (we:MEMORY.md, we:AGENTS.md, we:CLAUDE.md, session-setup) and fails over budget.

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
