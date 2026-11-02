---
bornAs: x88kfkb
kind: story
size: 3
parent: "7504"
status: open
blockedBy: ["7504"]
scope: ["we:scripts/lib/daemon-plugins.mjs", "we:scripts/settings/daemon-plugins.json", "we:scripts/lib/daemon-clone-registry.mjs", "we:skills-src/conveyor/review-daemon.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# Daemon plugin seven: review daemon descriptor and switch, after its 12 jobs get their own clones

Child of 7504 (R357). wev-review-daemon hosts 12 launchd jobs and 8 overlays; the shared clone coupled adoption and caused the 5h review deadlock (#6184). Split the jobs onto own clones first, then descriptor and switch.

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
