---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/daemon-version.mjs", "we:scripts/lib/daemon-version-migrate.mjs", "we:scripts/lib/daemon-version-runtime.mjs", "we:skills-src/conveyor/launchd/com.we.health-watch.plist.example"]
dateOpened: "2026-10-08"
tags: []
---

# Card 89 S6: migrate/unmigrate tool, versioned plist template, live health-watch trial

Slice S6 of the versioned daemon clones plan (prepare-89): we:scripts/lib/daemon-version-migrate.mjs adds migrate and unmigrate to we:scripts/lib/daemon-version.mjs, with a plist rewrite helper and we:skills-src/conveyor/launchd/com.we.health-watch.plist.example on current. Done when a fixture round trip restores tree, state and keys; live proof on wev-health-watch.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
