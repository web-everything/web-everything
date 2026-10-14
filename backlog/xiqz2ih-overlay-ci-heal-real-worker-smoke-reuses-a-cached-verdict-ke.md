---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/__tests__/daemon-load-overlay.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Overlay ci-heal real-worker smoke reuses a cached verdict keyed on the tested files' hash

The overlay dispatch smoke (we:scripts/lib/daemon-load-overlay.mjs runRealDispatchSmoke, ci-heal-999998) launches one REAL claude worker per overlay load: 187 sessions so far. Its verdict only depends on the dispatch-path files it exercises (the inspect matched set plus the launch harness we:scripts/lib/dispatch-smoke-launch.mjs). Cache a passing verdict keyed on a content hash of those files (a cascade setting, default on, old always-launch behaviour selectable; source logged), and launch a real worker only on a cache miss. Kept out of x0dcjec (its N1 non-goal): it needs its own cache-invalidation tests. Prove: a second overlay load on an unchanged dispatch path starts zero real claude processes.

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
