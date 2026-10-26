---
bornAs: xzzvm3t
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Main-SHA facts are recomputed per phase and per daemon

[held entry 313] (daemon-async-audit 2026-10-14, held) Main-SHA facts are recomputed per phase and per daemon. Fix daemon: ~135 compare calls per tick (aheadBy), main-red-rebase avg 84 s, missing-run avg 64 s (branch protection read directly, 2 per repo per tick), and git fetch origin main up to 9× per tick. ci-red-recovery-watch: 27 compares per pass, and branches/main/protection failed 362 of 362 times (403). The drain also re-reads branches/main, rulesets and merge-group runs every process. Fix idea: one main-facts record per repo keyed by main SHA (compare aheadBy by head+main, main-red facts, required checks, branch/ruleset with ETag), shared across phases and daemons. Fetch once per tick. Memo a 403 for the day. Design: shared cache. Evidence: calls.jsonl api --method compare, branches/main/protection; we:reconcile-pass.mjs:551,608-618, we:reconcile-fix-dispatch.mjs:635, we:main-staleness.mjs:71, we:ci-red-recovery-watch.mjs:780, we:merge-queue-adaptive-batching.mjs:352,498. Saves 50–100 s per fix tick, ~15 s per ci-red pass. Size 3.

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
