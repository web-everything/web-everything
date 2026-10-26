---
bornAs: x8aj2uy
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Each daemon's rebuild re-runs the same overlay-free smokes on the same main

[held entry 322] (daemon-async-audit 2026-10-14, held — with card 300) Each daemon's rebuild re-runs the same overlay-free smokes on the same main. 115 rebuild jobs = 31 job-hours/day; smokes median 456 s/job (dispatch-dry-run 9.9 h/day, reconcile-dry-run 3.6 h). In 8 of 29 bursts all 4 daemons rebuilt within 15 min against the same main and PR state. Fix idea: record pass results of checks that do not depend on overlays (gh-api-repo, gh-pr-list, lane-pool-list, acquire-release, plain-main reconcile) by main SHA in a shared store; other daemons reuse them within a TTL. Never weaken the smoke. Design: shared. Evidence: ~/.claude/daemon-jobs/rebuild-*; scratchpad pass/rebuild.py. Saves 2–4 job-hours/day. Size 3.

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
