---
bornAs: xmkxvv4
kind: story
size: 5
status: open
scope: ["we:scripts/lib/daemon-rebuild/overlay-strategies.mjs", "we:scripts/lib/daemon-rebuild/auto-rebase.mjs"]
dateOpened: "2026-10-29"
tags: []
---

# Setting: dedupe overlay-main-sync per clone and select tests from overlay changes

Concurrent overlay-main-sync runs on one clone duplicate work, and main-sync test selection can exceed 100 tests and page the operator. Add a policy-cascade setting (default off) to run one sync per clone at a time and to select tests from the overlay's own changed files plus conflict-resolved files. No guard weakening; prototype-loaded before merge (R228).

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
