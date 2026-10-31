---
bornAs: xllgkfb
kind: story
size: 3
status: open
scope: ["we:.claude/skills/mechanical-delivery-doctrine/SKILL.md", "we:docs/agent/backlog-workflow.md"]
dateOpened: "2026-10-30"
tags: []
---

# Orchestrator focus lock: one current-focus file checked by every schedule and triage

HIGH cards-to-file entry 2026-10-30 14:30 ET (operator: we need to improve assistant focus). Keep a single current-focus file (goal, done-when, allowed side work). Every schedule prompt and event triage starts by reading it; any worker or thread off the focus path must be named as a deviation with a one-line justification or operator OK; the 10-minute update reports only focus-path progress. Root cause 2026-10-30: the R228/R254 lane prototype path was identified at 12:39 but effort went to side quests.

## Acceptance

- [A1] **Executable** — a new test, written first, that fails before this item lands and passes after, covering the behaviour in the digest.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: nothing beyond the digest is in scope.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new input path beyond the digest; existing handling unchanged.
2. **Truncated reads** — n/a: no new input path beyond the digest; existing handling unchanged.
3. **Shared state files** — n/a: no new input path beyond the digest; existing handling unchanged.
4. **Fail closed** — n/a: no new input path beyond the digest; existing handling unchanged.
5. **Identity scoping** — n/a: no new input path beyond the digest; existing handling unchanged.
6. **State over time** — n/a: no new input path beyond the digest; existing handling unchanged.
7. **Who wrote it** — n/a: no new input path beyond the digest; existing handling unchanged.
