/** @file ESM facade over the single predicate in `under-test.cjs` (#5187): true under Vitest (`VITEST`) or any runner that sets `WE_UNDER_TEST`. */
import { createRequire } from 'node:module';

const { isUnderTest: impl } = createRequire(import.meta.url)('./under-test.cjs');

/** @param {Record<string, string | undefined>} [env] @returns {boolean} */
export const isUnderTest = (env = process.env) => impl(env);
