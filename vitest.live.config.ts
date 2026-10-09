import { defineConfig } from 'vitest/config';
import { hermeticGitEnv, weAlias } from './vitest.shared';
import { liveSuiteFiles, loadHermeticSettings } from './scripts/lib/hermetic-tests.mjs';

/**
 * THE SCHEDULED LIVE SUITE (card xcu4cqf) — `npm run test:live`. The only place a test may reach live GitHub,
 * remote refs or real host state. Its file list is `liveSuite.tests` in we:scripts/hermetic-tests.settings.json
 * (each with a reason); every BLOCKING config (unit, integration, soak) excludes those files and runs hermetic.
 *
 * NEVER a PR or main gate: it runs on a schedule (we:.github/workflows/live-tests.yml, cron = the settings'
 * `liveSuite.schedule.cron`), and a failure opens/updates a `health-smell` issue instead of turning anything red.
 * Live data drifts on its own; that is a health signal about the outside world, not a defect in the tree.
 */
const files = liveSuiteFiles(loadHermeticSettings());

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    globalSetup: ['./vitest.globalSetup.mjs'],
    // Both off: real env, real `gh` on PATH, no live-access guard. This is the one config allowed to say so.
    env: { WE_TEST_SANDBOX: '0', WE_TEST_HERMETIC: '0', ...hermeticGitEnv() },
    include: files,
    passWithNoTests: true,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 5 * 60_000,
  },
  resolve: { alias: weAlias },
});
