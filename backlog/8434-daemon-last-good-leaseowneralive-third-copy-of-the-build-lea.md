---
bornAs: x4452c7
kind: task
status: active
scaffoldedBy: "fix-6213"
dateScaffolded: "2026-11-02"
scope: ["we:scripts/lib/daemon-last-good.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# daemon-last-good leaseOwnerAlive: third copy of the build-lease liveness rule lacks the pid-reuse start-time check

Found in PR 6213 self-review. leaseOwnerAlive in we:scripts/lib/daemon-last-good.mjs restates buildLeaseIsLive without the pidReusedSince check, so a reused pid keeps the rebuild grace alive up to the stale limit; it also treats a missing host as same-host and a malformed pid as dead (opposite of we:scripts/lib/daemon-rebuild/lease.mjs). Fix: reuse pidReusedSince and pidExists from we:scripts/lib/daemon-rebuild/lease.mjs (or hoist to a leaf module to avoid the import cycle) and test it.

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
