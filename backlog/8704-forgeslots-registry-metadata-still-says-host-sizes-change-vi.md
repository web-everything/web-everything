---
bornAs: xlwx0zq
kind: story
size: 1
status: open
scope: ["we:scripts/lib/settings-registry-metadata.d/settings/forgeSlots.json", "we:scripts/lib/__tests__/settings-registry.test.mjs"]
scopeRationale: "The registry checker at we:scripts/lib/settings-registry.mjs is run for validation only; its implementation does not change."
dateOpened: "2026-11-23"
tags: []
---

# forgeSlots registry metadata still says host sizes change via PR

Since PR #7267 per-host Forge pool sizes are operator-private (forgeSlots.hosts in the operator platform-preferences layer, read through policy-cascade by we:scripts/readiness/forge-slots.mjs); the repo default in we:scripts/settings/forge-slots.json names no hosts. The registry metadata at we:scripts/lib/settings-registry-metadata.d/settings/forgeSlots.json still says changeVia pr and describes a per-host pool size, so the generated settings registry misdescribes how host sizes change. Update the metadata to name the operator-layer change path for hosts. Found by the fix-7267 self-review.

## Acceptance

- [A1] **Executable** — a test in `we:scripts/lib/__tests__/settings-registry.test.mjs` asserts the forgeSlots metadata names the operator layer as the change path for `hosts`; it fails on the current metadata and passes after. The registry `--check` of `we:scripts/lib/settings-registry.mjs` stays clean.

## Non-goals

- [N1] No change to how `we:scripts/readiness/forge-slots.mjs` resolves slot counts; metadata text only.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: static metadata authored in the repo.
2. **Truncated reads** — n/a: no new reads.
3. **Shared state files** — n/a: no runtime state.
4. **Fail closed** — the registry `--check` must still reject malformed metadata after the edit.
5. **Identity scoping** — n/a: no identities involved.
6. **State over time** — n/a: no persisted state.
7. **Who wrote it** — n/a: repo-owned file changed only through a PR.
