---
bornAs: xoi0zbm
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-10-31"
tags: []
---

# heavy-admission should route an overloaded run to Forge instead of deferring it when remote mode is always

Live 2026-10-31 10:40 ET (lane-2): heavy-admission DEFERRED 'npm run check:standards' for host load (84 on 12 cores > 6/core) while heavyAdmission.remote.mode=always and Forge was idle (~1). Overload should route remote, not defer. Check the order of the load-cap test vs the remote decision, and whether check:standards is on the remote allowlist. Prove on a lane run under load.

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
