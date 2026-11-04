---
bornAs: xz4ijof
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# #6048 idle-claim auto-release did NOT fire on its first live case

HIGH priority hint. - [HIGH] #6048 idle-claim auto-release did NOT fire on its first live case. #5996 fix-5996 sat idle from 06:42 ET (pid 71795, claude bg-spare, 0.1% CPU), yet the fix daemon logged "refreshed live claim fix-5996 — still owned by Mac:62745" at 07:11 ET, past the 30-min window. No idle-claim-released event. The claim cleared some other way before a 07:15 cold start. Likely cause: idle detection does not see a bg-spare-hosted session as idle, or keys on the claim owner pid (Mac:62745) instead of the bound session. Needs a red test from this exact case (10-29 07:21 ET).

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
