---
bornAs: x3h0sng
kind: story
size: 2
status: active
scaffoldedBy: "fix-6319"
dateScaffolded: "2026-11-04"
scope: ["we:scripts/lane-drain.mjs", "we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/conveyor/build-dispatch-orphan-adopt.mjs", "we:scripts/__tests__/lane-drain.test.mjs", "we:scripts/operations/__tests__/dispatch-lane-io.test.mjs", "we:scripts/conveyor/__tests__/build-dispatch-orphan-adopt.test.mjs"]
dateOpened: "2026-11-04"
tags: []
---

# Release callers surface the kept lanes from lane-pool release --json

lane-pool release now keeps a lane with unpushed work, exits 1, lists it under kept in --json and journals a loud release-refused line (PR #6319). Its callers still ignore that: lane-drain releaseItemLeases reads only released, dispatch-lane-io releaseReservedLane and build-dispatch-orphan-adopt releaseReservedLaneLease discard stdout. Make each caller report kept lanes in its own output (drain land event, dispatch result) and add a caller test against a lane holding an unpushed or squash-merged branch, asserting the refusal is surfaced rather than swallowed. From the PR #6319 round-3 review (finding at we:scripts/lane-pool.mjs:2828).

## Acceptance

- [A1] **Executable** — the three caller test files `we:scripts/__tests__/lane-drain.test.mjs`, `we:scripts/operations/__tests__/dispatch-lane-io.test.mjs` and `we:scripts/conveyor/__tests__/build-dispatch-orphan-adopt.test.mjs` (run with `npm run test:unit -- <those files>`) fail before this item lands and pass after: each gains a case named `surfaces a lane kept by the release guard` whose stubbed `lane-pool release --json` exits 1 with `kept: [{ lane, reason: 'unpushed-work', details }]`, and asserts the caller's own output (the drain land event, the dispatch result, the orphan-adopt result) names that lane and reason instead of reporting a clean release.
- [A2] **Fail closed** — the same three files gain a case where release exits non-zero with unparseable or missing `--json` stdout, asserting the caller reports the release as failed (never as released).

## Non-goals

- [N1] The release guard itself (we:scripts/lane-pool.mjs) is unchanged; this card only changes how its callers read and report the result.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — `kept[].details` is lane-derived text; callers print it through the control-character scrub and never into a shell string.
2. **Truncated reads** — a non-JSON or truncated stdout is a failed release (A2), not an empty `kept`.
3. **Shared state files** — n/a: callers read release's stdout only, no shared file.
4. **Fail closed** — a non-zero exit is never reported as released, whatever stdout holds (A2).
5. **Identity scoping** — callers report only the lanes their own release call returned.
6. **State over time** — n/a: the result is read once per call.
7. **Who wrote it** — n/a: the JSON comes from the caller's own child process.
