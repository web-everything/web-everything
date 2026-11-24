## Prepare PR isolation

Prepare-item refs (`lane/<item>-prepare-item-*`) receive a fixed item-specific title from the open-pr producer,
never a commit subject. Other `-prepare-` refs (prepare-decision, prepare-stamp) are not guarded: decision
prepares legitimately touch research files. Its submission boundary fetches origin/main, checks the full three-dot diff
against the unique target card, rejects lane merge commits, and pins the observed source SHA before
calling pr-land. Observation failures refuse publication. Prepare agents acquire fresh origin/main
lanes and never merge another lane. Regression histories live in
`we:scripts/operations/__tests__/prepare-pr.test.mjs`.

Builder red-draft recovery: test the raw draft snapshot before normalization (the build-policy projection drops draft metadata). GitHub REST check-runs responses contain a `check_runs` array, unlike the bare arrays returned by annotations and pull files. Exercise that IO shape, author liveness, durable PR-level retry accounting, exact branch forwarding, and comment plus `blocked:needs-human` construction. The recovery pass runs before in-flight holds; dry runs never dispatch. `WE_BUILD_DAEMON_RED_DRAFT_MINUTES` defaults to 60.

