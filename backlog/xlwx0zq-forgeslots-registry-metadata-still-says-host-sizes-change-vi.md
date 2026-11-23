---
kind: story
size: 1
status: open
scope: ["we:scripts/lib/settings-registry-metadata.d/settings/forgeSlots.json"]
dateOpened: "2026-11-23"
tags: []
---

# forgeSlots registry metadata still says host sizes change via PR

Since PR #7267 per-host Forge pool sizes are operator-private (forgeSlots.hosts in the operator platform-preferences layer, read through policy-cascade by we:scripts/readiness/forge-slots.mjs); the repo default in we:scripts/settings/forge-slots.json names no hosts. The registry metadata at we:scripts/lib/settings-registry-metadata.d/settings/forgeSlots.json still says changeVia pr and describes a per-host pool size, so the generated settings registry misdescribes how host sizes change. Update the metadata to name the operator-layer change path for hosts. Found by the fix-7267 self-review.

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
