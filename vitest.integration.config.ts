import { defineConfig } from 'vitest/config';
import { maxTestWorkers, weAlias } from './vitest.shared';

/**
 * The REAL-git / real-subprocess tier `vitest.config.ts` excludes (see that file's `test.exclude` comment
 * for the full rationale). These files shell `git init`/`clone`/`push` or spawn real `node` children per
 * test — proof-of-CLI-behavior fixtures, not pure-logic unit tests — so they're slow in a way isolation
 * inside the shared suite can only ever redistribute, never remove. Splitting them into their own run:
 *   - keeps them off the `threads` pool the ~2000-file unit suite shares, so they can't inflate each
 *     other's cost under contention (the original motivation for the handful pinned to `forks` below);
 *   - lets `npm run test:unit` (and everything that shells it — `verify-lane.mjs`'s local gate, `npm test`,
 *     `npm run verify`) skip real git/subprocess cost entirely, including its own "sensitive surface, fall
 *     back to full" case — this file is what still proves the real behavior, in CI, before merge.
 * Run via `npm run test:integration:vitest`; wired into CI's `test` job (`.github/workflows/ci.yml`) so the
 * required pre-merge gate is unchanged — only the LOCAL, per-lane cost drops.
 *
 * Three of these were originally pinned to a single serial `forks` process for a CORRECTNESS reason, not
 * just speed — each measured NOT just slow but actively flaky under CPU contention (a wall-clock comparison
 * blown, a timeout tripped): `gate-entrypoint-integration.test.mjs`, `wake-cli.test.mjs`,
 * `dispatch-spawn-live.test.mjs`. `lane-pool-reap-on-acquire.test.mjs` joined them later (#x01b2gj) for the
 * IDENTICAL correctness reason — its own TTL-backdating cases flaked red under real host contention.
 * `lane-pool-reap-on-list-acquirable.test.mjs` (#3449) joins them for the SAME reason pre-emptively: it drives
 * the identical `reapDeadLeasesInPool` function through the identical real-subprocess TTL-backdating +
 * item-resolved-axis pattern as its `-reap-on-acquire` sibling, so the same contention-induced `gh pr list`
 * miss applies without needing to be independently observed first.
 * `stdout-flush.test.mjs` joins them for a DIFFERENT reason, found the hard
 * way (measured on this branch): left on the default `threads` pool alongside the other ~18 git-fixture
 * files, its two tests that spawn a real full `check-standards.mjs` scan went from 48.4s/39.7s (alone, in
 * the old unit suite) to 83s/72s (contending with everyone else's git subprocess spawns here) — the exact
 * contention problem this whole split exists to solve, recreated one tier down. Since vitest runs separate
 * pools CONCURRENTLY (only files WITHIN one pool serialize against each other), moving it into the isolated
 * `forks` pool below removes it from that contention AND stops it dragging the other ~18 files down, at the
 * cost of queuing behind its 3 forks-pool siblings (all small next to it) rather than the ~18-file `threads`
 * pool. Everything else stays on this config's default `threads` pool — with the ~2000-file unit suite no
 * longer sharing it, ordinary multi-worker parallelism is enough; they don't need to queue behind one
 * another the way `singleFork` would force.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'scripts/__tests__/stdout-flush.test.mjs',
      'scripts/__tests__/rust-scan-stdout-flush-parity.test.mjs',
      'scripts/__tests__/rust-scan-secret-scrub-parity.test.mjs',
      'scripts/__tests__/rust-scan-locus-prefix-parity.test.mjs',
      'scripts/__tests__/rust-scan-citation-check-parity.test.mjs',
      'scripts/__tests__/gate-entrypoint-integration.test.mjs',
      'scripts/operations/__tests__/wake-cli.test.mjs',
      'scripts/__tests__/lane-pool-acquire-base.test.mjs',
      'scripts/__tests__/publish-secret-gate.test.mjs',
      'scripts/operations/__tests__/dispatch-spawn-live.test.mjs',
      'scripts/__tests__/lane-pool-reserve.test.mjs',
      'scripts/__tests__/lane-pool-cross-pool.test.mjs',
      'scripts/__tests__/lane-pool-reap-on-acquire.test.mjs',
      'scripts/__tests__/lane-pool-siblings.test.mjs',
      'scripts/__tests__/lane-pool-acquirable.test.mjs',
      'scripts/__tests__/lane-pool-reap-on-list-acquirable.test.mjs',
      'scripts/__tests__/lane-pool-refresh-guard.test.mjs',
      'scripts/__tests__/lane-pool-release-ownership.test.mjs',
      'scripts/__tests__/lane-pool-item-map.test.mjs',
      'scripts/__tests__/lane-pool-release-item-map.test.mjs',
      'scripts/__tests__/lane-pool-ahead-provably-pushed-single-spawn.test.mjs',
      'scripts/__tests__/lane-pool-acquire-stale-origin.test.mjs',
      'scripts/__tests__/lane-pool-acquire-wait-ms.test.mjs',
      'scripts/__tests__/lane-pool-squash-merge-and-litter-acquirable.test.mjs',
      'scripts/__tests__/lane-pool-ahead-patch-equivalent-bounded-spawn.test.mjs',
      'scripts/__tests__/lane-pool-list-cache.test.mjs',
      'scripts/__tests__/lane-pool-hung-git-bounded.test.mjs',
      'scripts/__tests__/lane-pool-trim.test.mjs',
      'scripts/__tests__/lane-pool-acquirable-growth-cap.test.mjs',
      // #3383 — same tier: real throwaway origin/reference/pool, real spawned `lane-pool.mjs` acquire/provision
      // children, a PATH git shim for the remote-probe-failure case (mirrors its growth-cap sibling above).
      'scripts/__tests__/lane-pool-acquire-growth.test.mjs',
      'scripts/operations/__tests__/backlog-ops-integration.test.mjs',
      'scripts/operations/__tests__/dispatch-lane-integration.test.mjs',
      'scripts/operations/__tests__/gate-health-integration.test.mjs',
      'scripts/operations/__tests__/mutation-check-integration.test.mjs',
      'scripts/operations/__tests__/record-verdict-integration.test.mjs',
      'scripts/operations/__tests__/stage-pr-view-integration.test.mjs',
      // #xu2krte — real git-conflict fixture + real (fake, cost-nothing) `claude` CLI round trip.
      'scripts/conveyor/__tests__/parked-pr-conflict-dispatch-integration.test.mjs',
      'scripts/conveyor/__tests__/parked-pr-conflict-hung-gh-bounded.test.mjs',
    ],
    poolMatchGlobs: [
      ['scripts/__tests__/stdout-flush.test.mjs', 'forks'],
      ['scripts/__tests__/gate-entrypoint-integration.test.mjs', 'forks'],
      ['scripts/operations/__tests__/wake-cli.test.mjs', 'forks'],
      ['scripts/operations/__tests__/dispatch-spawn-live.test.mjs', 'forks'],
      // #x01b2gj — a fifth join, for the identical CORRECTNESS reason as the four above: its TTL-backdating
      // cases (the item-resolved AND pr-merged terminal axes) flaked red twice on 2026-08-30 under real
      // concurrent host load, passing clean in isolation. It spawns real `lane-pool.mjs` children (each
      // shelling real `git`/`gh` subprocesses) sharing the default `threads` pool with ~18 other
      // subprocess-heavy files; under contention those children compete for CPU/fork slots and the reap
      // decision's bounded `gh pr list` call (see the widened timeout in `scripts/lane-pool.mjs`) can miss
      // its terminal signal before the test asserts on it. Isolating it here removes that contention.
      ['scripts/__tests__/lane-pool-reap-on-acquire.test.mjs', 'forks'],
      // #3449 — a sixth join, pre-emptively, for the same reason: this file drives the identical
      // `reapDeadLeasesInPool` function through the identical real-subprocess TTL-backdating +
      // item-resolved-axis pattern as its sibling above, so the same contention risk applies by construction.
      ['scripts/__tests__/lane-pool-reap-on-list-acquirable.test.mjs', 'forks'],
    ],
    // #x1jcikc: default `threads` pool cap (see vitest.shared.ts#maxTestWorkers) — the handful of files
    // above are pinned to the SEPARATE `forks` pool's `singleFork: true` for a correctness reason (flaky
    // under contention), which this leaves untouched; everything else here still shares the uncapped
    // `threads` pool today, so it needs the same ceiling `vitest.config.ts` gets.
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: maxTestWorkers,
        minThreads: 1,
      },
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: weAlias,
  },
});
