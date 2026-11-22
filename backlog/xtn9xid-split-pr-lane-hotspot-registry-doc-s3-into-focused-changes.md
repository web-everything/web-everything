---
kind: story
size: 3
status: open
scope: ["we:.gitignore", "we:docs/agent/settings-registry.md", "we:package.json", "we:scripts/check-standards.mjs", "we:scripts/conveyor/soak/breaks/settings-registry-doc-conflict-regenerated.mjs", "we:scripts/lib/daemon-rebuild/advisory-merge.mjs", "we:scripts/lib/settings-registry.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Split PR lane/hotspot-registry-doc-s3 into focused changes

size-split-key:2d3b024fb41dd911948b69f478d01c11728c0bcd92240692de6c8f3cc928a9fa. Plan follow-up splits for PR lane/hotspot-registry-doc-s3. File groups: we:.gitignore: 3; we:docs/agent: 613; we:package.json: 3; we:scripts/check-standards.mjs: 2; we:scripts/conveyor: 10; we:scripts/lib: 41

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
