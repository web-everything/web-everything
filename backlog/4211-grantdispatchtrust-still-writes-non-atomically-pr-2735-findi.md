---
bornAs: x4zjnuh
kind: story
size: 2
parent: "4075"
status: open
scope: ["we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/operations/__tests__/dispatch-lane.test.mjs"]
dateOpened: "2026-09-26"
tags: []
---

# grantDispatchTrust still writes non-atomically (PR #2735 finding 5, deferred from #4188 follow-up)

The reported plain-write defect has already been fixed: grantDispatchTrust now writes atomically inside the shared lock, backs up first and preserves file mode. Keep that implementation and finish focused regression evidence plus cleanup of stale comments that still describe a plain write. Do not change fail-soft dispatch behavior or infer that the operator CLI participates in our lock.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/dispatch-lane.test.mjs`: add a grant-specific failure-injection test that interrupts the temporary-file write/rename boundary and asserts the original trust JSON remains byte-for-byte intact and parseable. The test must fail against the former direct-write implementation and pass against the present atomic implementation; it is expected to pass on current code once authored, not evidence of a still-present runtime defect.
- [A2] Pin backup-before-replace, existing permission preservation, unrelated project retention, no temporary-file residue after success/failure, and no-op on malformed input. Use an injected temporary trust file, never real user configuration.
- [A3] Exercise cooperating grant/revoke concurrency and bounded re-application after a noncooperating writer clobbers a grant; no lost unrelated project entries and no claim of universal serialization. Update the stale producer comments to describe atomic writes plus the shared lock and bounded verification.

## Non-goals

- [N1] No new trust authority, credential access, CLI lock stealing or changes to the dispatch caller contract.

## Edge cases this change must handle

1. **Untrusted text** — Trust directory inputs remain data/path keys; no shell construction from project names.
2. **Truncated reads** — Malformed or incomplete existing JSON is left untouched; never replace it with an empty trust object.
3. **Shared state files** — Preserve temp-plus-rename, backup-first and the shared lock; test interruption and cooperating concurrent writers.
4. **Fail closed** — Failed writes grant no new trust and leave existing data intact; retain the documented fail-soft dispatch contract.
5. **Identity scoping** — Grant only the requested lane/scratch targets and preserve all unrelated projects in the same file.
6. **State over time** — Keep bounded reread/reapply for the CLI writer that does not take our lock; already-trusted calls remain no-ops.
7. **Who wrote it** — Only the dispatch trust producer grants its explicit targets; JSON prose or similarly named directories are not additional authorization.

## Grounding

- we:scripts/operations/dispatch-lane-io.mjs:2435 takes the shared lock, line 2451 backs up, and line 2452 calls writeJsonAtomic with preserved mode.
- we:scripts/operations/dispatch-lane-io.mjs:2431 documents the noncooperating CLI writer; line 2456 provides an afterWrite seam for clobber tests.
- we:scripts/operations/dispatch-lane-io.mjs:100 still says the grant uses a plain write, a stale comment to remove.
- we:scripts/operations/__tests__/dispatch-lane.test.mjs:1378 proves additive grants; line 1387 proves malformed-file no-op; line 1487 tests atomic revoke, not grant interruption.
- Commit `dfbc7e4217` contains the mode-preserving atomic grant change.

Size 2: the atomic write already exists; remaining work is focused regression proof and stale documentation cleanup in the producer.
