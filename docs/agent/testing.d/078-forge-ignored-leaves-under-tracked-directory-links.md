## Forge ignored leaves under tracked directory links

Ignored non-test regular files under a tracked directory link's source are omitted
at both ordinary and projected paths. The filesystem cross-check uses the fresh
ignored byte inventory; it still refuses untracked symlinks, missing projections
for non-ignored regular files, and policy-excluded source leaves, even when ignored.
`forge-manifest-parity.test.mjs` rows 20–25 and 31 cover those boundaries for full and
delta manifests, including ignored runtime JSON beside a `node_modules/.bin` symlink
and the earlier `ignored-test-file` refusal. Row 20 omits ignored runtime data at the
excluded `.claude/skills` alias only when the leaf is not source code and the remainder
after the link prefix is not policy-excluded; row 31 retains omission parity through an allowed alias.
Check every projected alias before skipping an ignored leaf, including nested link
projections: a non-test source can become a test under `tests/`, or acquire an
excluded component. Rows 26–30 pin those refusals and benign nested omissions for
full and delta manifests. Alias expansion shares the filesystem walk's limits and
refuses with `manifest-walk-limit` (local fallback) when that budget is exhausted.


