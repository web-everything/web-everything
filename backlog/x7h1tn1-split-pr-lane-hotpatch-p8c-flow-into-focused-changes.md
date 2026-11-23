---
kind: story
size: 3
status: open
scope: ["we:docs/agent/settings-registry.md", "we:docs/agent/testing.md", "we:scripts/ci/test-timings.json", "we:scripts/conveyor/flows/hotpatch/flow.json", "we:scripts/daemon-overlay.mjs", "we:scripts/hot-patch.mjs", "we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/daemon-overlays.mjs", "we:scripts/lib/daemon-rebuild/adopt.mjs", "we:scripts/lib/daemon-rebuild/audited-tip.mjs", "we:scripts/lib/daemon-rebuild/auto-rebase.mjs", "we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs", "we:scripts/lib/daemon-rebuild/overlay-strategies.mjs", "we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/daemon-rebuild/preview.mjs", "we:scripts/lib/flow-engine/README.md", "we:scripts/lib/flow-engine/adapters/hotpatch.mjs", "we:scripts/lib/flow-engine/index.mjs", "we:scripts/lib/flow-engine/reference/definition-rules.mjs", "we:scripts/lib/flow-engine/reference/legacy-rules.mjs", "we:scripts/lib/flow-engine/reference/schemas.json", "we:scripts/lib/flow-engine/shadow.mjs", "we:scripts/lib/flow-v0-interim/index.mjs", "we:scripts/lib/flow-v0-interim/load.mjs", "we:scripts/lib/flow-v0-interim/plan.mjs", "we:scripts/lib/hotpatch-guards.mjs", "we:scripts/lib/hotpatch-readers.mjs", "we:scripts/lib/settings-registry-metadata.d/settings/auditBar.json", "we:scripts/lib/settings-registry-metadata.d/settings/liveWhen.json", "we:scripts/lib/settings-registry-metadata.d/settings/parallel.json", "we:scripts/lib/settings-registry-metadata.d/settings/receiptSource.json", "we:scripts/lib/we-only-checks.json", "we:scripts/operations/codex-audit.mjs", "we:scripts/operations/prototype-load-io.mjs", "we:scripts/operations/review-job-envelope.mjs", "we:scripts/settings/hotpatch.json"]
dateOpened: "2026-11-23"
tags: []
---

# Split PR lane/hotpatch-p8c-flow into focused changes

size-split-key:66f74f2562c0f321d4a7fc3a6cef98ab7edd7c7b36a22101b5dea53a3aa83e1c. Plan follow-up splits for PR lane/hotpatch-p8c-flow. File groups: we:docs/agent: 24; we:scripts/ci: 1; we:scripts/conveyor: 17; we:scripts/daemon-overlay.mjs: 29; we:scripts/hot-patch.mjs: 132; we:scripts/lib: 2713; we:scripts/operations: 54; we:scripts/settings: 6

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
