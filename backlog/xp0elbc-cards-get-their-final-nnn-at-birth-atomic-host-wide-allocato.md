---
kind: story
size: 8
status: active
scaffoldedBy: "number-at-birth"
dateScaffolded: "2026-10-19"
scope: ["we:scripts/backlog.mjs", "we:scripts/operations/scaffold.mjs", "we:scripts/operations/scaffold-io.mjs", "we:scripts/lib/card-number-allocator.mjs", "we:scripts/settings/number-at-birth.json", "we:scripts/lane-drain.mjs"]
dateOpened: "2026-10-19"
tags: []
---

# Cards get their final NNN at birth (atomic host-wide allocator in file-item and scaffold)

file-item and scaffold allocate the final NNN at creation from an atomic host-wide allocator with remote reservation, keep the hash only as bornAs, write references with the final number, and fall back to hash naming when the allocator is down; setting backlog.numberAtBirth, default on. Implements statute backlog-ids-numbered-before-publish (#3732) at the earliest point.

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
