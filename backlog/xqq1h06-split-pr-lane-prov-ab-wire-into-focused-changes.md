---
kind: story
size: 3
status: open
scope: ["we:docs/agent/settings-registry.md", "we:docs/agent/testing.md", "we:scripts/conveyor/run-scorecard-store.mjs", "we:scripts/lib/dispatch-routing-catalog.mjs", "we:scripts/lib/dispatch-routing-policy.mjs", "we:scripts/lib/provider-rotation-shadow.mjs", "we:scripts/lib/provider-rotation.mjs", "we:scripts/lib/settings-registry-metadata.json", "we:scripts/settings/provider-rotation.json"]
dateOpened: "2026-11-22"
tags: []
---

# Split PR lane/prov-ab-wire into focused changes

size-split-key:4036176c05c354df80ea7f1a9873afc20b93ef800f93345d1ca4b38fee030b87. Plan follow-up splits for PR lane/prov-ab-wire. File groups: we:docs/agent: 41; we:scripts/conveyor: 20; we:scripts/lib: 243; we:scripts/settings: 17

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
