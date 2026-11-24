## Coverage
Enforced in `vitest.config.ts` — **80% minimum** for lines, functions, branches, statements over `plugs/**/*.ts` and `blocks/**/*.ts`. Excluded: `**/index.ts`, `**/__tests__/**`, `*.test.ts`, `*.spec.ts`, config files.

### Per-diff trust-chain branch floor (#2876)

`check:standards` runs the separate `diff-branch-coverage` check with an 80% floor
(`DIFF_BRANCH_COVERAGE_FLOOR` in `scripts/lib/diff-branch-coverage.mjs`). Generate
`coverage/coverage-final.json` with `npx vitest run --coverage` after editing source.
The default base is `HEAD` (staged + unstaged + untracked additions); for committed
branch changes, set `DIFF_COVERAGE_BASE` to the intended base commit, typically the
PR merge-base. The gate reports its base and does not fetch or guess a remote base.

Only added/replaced lines in `isTrustChainTier` files are attributed. Deletions,
empty diffs and changes outside the tier require no coverage report. Each Istanbul
branch outcome whose parent or arm range intersects changed lines counts once;
multiline ranges include body edits. This conservatively includes V8 function ranges.
An empty branch map is valid (no branches); missing files, malformed counters and
reports older than changed source fail closed. The timestamp check catches ordinary
stale local reports, but is not a source hash or provenance attestation: generate
coverage in the same checkout, after edits, and do not reuse copied reports.

The result says how many branches introduced or touched by this diff were exercised.
It does not establish implementation correctness or assertion quality. The existing
scoped-planes coverage thresholds remain independent.

