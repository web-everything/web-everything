import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import micromatch from 'micromatch';
import config from '../../vitest.config.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const poolFor = file => config.test.poolMatchGlobs.find(([glob]) => micromatch.isMatch(file, glob))?.[1]
  ?? config.test.pool;

describe('simulator timezone isolation', () => {
  it('imports the real config through Vite and selects forks for absolute simulator test paths', () => {
    // The lane root contains hidden directories; relative globs do not match Vitest's absolute paths.
    for (const file of ['engine.test.mjs', 'nested/future.test.mjs']) {
      expect(poolFor(resolve(repoRoot, 'packages/longshore/sim-engine/__tests__', file))).toBe('forks');
    }
  });

  it('keeps unrelated tests in the thread pool', () => {
    for (const file of [
      'scripts/__tests__/vitest-worker-cap.test.mjs',
      'packages/longshore/other/__tests__/engine.test.mjs',
      'packages/longshore/sim-engine-other/__tests__/engine.test.mjs',
    ]) expect(poolFor(resolve(repoRoot, file))).toBe('threads');
  });
});
