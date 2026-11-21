---
kind: story
size: 3
status: open
scope: ["we:docs/agent/settings-registry.md", "we:docs/agent/testing.md", "we:scripts/lib/change-evidence/data/merge-policy.json", "we:scripts/lib/change-evidence/record.mjs", "we:scripts/lib/change-evidence/writer.mjs", "we:scripts/lib/settings-registry-metadata.json", "we:scripts/merge-ai-prs.mjs", "we:scripts/settings/change-evidence.json"]
dateOpened: "2026-11-21"
tags: []
---

# Split PR lane/a8a-change-evidence into focused changes

size-split-key:d0e8555a9129efb6ad732f586eb9e0df153033bccaad90a875d1d8352cbca17f. Plan follow-up splits for PR lane/a8a-change-evidence. File groups: we:docs/agent: 26; we:scripts/lib: 434; we:scripts/merge-ai-prs.mjs: 3; we:scripts/settings: 4

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
