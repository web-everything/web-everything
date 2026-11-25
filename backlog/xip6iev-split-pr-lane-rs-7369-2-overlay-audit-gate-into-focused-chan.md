---
kind: story
size: 3
status: open
scope: ["we:docs/agent/testing/overlay-audit-admission.md", "we:scripts/daemon-overlay-audit-check.mjs", "we:scripts/daemon-overlay.mjs", "we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/daemon-overlays.mjs", "we:scripts/lib/overlay-audit-evidence.mjs", "we:scripts/lib/push-gate-lint.mjs", "we:scripts/lib/settings-safe-direction.mjs", "we:scripts/operations/prototype-load-io.mjs", "we:scripts/push-gate-allowlist.json"]
dateOpened: "2026-11-25"
tags: []
---

# Split PR lane/rs-7369-2-overlay-audit-gate into focused changes

size-split-key:02eac83c85887f9571f3a28c4dd3ce597b67f0e9d19cf77e4cc88aa6d2349015. Plan follow-up splits for PR lane/rs-7369-2-overlay-audit-gate. File groups: we:docs/agent: 25; we:scripts/daemon-overlay-audit-check.mjs: 91; we:scripts/daemon-overlay.mjs: 31; we:scripts/lib: 218; we:scripts/operations: 4; we:scripts/push-gate-allowlist.json: 2

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
