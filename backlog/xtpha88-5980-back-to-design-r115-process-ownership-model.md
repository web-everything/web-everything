---
kind: story
size: 2
status: open
scope: ["we:detached-op.mjs", "we:pid-alive.mjs", "we:bounded-child.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# #5980 back to design (R115): process-ownership model

MED priority hint. ## (held 2026-10-27 14:04 ET) #5980 back to design (R115): process-ownership model The design is done (Opus, 14:03). Each op has an owned set (runner + cmd process group + WE_DETACHED_OP marker holders + log-file holders). Liveness uses a proc start stamp (Linux /proc start ticks + boot_id; macOS ps lstart + run-record path). An async budgeted probe returns unknown=75, never alive. The runner forwards signals and then sweeps. The --cancel verb. A detached O_EXCL reaper handles a SIGKILLed runner. The pgid-reuse guard. escaped-descendants is reported honestly. cgroup deferred. Tests T1-T11. About 8 pts. Files: we:detached-op.mjs, we:pid-alive.mjs, we:bounded-child.mjs, we:heavy-admission.mjs, we:run.mjs, we:worker-brief.mjs. Dispatch to codex-runner when L<36 and the PR count allows.

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
