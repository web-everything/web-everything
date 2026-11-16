---
kind: story
size: 3
status: resolved
scope: ["we:scripts/readiness/forge-exec-sweep.mjs", "we:scripts/readiness/__tests__/forge-exec-sweep.test.mjs"]
dateOpened: "2026-11-15"
dateResolved: "2026-11-16"
tags: []
---

# Forge sweeper: reap abandoned prepared/running/receipt records with owner-gone proof

The execution sweeper now reaps identified .prepared/.running/.receipt records after seven days under the numbered worker's exclusive lease. It requires matching run, slot and nonce metadata across every phase, no matching live owner PID/start identity, and a complete process scan proving the worker UID has no processes. Missing, malformed, unreadable, busy or live evidence preserves the records. Slotless historical records require operator repair. Receipt deletion shares the existing per-sweep file budget.

## Acceptance

- [A1] **Executable** — `abandoned execution records` in we:scripts/readiness/__tests__/forge-exec-sweep.test.mjs exercises identified idle records, a live UID, live/malformed owner evidence, conflicting nonces, an unknown UID, young records, unidentified historical records, a reserved run, a busy lease, dry-run and record-only workers.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No killing processes or guessing an owner from age alone; no cache retention changes.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — strict run, worker and nonce shapes; descriptor-relative no-follow operations.
2. **Truncated reads** — records capped at 4 MiB; helpers have output and time bounds; incomplete evidence preserves state.
3. **Shared state files** — re-read and unlink under the worker lease; verify inodes before unlink.
4. **Fail closed** — unknown UID, malformed evidence or an incomplete process scan cannot authorize deletion.
5. **Identity scoping** — each record must name the numbered worker being inspected; all phases must share the nonce.
6. **State over time** — seven-day grace; dry-run plans subsequent run retention without deleting evidence.
7. **Who wrote it** — receipts remain in the controller-owned directory; worker UID evidence is read from the host.

## Review prevention follow-ups

The repair supplies production-CLI safety tests, lease ordering/probes, deterministic inspection/deletion replacement races and interrupted-tombstone recovery tests. A repository-wide check:standards rule banning path-based recursive deletion in privileged Forge wrappers, plus generic lint for duplicated exit handling and safety-default/lease test-plan requirements, still need separate scope. They are recorded here because this sandbox cannot invoke the normal filing service and the repair fence excludes the standards engine. These broader prevention tasks are not part of this resolved record-reaping story.
