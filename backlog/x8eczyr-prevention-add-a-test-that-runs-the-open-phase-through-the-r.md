---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pass-daemons/pr-postmortem-pass.mjs", "we:scripts/operations/__tests__/coroner-pr-postmortem.test.mjs", "we:scripts/conveyor/pass-daemons/__tests__/pr-postmortem-pass.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add a test that runs the open phase through the real defaultBatchCard with prevention batchFiling… (from web-everything/web-everything#5917 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/pass-daemons/pr-postmortem-pass.mjs:60` — Add a test that runs the open phase through the real defaultBatchCard with prevention batchFiling=false, and branch on `outcome.disabled` (mark batched and stop retrying) versus `retryable`. A write-gate that forbids new daemon passes from injecting all three I/O sinks with no default-wiring test would catch the class.
2. `we:scripts/conveyor/pass-daemons/pr-postmortem-pass.mjs:131` — Persist a per-PR last-evaluated timestamp, or the PR's `updated_at`, and skip PRs unchanged since then. Add a test that two consecutive passes over unchanged PRs collect each only once.
3. `we:scripts/operations/__tests__/coroner-pr-postmortem.test.mjs:1025` — Add a dry-run test with a merged PR and an open PR that asserts the directory contains no new files and the cursor file is unchanged. Preferably also add a generic rule that a dry-run flag needs a no-write test.
4. `we:scripts/conveyor/pass-daemons/pr-postmortem-pass.mjs:192` — Add a `runPostmortemCli` test where the injected `runPass` is a spy, asserting it receives `{repo, dir:out, dryRun:true}` when `values['dry-run']` is set. The general guard is a review rule: every safety flag needs a test that asserts it at the call boundary.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5917@76b2b912c8e38627cebe64e7bd4b9d519db33944

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
