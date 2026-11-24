## Quality guidelines
Real Git fixtures must pass `-c gc.auto=0 -c maintenance.auto=false` on their Git invocations.
A large seed commit can launch detached maintenance/repack that outlives `execFileSync`, racing
recursive snapshots and cleanup. Apply the same flags to bounded production freshness fetches;
do not hide the race with sleeps, cleanup retries, or exclusions from the snapshot.

Git path safety tests must preserve raw command-output bytes until UTF-8 round-trip validation;
include invalid filename bytes as well as a valid U+FFFD name. For generated safety attributes,
probe the effective value with `git check-attr`, and test encoded line lengths near Git 2.43's
2048-byte limit. An ignored override must refuse the merge before Git can allocate conflict markers.

1. Test behavior, not implementation.
2. One concept per test; descriptive names (`should notify listeners on setItem`).
3. Arrange-Act-Assert. Reset state in `beforeEach`/`afterEach`.
4. Mock external deps with `vi.fn()` / spies.
5. **Exercise default arguments by omitting them (#4412).** An exported function whose optional parameters have
   defaults (a clock, a sleep, a poll interval) needs at least one behavioral test that leaves those overrides
   out. Passing the default value explicitly does not test the default, and an immediate return never reaches a
   default timer. Required inputs are still supplied. Existing coverage counts; do not duplicate it for the
   sake of a new test name. Example: the default-timing case in `we:scripts/__tests__/lane-verify.test.mjs`
   (`waitForVerifySettle`), which omits `now`, `sleep` and `pollIntervalMs` and drives the real defaults under
   vitest fake timers.
6. **Integration-test a polling loop while its target changes (#4412).** A polling tool needs a case where the
   target moves from pending to terminal AFTER the loop has started, not only the start boundary (already
   terminal) and the timeout boundary (never terminal). Synchronize the writer to evidence that the loop is
   inside its first sleep, never a guessed delay, and assert more than one poll so a too-early update cannot
   pass as a first-poll success. Replace file-backed state atomically (write a temp file, then rename). Example:
   the running-to-green / running-to-red cases in `we:scripts/__tests__/verify-lane.test.mjs`
   (`check --wait=`), which hook the child's first 2000ms timer over IPC.

