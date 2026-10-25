---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Lane git config changes while a fixer runs, so the finished fix is refused at push

[held entry 352] (coroner 2026-10-14, held) Lane git config changes while a fixer runs, so the finished fix is refused at push. 11 runs on 10-14 (8 ci-heal, 3 fix) ended "lane git config changed while the agent ran; refusing to push" and lost the work. #5355 scrubs config on acquire, but nothing stops a reset mid-lease. Fix idea: lane reset and scrub refuse a leased lane (a lease check before any config write). On a mid-run change, the push step re-scrubs to the known-good config and re-verifies instead of discarding the run. Evidence: fix-loop-ledger.jsonl outcome rows with that reason. Scope: we:scripts/lane-pool.mjs, fix-run push guard. Size 2.

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
