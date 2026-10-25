---
bornAs: xw5pj68
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/nightly-coroner-job.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5450 (head ec68c8a6c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5450 (reviewed head `ec68c8a6c1e7894aff7967b8ec241e4eea1a9ef5`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/nightly-coroner-job.mjs:141` — (edge-case, degraded) Publication failures permanently strand completed reports without notifications
   - Scenario: Publish the October 16 report and cursor, then let appendLines throw EIO, or terminate the child before the append. The job exhausts its single attempt, and its retained daily record prevents subsequent ticks from invoking receipt recovery. An in-memory filesystem probe confirmed the report and advanced cursor existed, the next same-night tick enqueued nothing, and October 17 appended only its own notification. The October 16 notification remains missing after recovery. Retry finalization from the published receipt without repeating extraction, preserving the one-extraction-per-night policy.
   - Claude's re-check: The job kind has maxAttempts:1, and runNightlyCoronerJob skips any night whose id already exists in the store ('mine.some(r =&gt; r.id === id)') and keeps failed records. If appendLines throws after the report and cursor are published, the job fails with no retry. Later ticks never re-enter extractNightlyCoroner for that night, and a later night's job only handles its own night. So the missing coroner-ready notification is never recovered automatically. The report's receipt supports recovery only on direct re-entry.

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
