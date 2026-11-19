---
bornAs: x9jv9q3
kind: story
size: 1
status: open
scope: ["we:scripts/settings/prototype-load.json", "we:scripts/operations/prototype-load-io.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# Add wev-merge-daemon to prototype-load settings; check-standards flags daemon clones with no loader entry

Held card 2026-11-01 12:16 ET. The merge-orphan-sweep daemon wev-merge-daemon is missing from we:scripts/settings/prototype-load.json, so fixes to code it runs (e.g. #6171 job store) cannot be prototype-loaded. Add it, and make check-standards flag any launchd daemon clone with no loader entry.

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
