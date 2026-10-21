---
bornAs: xcrcsp1
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/main-ci-red-io.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5278 (head dc56ab1ce)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5278 (reviewed head `dc56ab1cecce2817fc2c6f0537f3081716803b56`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/main-ci-red-io.mjs:215` — (failing-input, degraded) One unreadable group aborts the search before a valid second candidate.
   - Scenario: Using the recorded fixture, prepend successful group run 42 on the same base with updatedAt=2026-10-14T06:27:00Z. Make its jobs read throw HTTP 503 while fixture group 38520623968 remains fully readable and covers integration. Disable the other rerun rules. The exception escapes jobsOf into the outer catch, yielding groupEvidence=null, eligible=false, and no rerun; the older group's jobs are never read despite the two-read budget. An in-memory probe of the repository's function bodies confirmed only run 42 was read. Treat that candidate as unreadable and continue to the second candidate within
   - Claude's re-check: jobsOf is called inside the candidate loop with no per-candidate try/catch, and the only catch is the outer one in probeMainCiRuns. A throw on the first candidate's job read (HTTP 503 through ghJson) skips the second candidate and leaves groupEvidence null. The test's jobsError case also assumes the read can throw.

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
