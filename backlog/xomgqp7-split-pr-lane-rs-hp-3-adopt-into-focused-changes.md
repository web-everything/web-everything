---
kind: story
size: 3
status: open
scope: ["we:scripts/daemon-overlay.mjs", "we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/daemon-rebuild/adopt.mjs", "we:scripts/lib/hotpatch-guards.mjs", "we:scripts/lib/hotpatch-readers.mjs", "we:scripts/lib/settings-registry-metadata.d/settings/auditBar.json", "we:scripts/lib/settings-registry-metadata.d/settings/liveWhen.json", "we:scripts/lib/settings-registry-metadata.d/settings/parallel.json", "we:scripts/lib/settings-registry-metadata.d/settings/receiptSource.json", "we:scripts/operations/codex-audit.mjs", "we:scripts/settings/hotpatch.json"]
dateOpened: "2026-11-24"
tags: []
---

# Split PR lane/rs-hp-3-adopt into focused changes

size-split-key:7873643cedfc6fe210a74dde898a608ae5043b3d9cde8b29f652a6054720487f. Plan follow-up splits for PR lane/rs-hp-3-adopt. File groups: we:scripts/daemon-overlay.mjs: 13; we:scripts/lib: 297; we:scripts/operations: 14; we:scripts/settings: 6

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
