---
bornAs: x12iww0
kind: story
size: 3
status: open
scope: ["we:scripts/daemon-rebuild.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Daemon clone integrity: repack fails with bad tree object 2aece785; fsck, locate the object, repair or rebuild the clone

we:scripts/daemon-rebuild.mjs (2026-11-15 03:45 ET, HIGH): gc now runs (#6860/#6869 live) but repack fails 'fatal: bad tree object 2aece78591947a612c9b58535dc9577f3ffc5254' at 08:25:20Z. Do a read-only fsck --connectivity-only, check the object in alternates (the web-everything mirror, the review-daemon clone with tmp_pack garbage); repair by refetch/repack or rebuild the clone via the daemon-rebuild path. 7.8G of objects. Prove on the live case with before/after evidence, not only unit tests.

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
