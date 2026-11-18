import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { hermeticGitEnv, weAlias } from './vitest.shared';

// Derived from the manifest: zero listed files is the scaffold; once one is listed an empty collection fails.
const realTierFiles: string[] = JSON.parse(readFileSync(new URL('./scripts/settings/real-tier-manifest.json', import.meta.url), 'utf8')).realTierFiles;

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
    // Scaffold only: zero files is fine until the first real test lands, then this flips to false (the
    // real-process-guard manifest check already fails any listed or tracked file that does not run a process).
    passWithNoTests: realTierFiles.length === 0,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 5 * 60_000,
  },
  resolve: { alias: weAlias },
});
