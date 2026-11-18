---
bornAs: x184jwc
kind: story
size: 3
status: open
scope: ["we:scripts/lib/clone-maintenance.mjs"]
dateOpened: "2026-11-15"
tags: []
related: ["7882"]
---

# Daemon clones never gc: loose objects grow to GBs (fix clone 7.3G)

The wev-fix-daemon clone .git/objects is 7.3G with about 6.1G loose objects (pack 1.2G) versus 3.4G on the review daemon clone. The rebuild path should run git maintenance or gc --auto on the daemon clone, from a lane, never by hand.

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

## Duplicate admission

same clone, different fault (alternates vs no gc)

7882 is about the alternate objects path; this is about never running gc
