/**
 * @file scripts/__tests__/lane-pool-vitest-real-root-guard.test.mjs
 * @description Proof of #3383's structural fix for the 2026-09-23 incident: PR #2542's O(lanes×heads)
 *   `git cherry` loop in `lane-pool.mjs` was multiplied because two test files spawned the real
 *   `dispatch-plan.mjs` / `conveyor-state.mjs` CLIs with no pool-root override, which in turn shelled the REAL
 *   `lane-pool.mjs list --acquirable` / `status --json` against the shared `~/workspace/.lanes` pool — 13
 *   concurrent lane test suites hammered it at once (load average 70-88; drain/review/every test stalled over
 *   an hour). `lane-pool-paths.mjs#guardedPoolRoot` closes this at the ROOT: `lane-pool.mjs` now refuses to
 *   even start when it is a vitest worker (`VITEST` set) and the caller passed neither an explicit
 *   `LANE_POOL_ROOT` override nor the deliberate `WE_ALLOW_REAL_LANE_POOL_IN_TESTS=1` escape hatch.
 *
 *   Two layers, matching the two places this can go wrong:
 *     1. UNIT — `guardedPoolRoot` called directly (no subprocess): pins the decision table itself (throws /
 *        doesn't, for every combination of VITEST / override / opt-out).
 *     2. INTEGRATION (the RED → GREEN proof the operator asked for) — spawns the REAL `lane-pool.mjs status
 *        --json` CLI from THIS repo's own real checkout root, under `VITEST=true`:
 *          RED:   no `LANE_POOL_ROOT` → refuses (exit non-zero), naming the real pool root it would otherwise
 *                 have hammered — this is the exact failure mode #2547 patched a symptom of and this item
 *                 makes structurally impossible instead.
 *          GREEN: an explicit `LANE_POOL_ROOT` override → the identical command now succeeds.
 *        (`status` is read-only; even the RED case never touches the real pool — the guard fires before any
 *        filesystem/git read happens.)
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { guardedPoolRoot, defaultPoolRoot } from '../lib/lane-pool-paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LANE_POOL_CLI = resolve(HERE, '..', 'lane-pool.mjs');
// The real checkout this test file itself lives in — spawning from here resolves the SAME real pool root the
// 2026-09-23 incident hammered (whatever machine/account this happens to run on), which is exactly what makes
// the integration proof below faithful rather than synthetic.
const REAL_CHECKOUT_ROOT = resolve(HERE, '..', '..');

describe('#3383 unit — guardedPoolRoot decision table', () => {
  it('throws under VITEST with no LANE_POOL_ROOT and no opt-out', () => {
    expect(() => guardedPoolRoot('/some/checkout', { VITEST: 'true' })).toThrow(/refusing to resolve the REAL lane-pool root/);
  });

  it('does NOT throw under VITEST when an explicit LANE_POOL_ROOT override is present', () => {
    const env = { VITEST: 'true', LANE_POOL_ROOT: '/tmp/some-private-pool' };
    expect(() => guardedPoolRoot('/some/checkout', env)).not.toThrow();
    expect(guardedPoolRoot('/some/checkout', env)).toBe(defaultPoolRoot('/some/checkout', env));
  });

  it('does NOT throw under VITEST when the explicit opt-out is set, even with no LANE_POOL_ROOT', () => {
    const env = { VITEST: 'true', WE_ALLOW_REAL_LANE_POOL_IN_TESTS: '1' };
    expect(() => guardedPoolRoot('/some/checkout', env)).not.toThrow();
  });

  it('does NOT throw outside vitest (VITEST unset) regardless of overrides — real usage is unaffected', () => {
    expect(() => guardedPoolRoot('/some/checkout', {})).not.toThrow();
  });
});

describe('#3383 integration — lane-pool.mjs itself refuses the real root under vitest, then succeeds once overridden', () => {
  it('RED: `status --json` under VITEST with no LANE_POOL_ROOT/opt-out exits non-zero, naming the real pool root', () => {
    const env = { ...process.env, VITEST: 'true' };
    delete env.LANE_POOL_ROOT;
    delete env.WE_ALLOW_REAL_LANE_POOL_IN_TESTS;
    const realRoot = defaultPoolRoot(REAL_CHECKOUT_ROOT, env);
    const r = spawnSync('node', [LANE_POOL_CLI, 'status', '--json'], { cwd: REAL_CHECKOUT_ROOT, encoding: 'utf8', env });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/refusing to resolve the REAL lane-pool root/);
    expect(r.stderr).toContain(realRoot);
  });

  it('GREEN: the identical command succeeds once a private LANE_POOL_ROOT is passed', () => {
    const privatePoolRoot = mkdtempSync(join(tmpdir(), 'lane-pool-guard-proof-'));
    try {
      const env = { ...process.env, VITEST: 'true', LANE_POOL_ROOT: privatePoolRoot };
      const out = execFileSync('node', [LANE_POOL_CLI, 'status', '--json'], { cwd: REAL_CHECKOUT_ROOT, encoding: 'utf8', env });
      const status = JSON.parse(out);
      // The private pool has no lanes provisioned in it — proves this ran against the PRIVATE root, not the
      // real shared one (which has dozens). `status.root` is the repo's poolDir (`<LANE_POOL_ROOT>/<repo>`).
      expect(status.root.startsWith(privatePoolRoot)).toBe(true);
      expect(status.lanes).toEqual([]);
    } finally {
      rmSync(privatePoolRoot, { recursive: true, force: true });
    }
  });
});

it('suppresses real state with WE_UNDER_TEST alone', () => {
  expect(() => guardedPoolRoot('/some/checkout', { WE_UNDER_TEST: '1' })).toThrow(/refusing to resolve the REAL lane-pool root/);
});
