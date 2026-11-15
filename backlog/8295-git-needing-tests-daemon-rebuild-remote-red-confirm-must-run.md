---
bornAs: xpxbvy7
kind: story
size: 3
status: open
scope: ["we:scripts/lib/forge-bundle.mjs", "we:scripts/verify-lane.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Git-needing tests (daemon-rebuild, remote-red-confirm) must run and confirm reds on Forge

Needs-git daemon-rebuild tests (~73 Mac-min/12h) and remote-red-confirm local reruns (~67 min/12h) have no fix owner and burn Mac time. Make git-needing tests runnable on Forge (bundle .git or shallow fetch) and confirm reds on Forge. Owed 2026-11-14 08:39 ET.

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
