---
kind: story
size: 3
status: open
dateOpened: "2026-10-31"
tags: []
---

# remote-exec falls back to the Mac on backoff-telemetry-stale despite fresh Forge telemetry

2026-10-30 09:22 ET, must fix before routing ON: the remote-exec CLI falls back with backoff-telemetry-stale from the shared admission remote health file even when Forge telemetry is fresh, which would keep most heavy runs on the Mac. Also the #6059 client (02ed5eae) has no delta so every run ships about 15k files (52s); land #6100/#6101 soon after #6059. Prewarm hit only 1 of 3 delta runs; slot trees exist only for the newest base.

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
