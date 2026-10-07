'use strict';
/**
 * @file Runner-neutral "this process is a test run" predicate (#5187). Test-isolation guards (never touch the
 * real lane pool / real gh under test) ask this instead of reading `env.VITEST`, so a non-Vitest runner (Bun,
 * via `bun-test.preload.ts`) opts in with `WE_UNDER_TEST` without impersonating Vitest. CommonJS so the
 * synchronous `backlog-index.cjs` loader can use it; `under-test.mjs` is the ESM facade over this one function.
 * Legacy truthiness: unset/empty is false, any nonempty string (even "0") is true. Reads the given bag on every
 * call; an explicit bag never falls back to ambient `process.env`.
 */
function isUnderTest(env = process.env) {
  return Boolean(env && (env.VITEST || env.WE_UNDER_TEST));
}
module.exports = { isUnderTest };
