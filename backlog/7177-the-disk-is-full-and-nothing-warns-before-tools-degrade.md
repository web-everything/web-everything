---
bornAs: xsyftpc
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor", "we:scripts/lib"]
dateOpened: "2026-10-25"
tags: []
---

# The disk is full and nothing warns before tools degrade

[held entry 361] (coroner 2026-10-16, held, HIGH) The disk is full and nothing warns before tools degrade. The data volume is at 100% (5.1 GiB free of 926 GiB). The coroner run logged gh-throttle: acquire failed (ENOSPC), running gh unthrottled (fail-open), so the gh throttle silently stops protecting the rate limit. Fix idea: the host sampler and health-watch raise an alert below 10 GiB free and a prune job removes old lane scratch, test-results and playwright reports (leased lanes untouched); the gh throttle logs one loud line once per hour on ENOSPC instead of a quiet fail-open. Evidence: coroner run 2026-10-16 22:2x ET (err output), df on /System/Volumes/Data. Scope: we:scripts/conveyor health-watch, host-sampler, we:scripts/lib gh-throttle. Size 2.

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
