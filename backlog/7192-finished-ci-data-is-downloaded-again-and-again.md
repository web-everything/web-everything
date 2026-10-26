---
bornAs: xxpxxlg
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Finished CI data is downloaded again and again

[held entry 309] (daemon-async-audit 2026-10-14, held) Finished CI data is downloaded again and again. Job logs: 9,110 fetches for 412 distinct jobs (job 115612365947 ~1,030× by 6 callers). Run job lists: 25,404 fetches for 312 runs (old FUI and plateau main runs ~67× each). Check-runs of finished SHAs are also re-read. we:fix-facts.mjs:126 skips logs over 4 MB. Fix idea: one host-shared on-disk cache keyed by job id / run id, written only once the job or run is completed, kept forever (size-capped LRU). Store a compact parsed form for big logs. Readers: we:reconcile-pass.mjs:455 (defaultReadMainRuns), :633 (main-fixed-signature), we:stale-base-refresh.mjs:149, we:main-ci-red-io.mjs:55, we:red-main-quarantine-io.mjs:137, fix-facts. Design: shared cache. Evidence: calls.jsonl ops actions/jobs/N/logs, actions/runs/N/jobs. Saves ~33k calls/day (~13%), 60–90 s per fix tick. Size 2.

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
