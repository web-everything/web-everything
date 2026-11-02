---
bornAs: xqr1g9u
kind: story
size: 3
parent: "7504"
status: open
blockedBy: ["7504"]
scope: ["we:scripts/lib/daemon-plugins.mjs", "we:scripts/settings/daemon-plugins.json", "we:scripts/settings/prototype-load.json", "we:skills-src/conveyor/daemon-manifest.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# Daemon plugin four: merge passes descriptor and switch, after the loader knows wev-merge-daemon

Child of 7504 (R357). wev-merge-daemon is not in we:scripts/settings/prototype-load.json, so its fixes cannot be prototype-loaded. Add it, graduate or drop the stale 171-file proto-daemon-resources overlay, then the descriptor and switch.

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

Statute check (found 2026-11-01): we:docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clause 5(e) keeps `merge-orphan-sweep` `main`-only. `wev-merge-daemon` carries 1 overlay today, so clear it (or take the 5(e) amendment to the operator) before building this.
