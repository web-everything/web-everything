import { defineConfig } from 'vitest/config';
import { maxTestWorkers } from './vitest.shared';

/**
 * #4075 DAEMON SOAK HARNESS (card x0zg44l) — `npm run test:soak`. The real review + fix daemons, the real
 * rebuild/self-sync code, a real bare remote with main moving, fake GitHub + fake sessions; the invariants
 * checked after every tick (`scripts/conveyor/soak/soak.mjs`). Minutes, not seconds — so NOT in the unit suite
 * (`vitest.config.ts` only picks up `__tests__/` files; these live beside the harness as `*.soak.test.mjs`) and
 * not in the integration suite either: CI runs it as its own `daemon-soak` job, only on PRs that touch daemon
 * code (`.github/workflows/ci.yml`).
 *
 * `forks` pool: every scenario forks daemon hosts and many short-lived `node`/`git` children, the same reason the
 * simulator's own scenarios are pinned to `forks` in `vitest.integration.config.ts`. Files run in parallel (one
 * world each); tests inside a file run in order.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // tmp-leak fix: one private temp root per run, leak count reported + root removed at teardown
    // (scripts/lib/test-tmp-root.mjs; WE_TMP_LEAK_MODE / WE_TMP_LEAK_MAX).
    globalSetup: ['./vitest.globalSetup.mjs'],
    // #xpc3krl — the real review + fix daemons, real rebuild/self-sync, a real bare remote (see the file
    // header above) need the real PATH/env this tier is built to exercise, so it opts OUT of
    // `vitest.setup.ts`'s sandbox-by-default (a fake `gh` on PATH, stripped WE_*/CONVEYOR_*/GH_*/CLAUDE_*
    // env) — the exact opposite of what this harness is FOR.
    // ...but it IS hermetic (card xcu4cqf): the 2026-10-08 main-red incident was a soak scenario reading live
    // GitHub + the live origin/main backlog. Scenario worlds bring their own fake GitHub and state roots; a reach
    // past them into the real ones fails the scenario with `live GitHub/backlog access in test`.
    env: { WE_TEST_SANDBOX: '0', WE_TEST_HERMETIC: '1' },
    include: ['scripts/conveyor/soak/**/*.soak.test.mjs'],
    pool: 'forks',
    // heavy-enforce: the same per-run worker ceiling every other vitest config reads (vitest.shared.ts#maxTestWorkers,
    // `WE_VITEST_MAX_WORKERS`) — each soak world forks daemon hosts, so an uncapped forks pool is the costliest of all.
    poolOptions: {
      forks: {
        maxForks: maxTestWorkers,
        minForks: 1,
      },
    },
    // Must FAIL LOUDLY before the CI job's own `timeout-minutes` (25) cancels it: a test timeout equal to the job
    // timeout meant a hung scenario never produced a failure, only a cancelled job (PR #4235). Longest scenario: the
    // 50-tick baseline, 550s on a green run and 615s on a slow runner (it shares a shard with ~30 parallel scenarios),
    // so 10 min left no headroom (main red @ 8cd0b3d12). The baseline has since grown to ~1017s (green on cbb0db37,
    // 3s under 17 min) and timed out on 70001b92 at the 1020s limit with identical per-tick cost (main red 22:57Z), so
    // 17 min no longer had headroom either: 26 min keeps 1.5x and still fails loudly before the job's 40-min
    // `timeout-minutes` (leaving 14 min for checkout + npm ci + teardown).
    // Knob: WE_SOAK_TEST_TIMEOUT_MS (only a finite positive number is honoured; 0, negative or Infinity would
    // disable vitest's timeout and fall back to the default).
    testTimeout: Number.isFinite(Number(process.env.WE_SOAK_TEST_TIMEOUT_MS)) && Number(process.env.WE_SOAK_TEST_TIMEOUT_MS) > 0
      ? Number(process.env.WE_SOAK_TEST_TIMEOUT_MS)
      : 26 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});
