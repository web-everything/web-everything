---
bornAs: xj4b488
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/daemon-rebuild.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Daemon overlay loader refuses to run from a stale checkout

Live 2026-10-18: daemon-load-overlay was run from the primary checkout, 2,145 commits behind origin/main, so every dispatch smoke used the OLD harness. Loads of the prototype then timed out under load (431s, 468s, 106s) and rolled back, including the drain, which lost its earlier prototype changes. Other operations already refuse stale runners ('N commits behind; run from a lane'). Fix: the loader and rebuild refuse when the runner is behind origin/main by more than `daemonLoad.maxRunnerBehind` (default 0 for code paths the smoke uses), and say to run from a lane at the target ref. Acceptance: [A1] Executable test: a stale runner is refused, a current runner proceeds.

## Acceptance

- [A1] **Executable** — a test that refuses a stale runner (behind origin/main by more than `daemonLoad.maxRunnerBehind`) and lets a current runner proceed. It fails before this item lands and passes after.

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
