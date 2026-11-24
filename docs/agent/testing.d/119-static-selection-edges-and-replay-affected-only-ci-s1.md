## Static selection edges and replay (affected-only CI S1)

`related-test-selection.mjs` shares forward and reverse edges for imports, aliases,
spawned script paths and literal reads. Its source-wide path scan is conservative:
ambiguous literal expressions can add tests. Sibling aliases retain their textual
key and match a tracked vendored counterpart when available; they do not read sibling
repositories. CI uses the unlimited `ci.selection.maxTestsInCi` setting; local
`relatedMaxTests` stays caller-owned. Truncation carries `partial: true`.
Untruncated selection retains changed-file targets for `vitest related` and adds graph-reachable
tests: regex discovery is supplemental, never proof that all valid imports were parsed.
Require every changed target in the tracked inventory; an absent target (including a
committed deletion) forces the full suite.

`selection-replay.mjs` compares import-only and static selection on the current tracked
tree. PR diff test paths are only related-test proxies. Supply `--evidence=relative.json`
with failing/related test lists to assess misses; absent evidence is labelled incomplete.
A historical miss cannot be attributed to the parser merely because it happened:
probe the actual imports. The current merge-gate-hold-class test is a direct importer
and is reached even with all new static edge kinds disabled. The named test
`preserves the observed merge-gate-hold-class direct imports, including multiple named imports`
in `scripts/lib/__tests__/related-test-selection.test.mjs` passes all three switches as `false`.
Review lens: every “even with X disabled” claim must cite a test that explicitly disables X.


