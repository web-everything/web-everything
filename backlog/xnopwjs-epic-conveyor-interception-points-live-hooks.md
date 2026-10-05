---
kind: epic
status: open
scope: ["we:scripts/"]
dateOpened: "2026-10-05"
tags: []
---

# Epic: conveyor interception points (live hooks)

Needs /prepare before /slice. Named points where a brief, decision, prompt, write or merge passes through operator-registered hooks that observe, transform or veto it. Points: agent briefs, dispatch decisions, verify routing, reviewer prompts and verdicts, GitHub writes (dry-run), drain merge decisions, edge adoption, escalation. Hooks may NOT weaken the merge-gate chain; they MAY change local and advisory steps. Operator-installed with author, reason, expiry, audit log; global off-switch; fail closed. Related to the harness epic.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
