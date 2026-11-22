---
kind: story
size: 3
status: open
scope: ["we:docs/agent/testing.md", "we:scripts/ci/test-timings.json", "we:scripts/conveyor/soak/breaks/rebuild-main-sync-set-aside.mjs", "we:scripts/conveyor/soak/fixtures/rebuild-set-aside-probe.mjs", "we:scripts/lib/daemon-rebuild/adopt.mjs", "we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs", "we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/daemon-rebuild/state.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Split PR lane/rebuild-setaside into focused changes

size-split-key:957f905d756ce13fd6d6d68af0c083f48541f168ee18972a50ffffcbe35343ba. Plan follow-up splits for PR lane/rebuild-setaside. File groups: we:docs/agent: 34; we:scripts/ci: 2; we:scripts/conveyor: 122; we:scripts/lib: 169

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
