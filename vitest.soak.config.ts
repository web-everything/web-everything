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
    // #xpc3krl — the real review + fix daemons, real rebuild/self-sync, a real bare remote (see the file
    // header above) need the real PATH/env this tier is built to exercise, so it opts OUT of
    // `vitest.setup.ts`'s sandbox-by-default (a fake `gh` on PATH, stripped WE_*/CONVEYOR_*/GH_*/CLAUDE_*
    // env) — the exact opposite of what this harness is FOR.
    env: { WE_TEST_SANDBOX: '0' },
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
    testTimeout: 15 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});
