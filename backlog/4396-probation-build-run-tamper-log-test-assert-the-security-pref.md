---
bornAs: xyx95nq
kind: task
status: open
scope: ["we:scripts/operations/__tests__/probation-build-run.test.mjs"]
estimatedLoc: 6
dateOpened: "2026-09-29"
preparedDate: "2026-11-12"
preparedAgainstSha: "c29ba91a2b29e423e21ff72de2787a0c1c7f6575"
tags: []
---

# probation-build-run tamper-log test: assert the SECURITY: prefix

Advisory follow-up from PR #2867 (WE #4291): the worker-hook tamper test in we:scripts/operations/__tests__/probation-build-run.test.mjs:606–620 does not assert the `SECURITY:` message prefix operators grep for. The runtime already emits it at we:scripts/operations/probation-build-run.mjs:520; this task adds regression coverage.

## Acceptance

1. [A1] **Executable** — The existing test named “a worker that changes the lane's git-hook surface is refused, discarded, and never committed/PR-opened” in we:scripts/operations/__tests__/probation-build-run.test.mjs must assert that the captured worker-tamper message begins with `SECURITY:` after the runner's contextual prefix. Run the focused command below and the mutation check in Proof plan. Before this build the prefix-removal mutant survives (the check does not detect it); after, the new assertion kills that mutant; the unmodified runtime must pass in both cases.

## Design

Capture logging locally in the existing worker-hook tamper test: create a message array and replace that fixture's `io.log` with a callback that appends its argument before calling `runProbationBuild`. Assert that the array contains a message matching `/: SECURITY: the worker's own run changed the lane's git-hook surface/`. This checks the prefix on the relevant diagnostic without freezing its changing reason text.

The actual line starts with runner context, supplied at we:scripts/operations/probation-build-run.mjs:311; anchoring `SECURITY:` to the beginning of the entire line would be incorrect. Keep the shared no-op logger at we:scripts/operations/__tests__/probation-build-run.test.mjs:112 unchanged. No production behavior, defaults, callers, or new fail-closed paths change. Preserve the existing escalation, cleanup-before-discard, and no-commit/no-PR assertions in the same test.

## MVP

Edit only we:scripts/operations/__tests__/probation-build-run.test.mjs. Add local log capture and one assertion to the existing test at lines 606–620. Its `hookTampered: true` fixture already reaches the relevant negative path; no new fixture, runtime change, or broad logging refactor is needed.

## Test plan

From the WE repository root, run the affected test file through the host queue. The command uses the queue-backed `test:unit` script defined in we:package.json:31. The variable below strips the documentation-only repository prefix so the command remains executable:

```bash
test_ref=we:scripts/operations/__tests__/probation-build-run.test.mjs
npm run test:unit -- "${test_ref#we:}"
```

Confirm that the added assertion executes in the existing worker-hook tamper test and all existing assertions remain intact. Do not run the full suite. If admission is busy, use the queue's own bounded wait once, then report the result without polling.

## Proof plan

For [A1], use a temporary verification-only mutation of we:scripts/operations/probation-build-run.mjs:520: remove only `SECURITY: ` from the worker-tamper diagnostic. Do not alter either other security diagnostic. Run the Test plan command with the pre-build test: the mutant should survive. Run it with the new assertion: the named tamper test must fail specifically on the missing prefix. A mutation check is successful only when this second run exits nonzero for that assertion; a queue failure or unrelated test failure is not evidence. Restore the runtime exactly and run the command again; it must pass. Record the before/after results and leave no runtime diff. Temporary mutation is proof instrumentation, not part of the delivered touch set.

This is a coverage gap, so an ordinary red-before/green-after run against the unchanged runtime would be misleading: production already emits the prefix. The red-before/green-after acceptance criterion is whether the mutation check detects its removal.

## Follow-ups

None required for this advisory. Other security log branches remain outside this narrowly scoped test enhancement.

## Progress

- Original premise: a tamper-log test near line 310 lacked a `SECURITY:` assertion, with only we:scripts/operations/__tests__/probation-build-run.test.mjs in scope. Corrected premise: the relevant worker-hook tamper case is at we:scripts/operations/__tests__/probation-build-run.test.mjs:606–620 and still lacks log capture or a prefix assertion. Scope remains the same existing test file.
- Source evidence: the shared fake logger discards messages at we:scripts/operations/__tests__/probation-build-run.test.mjs:112; the runtime wraps messages at we:scripts/operations/probation-build-run.mjs:311 and emits the worker-tamper security diagnostic at line 520 of that same file. The adjacent restore-failure case at we:scripts/operations/__tests__/probation-build-run.test.mjs:622 already covers quarantine behavior; this task introduces no new fallback.
- No prior estimate existed. Set `estimatedLoc: 6`: one existing test file × approximately six added lines for a local message array, callback, assertion, and spacing. No size change or blocker change is proposed.
- Preparation is based on source inspection; no implementation or test run is claimed. Stamping and checks remain runner-owned.
- Re-prepare 2026-11-06: the scope file changed on main after the earlier stamp (PR #5484). Re-verified against current `main`: goal not delivered (no `SECURITY` assertion in the test file); citations still hold (test at :600–614, shared logger :106, runtime :311 and :520). No design change; re-stamped.
- Re-prepare 2026-11-08: citations drifted after main moved; updated to test :606–620 and shared logger :112 (runtime :311, :520 unchanged). Goal still undelivered (no SECURITY assertion in the test). No design change; re-stamped.
- Re-prepare 2026-11-12: no commits touched the test or runtime since the last stamp; citations re-verified (test :606, shared logger :112, runtime :311/:520). Goal still undelivered. No design change; re-stamped.
