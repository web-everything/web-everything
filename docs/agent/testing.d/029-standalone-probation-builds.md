## Standalone probation builds

`scripts/operations/probation-build-run.mjs` accepts `--taskType=doc-fix|bugfix|test-fix|prepare` (doc-fix default),
roster names or legacy JSON in `--worker`, and an allowlisted `--model`. Each omitted session is
generated independently. Different items use separate lane clones; do not reuse an explicit session
and lane for simultaneous runs. Task files, worker logs, commit messages and PR bodies are lane-local.
Before acquiring a lane or claiming, the runner reads the launch card’s `blockedBy` and checks blocker
frontmatter on `origin/main`. Unresolved or missing blockers return `blocked` with their IDs; a local
resolution does not count. The isolation tests cover this refusal and the resolved/no-blocker paths.
Pool discovery uses `defaultPoolRoot` with the script checkout root, never the caller cwd.
Mutation subprocesses must use both the lane cwd and the lane’s script copy: backlog and operation tools
derive their roots from `import.meta.url`. Daemon clones remain read-only launch sources. The isolation
test snapshots every launch-checkout file, including `.git`, across success and pre-worker failure.
Prepare edits only the target card body and preparation stamps, never claims/resolves it, and verifies
the runner-authored stamp before opening a parked PR. Its implementation scope does not bound preparation;
the card path does. `prepare.runner=codex` passes that card path to routing; `scope` retains implementation-scope
gating, and `claude` forces the daemon fallback. Use a named critical gate file (for example,
`scripts/lib/dispatch-contracts.mjs`) in scope-gating fixtures: arbitrary `scripts/lib/` files are not
critical by directory alone. Decision preparation remains a Claude judgment role.
Flash keeps the Codex read-only checker; a checker refusal undoes the attempt.
`test-fix` uses Flash without a separate simple flag and refuses non-test worker diffs.
The CI-heal decision currently has no structured failing-file list; do not infer one from check names.
Standalone Findings are publication text: strip absolute local paths, qualify code references using the
standards locus detector, and cap the final excerpt. The temporary-lane regression runs the actual
file-scoped standards gate on a written card. Envelope refusals discard and verify removal of the worker
diff before writing a card-only finding; preserve scope and hold for the builder rather than routing
these cards to auto-prepare. Capture the first gate error before truncating subprocess output, so the
runner result names the failed check even when the output tail only contains the summary.


Verify parallel isolation with the integration test
`scripts/__tests__/lane-pool-acquire-shares-scan-cache.test.mjs` (the three concurrent acquirers case).
The build-run tests separately race real scorecard writers in temporary storage. Probation builds
pass `requireLock: true` through scorecard migration and append, refusing the shared lock's usual
unlocked fallback on timeout. A refused scorecard write is reported on stderr without undoing a
successful build. Operation records use UUID filenames and atomic rename; call logs use append-only
writes, so they do not replace a sibling process's records.

