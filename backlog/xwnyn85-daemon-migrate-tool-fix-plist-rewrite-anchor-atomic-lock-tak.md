---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/daemon-version-migrate.mjs", "we:scripts/lib/__tests__/"]
dateOpened: "2026-10-09"
tags: []
---

# Daemon migrate tool: fix plist rewrite anchor, atomic lock takeover, retry test — before first live migration

Gated follow-up from #4433 (card 89 S6), operator approved 2026-10-09: must land BEFORE the first live migration. (1) we:scripts/lib/daemon-version-migrate.mjs versionedPlistText rewrites at the first /<name> segment, not the clone path — anchor on dirname(clone), test with the name in a parent dir. (2) acquireLock stale takeover is rmSync-then-wx (not atomic) and treats a same-process call as a dead owner — make takeover atomic and pin same-process behaviour with a test. (3) test the failed-smoke retry cleanup.

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
