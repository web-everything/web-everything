---
kind: story
size: 3
status: open
scope: ["we:docs/agent/testing/test-timeout-policy.md", "we:scripts/ci/test-timings.json", "we:scripts/conveyor/main-ci-red-probe.mjs", "we:scripts/conveyor/soak/breaks/quarantine-safety-net-twice-per-tick.mjs", "we:scripts/conveyor/soak/breaks/red-main-quarantine-log-escape-sequences.mjs", "we:scripts/conveyor/soak/breaks/red-main-quarantine-soft-timeout.mjs", "we:scripts/lib/red-main-quarantine-io.mjs", "we:scripts/lib/red-main-quarantine.mjs", "we:scripts/lib/settings-files.mjs", "we:scripts/lib/settings-registry.mjs", "we:scripts/lib/test-timeout-policy.mjs", "we:scripts/settings/test-timeout-policy.json"]
dateOpened: "2026-11-22"
tags: []
---

# Split PR lane/quarantine-soft-timeout into focused changes

size-split-key:15ed6d965fc58dffa496a5e213edc39fc957cda8b5800b20e3823acbce261762. Plan follow-up splits for PR lane/quarantine-soft-timeout. File groups: we:docs/agent: 17; we:scripts/ci: 2; we:scripts/conveyor: 110; we:scripts/lib: 158; we:scripts/settings: 25

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
