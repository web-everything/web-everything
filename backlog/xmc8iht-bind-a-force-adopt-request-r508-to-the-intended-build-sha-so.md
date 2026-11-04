---
kind: story
size: 3
status: active
scaffoldedBy: "fix-6360"
dateScaffolded: "2026-11-04"
scope: ["we:scripts/lib/daemon-force-adopt.mjs", "we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/operations/prototype-load-io.mjs"]
dateOpened: "2026-11-04"
tags: []
---

# Bind a force-adopt request (R508) to the intended build sha so another failing smoke within the 2h TTL cannot consume it

A force-adopt request (R508) is not bound to a build: any failing rebuild smoke within its 2h TTL consumes it, so the operator's ruling and quote can vouch for a build they never meant. Record the target sha (or registered-build ref) in the request at arm time and require the rebuild plan's final sha to match in the smoke path before adopting. Found by the PR #6360 security review as a hardening gap; the rollback watch limits the harm today.

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
