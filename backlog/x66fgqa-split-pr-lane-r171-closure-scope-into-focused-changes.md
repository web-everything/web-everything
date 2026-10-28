---
bornAs: x66fgqa
kind: story
size: 3
status: open
scope: ["we:docs/agent/testing.md", "we:scripts/conveyor/soak/breaks/overlay-auto-retire-evidence.mjs", "we:scripts/conveyor/soak/breaks/overlay-pin-carried-base-retry.mjs", "we:scripts/lib/daemon-boot-smoke.mjs", "we:scripts/lib/daemon-clone-entries.mjs", "we:scripts/lib/daemon-overlay-auto-retire.mjs", "we:scripts/lib/daemon-overlays.mjs", "we:scripts/lib/daemon-rebuild-settings.json", "we:scripts/lib/daemon-rebuild/adopt.mjs", "we:scripts/lib/daemon-rebuild/auto-rebase.mjs", "we:scripts/lib/daemon-rebuild/closure-scope.mjs", "we:scripts/lib/daemon-rebuild/edge-fetch.mjs", "we:scripts/lib/daemon-rebuild/overlay-strategies.mjs", "we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/daemon-rebuild/rebuild.mjs", "we:scripts/lib/daemon-rebuild/shared.mjs", "we:scripts/lib/daemon-rebuild/skip-unrelated.mjs", "we:scripts/lib/import-closure.mjs"]
dateOpened: "2026-10-27"
tags: []
---

# Split PR lane/r171-closure-scope into focused changes

size-split-key:0b51ca30cf19aa60c0121d5c6fe8e775e89b7b896f896f8d04da18384b5220b8. Plan follow-up splits for PR lane/r171-closure-scope. File groups: we:docs/agent: 129; we:scripts/conveyor: 371; we:scripts/lib: 1001

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
