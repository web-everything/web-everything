import { defineConfig } from 'vitest/config';
import { hermeticGitEnv, weAlias } from './vitest.shared';

/** R1063a real-process tier — scheduled, never a PR gate. See real-tests.yml. */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    globalSetup: ['./vitest.globalSetup.mjs'],
    // Only the sandbox strip is lifted (real subprocesses need real env roots). Hermetic stays ON by default:
    // credential isolation (fake gh shim, no live GitHub/backlog reads, scrubbed env) applies to the real tier too.
    env: { WE_TEST_SANDBOX: '0', WE_TEST_HERMETIC: '1', ...hermeticGitEnv() },
    include: ['**/*.real.test.mjs'],
    exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
    // Vitest's default rejects empty collections; the inventory guard also rejects an empty manifest.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 5 * 60_000,
  },
  resolve: { alias: weAlias },
});
