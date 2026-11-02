---
kind: task
status: open
scope: ["we:scripts/lib/lane-pool-salvage-push.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# lane-pool salvage: none-ahead trusts lane-writable origin ref; AUTO_RECOVER/NO_RECOVER opt-outs bypass fail-closed release

Codex audit residuals, verbatim. (1) we:scripts/lib/lane-pool-salvage-push.mjs:26 - The new release gate relies on none-ahead, returned before fetching or validating the canonical remote. A lane-writable origin/main pointing at unpublished HEAD makes both release paths drop the lease without preservation. (2) we:scripts/lane-pool.mjs:4878 - Existing LANE_POOL_AUTO_RECOVER=0 or LANE_POOL_NO_RECOVER=1 bypasses both new refusal checks entirely, allowing release with unresolved origin or unsalvaged commits. The retained opt-out test explicitly requires successful release without salvage. Context: branch lane/lane-salvage-refuse-release.

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
