// Shared fixture names for the forge-key-structure suites (not a test file: vitest only collects *.test.mjs).
// The repository-wide scans live in their own test files so CI shard balancing can place each on its own
// runner; both they and forge-key-structure.test.mjs read the same names from here.
export const redactionFixtureNames=['scripts/conveyor/__tests__/ci-heal-mark.test.mjs',
  'bun-trial/scripts/conveyor/__tests__/ci-heal-mark.test.mjs',
  'scripts/conveyor/__tests__/supersede-rule.test.mjs',
  'scripts/operations/__tests__/coroner-transcripts.test.mjs',
  'scripts/readiness/__tests__/remote-git-bundle.test.mjs'];
export const keyBearingFixtureNames=redactionFixtureNames.filter(name=>/\/(?:ci-heal-mark|coroner-transcripts)\.test\.mjs$/.test(name));
