## Pinned merge-drain leaf fixtures (R1105)

CLI fixtures exercising gates after the test-gaming scan must provide a resolved
commit matching the listed head, a merge-base, numstat and a readable unified diff.
Use `scripts/__tests__/fixtures/pinned-leaf-diff-fixture.mjs` for synthetic
`lane/leaf-N` backlog-only PRs; an always-failing Git diff now exercises the
incomplete-evidence human hold instead of the downstream gate.
For fixtures with arbitrary branches, workflow files or cross-repo couples, use
`pinned-pr-diff-fixture.mjs` with rows from the same PR database as fake `gh`.
Keep full commit IDs consistent across listings, live reads, check runs and saved
refresh records. Resolve the diff at the listed head when a capped commits read
or a later push intentionally makes the commits tip or live head differ.

