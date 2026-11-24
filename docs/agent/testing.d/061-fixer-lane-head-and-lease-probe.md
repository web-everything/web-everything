## Fixer lane HEAD and lease probe

`fix-run.mjs` retains the `holder` returned by `lane-pool acquire --json`; the ambient
session is not proof that a later lease belongs to the fixer. It checks the on-disk
`.git/.lane-lease` and exact PR head before starting the agent, preserves launcher
merge preparation, and checks ownership again before staging and pushing. Only an
owned, clean lane can be fetched/reset to the pinned PR SHA; recovery rechecks the
lease and HEAD. These checks detect takeover but do not make the allocator atomic.

Merge preparation rechecks the pinned PR head and holder after provider resolution,
immediately before merge, and immediately before either clean or resolved-conflict
merge commit. Drift refuses recovery and mutation, including aborting a merge in a
lane whose head or holder changed. Each merge commit's first parent must equal the
original pinned PR head before its SHA can authorize an agent launch or push.
Inject head and holder changes during provider resolution, fetch and merge preparation
in `fix-run-lane-head.test.mjs`; also reject missing or unexpected first-parent evidence.

Repeated-finding scope resets recheck the original pinned HEAD and acquired holder
immediately before `applyScopeReset`, with lane recovery disabled. Inject holder or
HEAD drift and missing/unreadable lease evidence during awaited provider resolution;
assert refusal before `merge-tree --write-tree`, `read-tree`, replay, commit or push.
Keep an unchanged-head/holder case that reaches the real reset path.

Keep disk-backed lease tests that omit the `readLease` injection: valid and foreign
markers, missing files, malformed JSON, missing holders, JSON null, and read errors
must exercise the production reader at `.git/.lane-lease`. A worktree marker is not
ownership evidence. Use a directory at the marker path for a deterministic read
error, including under root. After an agent leaves edits, change or remove its lease
and assert refusal before file reads for staging, index writes, commit, push, re-arm,
or lane release. Pair these cases with identical edits under an unchanged lease
that reach staging and push, so an inert fixture cannot prove the guard.

For a read-only observation, run
`node scripts/operations/fix-run.mjs --probe-lane-head --lane-path=<absolute lane path> --pr=<PR> --holder=<original acquired holder> [--repo=owner/repo]`.
The probe prints the observed lease, HEAD, current GitHub PR head and pure
`laneHeadCheck` decision. Omitting `--holder` refuses ownership rather than treating
the current occupant as ours. Git optional locks are disabled, so status does not
refresh the index. The live PR head may have advanced since an incident; compare
against the SHA the probe actually reports. Regression files: `fix-run-lane-head.test.mjs`,
`fix-run.test.mjs`, and `fix-run-borrow-dies.test.mjs` under `scripts/operations/__tests__/`.

