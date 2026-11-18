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
    env: { WE_TEST_SANDBOX: '0', ...hermeticGitEnv() },
    include: ['**/*.real.test.mjs'],
    exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
    // Scaffold only: zero files is fine until the first real test lands, then this flips to false (the
    // real-process-guard manifest check already fails any listed or tracked file that does not run a process).
    passWithNoTests: true,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 5 * 60_000,
  },
  resolve: { alias: weAlias },
});
