---
bornAs: x4hbpyx
kind: story
size: 2
status: open
scope: ["we:scripts/daemon-overlay.mjs", "we:scripts/lib/daemon-load-overlay.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Daemons that share a planner run the same planner version (no cross-daemon overlay skew)

Held finding 245 (2026-10-11). Live #4715: the review daemon carried #4770/#4779 overlays (advisory-fix cap -> takeover), the fix daemon dropped them (conflict with #4941 on we:scripts/conveyor/reconcile-pass.mjs) and refused cap-exhausted, so each waited for the other. Fix: a shared-planner overlay dropped on one daemon is flagged and dropped on its peers (or the planner version is pinned per PR decision); health smell on skew.

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
