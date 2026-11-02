---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-clone-registry.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# R418 follow-up

MED priority hint. - (MED, 11-02 10:45 ET) R418 follow-up: add `wev-pass-readers` to DAEMON_CLONE_SEED in we:scripts/lib/daemon-clone-registry.mjs so overlay prune + lane guards treat it as a daemon clone. Also: no provision helper for daemon clones (worker hand-cloned per the health-watch plist example) → add one that refuses alternates to pruning clones.

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
