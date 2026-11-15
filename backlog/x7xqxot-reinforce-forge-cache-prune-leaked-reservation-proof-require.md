---
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/forge-cache-prune.mjs", "we:scripts/readiness/__tests__/forge-cache-prune-running-record.test.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Reinforce forge cache prune leaked-reservation proof: require a complete final receipt and newer-phase evidence

Audit of the prune fix (R825 residual) says: (1) a leaked reservation is accepted on an aged reservation plus a receipt that only names the run; require a complete final receipt (phase, numeric code, valid lock and digests); (2) a newer record with no profile fields is ignored when choosing the authoritative phase, so an older known profile can replace whole-lock protection. Tighten both in we:scripts/readiness/forge-cache-prune.mjs with tests in we:scripts/readiness/__tests__/forge-cache-prune-running-record.test.mjs.

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
