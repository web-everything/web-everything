import { defineConfig } from 'vitest/config';
import { hermeticGitEnv, weAlias } from './vitest.shared';

/** R1063a real-process tier — scheduled, never a PR gate. See real-tests.yml. */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    globalSetup: ['./vitest.globalSetup.mjs'],
    env: { WE_TEST_SANDBOX: '0', WE_TEST_HERMETIC: '0', ...hermeticGitEnv() },
    include: ['**/*.real.test.mjs'],
    exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
    passWithNoTests: true,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 5 * 60_000,
  },
  resolve: { alias: weAlias },
});
