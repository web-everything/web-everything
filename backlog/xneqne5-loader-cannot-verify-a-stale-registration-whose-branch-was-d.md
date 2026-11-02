---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Loader cannot verify a stale registration whose branch was deleted after merge

MED priority hint. ## (held 2026-10-25 16:35 ET) Loader cannot verify a stale registration whose branch was deleted after merge Fix daemon: ci-recovery-retrigger (#5883) and heavy-admission-sandbox-probe-2 (#5914) merged, then their branches were deleted. prototype-load could not confirm their tips and stopped check-unverifiable, so a worker retired them with daemon-overlay remove. Fix: when a registered ref is gone but its recorded sha (or its PR merge commit) is on main, treat it as landed and auto-retire it with a log line.

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
