---
bornAs: xhhbmel
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/ci-red-recovery-watch.mjs", "we:scripts/settings/stack.json"]
dateOpened: "2026-10-12"
tags: []
---

# Lazy restacking for stacked PRs (stack.restack: eager | lazy)

Held finding 228 (2026-10-10, operator OK). Live #4814: 3 of 4 commits were base updates (drain rebase 17:36 ET, merges 20:00 and 20:36 ET) because its base #4799 kept changing; each update re-runs full CI (~20 min). Fix: setting stack.restack: eager | lazy (cascade, default lazy): bring a stacked child up to date only when its base has merged or is next in line, not on every base change; review-on-stack-base (#4789) continues meanwhile. Also covers the drain stack retarget path.

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
