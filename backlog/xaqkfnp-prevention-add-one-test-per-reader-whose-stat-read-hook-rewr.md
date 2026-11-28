---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/__tests__/review-run-dead-pending-judge.test.mjs", "we:scripts/settings/review-run-reaper.json", "we:scripts/conveyor/soak/breaks/review-run-dead-pending-judge.mjs", "we:scripts/lib/__tests__/reap-dead-review-runs.test.mjs", "we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/review-run-dead-pending-judge.test.mjs"]
dateOpened: "2026-11-28"
tags: []
---

# Prevention — Add one test per reader whose stat/read hook rewrites the record (new version plus a rejection) a… (from web-everything/web-everything#7629 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-red-team-evidence.mjs:380` — Add one test per reader whose stat/read hook rewrites the record (new version plus a rejection) after the tombstone is read, and assert that the reader holds. More generally, add a mutation-probe review lens for every 'stat again' guard line.
2. `we:scripts/lib/__tests__/review-run-dead-pending-judge.test.mjs:250` — Add one hermetic integration test that runs the real we:scripts/lane-pool.mjs against a temporary pool (LANE_POOL_ROOT set to a temp directory), and count listings through every directory read, including `runFileEntries`. A review lens could pair each acceptance test name with the real code path it covers.
3. `we:scripts/settings/review-run-reaper.json:2` — Threshold-boundary tests for a shipped policy should run with `tool: undefined`, which loads the real settings file. A standards rule could flag tests named after an acceptance threshold that inject the setting they claim to verify.
4. `we:scripts/conveyor/soak/breaks/review-run-dead-pending-judge.mjs:12` — Add a check:standards rule that rejects `fixedBy.sha: 'HEAD'` in soak breaks and requires a concrete sha, or make red-green resolve the merge-base range.
5. `we:scripts/lib/drain-red-team-evidence.mjs:380` — Add a reader test, per reader (drain completeSameHeadRead, reviewRunLookup via isReapedReviewSnapshot, headNeverReviewedFromRuns), that injects a record rewrite from inside the tombstone read (`fs.readFileSync` of the `we:.abandoned.json` path) and asserts the run still holds. As a durable class guard, file a check:standards or mutation-smoke rule: a line added under a comment or doc that promises a one-snapshot or re-check guarantee must have a test that goes red when the line is deleted. Until a gate exists, a stryker-style targeted mutation run over we:run-abandoned.mjs and the readers would do.
6. `we:scripts/lib/__tests__/reap-dead-review-runs.test.mjs` — Add a deterministic precedence matrix using distinct simultaneous values and asserting both threshold and resulting retention behavior.
7. `we:scripts/lib/__tests__/review-run-dead-pending-judge.test.mjs` — Gate scheduling changes on a deterministic multi-record cadence regression test.
8. `we:scripts/lib/__tests__/review-run-dead-pending-judge.test.mjs` — Add a deterministic migration test comparing populated ownership fields before and after cap tightening.
9. `we:scripts/lib/__tests__/review-run-dead-pending-judge.test.mjs` — Gate the yield policy with a deterministic logical-clock boundary test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7629@135daee1e473bd8905b2339511bf19b062000c41

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
