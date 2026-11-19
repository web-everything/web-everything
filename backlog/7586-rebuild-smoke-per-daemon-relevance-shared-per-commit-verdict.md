---
bornAs: xfwf4zc
kind: story
size: 5
parent: "7585"
status: open
scope: ["we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/daemon-rebuild/skip-unrelated.mjs", "we:scripts/lib/verify-remote-routing.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# Rebuild smoke: per-daemon relevance, shared per-commit verdict, Forge routing (7585 ruling R344)

Build the ratified 7585 ruling: per-daemon import-closure relevance for dispatch-dry-run/reconcile-dry-run, a shared host-level verdict store keyed tree+lockfile+node+harness(+cloneKind) valid 12h, code checks on Forge with Mac fallback and tree-mismatch reject, and the always-run floor. Scope: we:scripts/lib/daemon-live-smoke.mjs, we:scripts/lib/daemon-rebuild/smoke.mjs, we:scripts/lib/daemon-rebuild/skip-unrelated.mjs, we:scripts/lib/verify-remote-routing.mjs. Tests and proof plan are in the card. Build after R333.

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
