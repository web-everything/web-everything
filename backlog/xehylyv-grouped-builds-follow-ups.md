---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Grouped builds follow-ups

[held entry 301] (2026-10-14, held — next priority, from #5187 approval) Grouped builds follow-ups: (1) grouping compares repo-prefix-stripped scopes → may group cross-repo members (we:dispatch-plan.mjs:829, we:build-dispatch-daemon.mjs:705); (2) a member declining a grouped prepare is not remembered and is re-pooled (we:build-dispatch-daemon.mjs:1112); (3) .delivery-group-drop read without symlink/size check, raw line echoed (we:deliver-item-wrapper.mjs:770); (4) unconfirmed: grouped prepare may bypass a member Claude-only critical route (:1134).

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
