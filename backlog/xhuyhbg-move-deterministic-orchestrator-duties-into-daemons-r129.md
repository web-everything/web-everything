---
kind: epic
size: 13
status: open
scope: ["we:scripts/conveyor/"]
dateOpened: "2026-10-26"
tags: []
---

# Move deterministic orchestrator duties into daemons (R129)

Rulings R129 + R137 (2026-10-26). The AI orchestrator does these duties every 30 min and they need no judgment, so each moves into a daemon. Inventory with card/PR pointers: (1) work-check counters, pacing (O/M/L -> build|deliver|hold) and we:plan.md build refill -> the reopened build-dispatch daemon (existing held card, R111/R111a). (2) daemon-held detection -> bundle repair: live for drain/fix (R124); extend to review after a watched run (child story). (3) adoption checks by merge-base polling -> already replaced by rebuild-adopted/failed events (#5940, done). (4) delegable approvals (R11: accepted + red-team clear + humanRequired=false) -> a daemon records clear-human with the evidence; covered by the R130 approval robot in shadow (#5983/#5982); going live needs the operator's OK. (5) pre-approval application (R49-style, e.g. R122 #5925) -> same R130 shadow coverage; same operator OK. (6) standing rulings re-applied when a finding is re-raised on a new head (R121) -> ruling-carry by finding key in the review daemon; card 5375 / #5944. (7) stand-down auto-answer for non-own CI failures -> being built (R123). (8) backup (we:backup-ops.sh) and event-log housekeeping -> launchd job (child story). (9) stale-label cleanup, lane-lease release after a worker ends, scope-registry release -> lease-reaper / lane gc (child story). (10) quiet-hours logging of events to the handoff file -> the event writer appends directly; the session only reads (child story). What stays with the AI: judging findings (card vs send-back vs not-real), designing fixes, takeovers, prepare work, and talking to the operator.

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
