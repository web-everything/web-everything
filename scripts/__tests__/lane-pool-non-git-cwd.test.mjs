/**
 * @file scripts/__tests__/lane-pool-non-git-cwd.test.mjs
 * @description builder-starved-2 (2026-10-07) — a dispatched prepare agent starts in a fresh scratch cwd that is
 *   not a git repo (#4174) and runs `node "<WE_ROOT>/scripts/lane-pool.mjs" acquire …` with no `--repo`. Live, every
 *   such acquire failed with `could not determine an origin URL` (#4560's prepare terminal), so no prepare ever got
 *   a lane. Outside a git work tree, `lane-pool.mjs` now resolves the checkout it lives in.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { checkoutRootFor } from '../lib/lane-pool-paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LANE_POOL_CLI = resolve(HERE, '..', 'lane-pool.mjs');

describe('lane-pool from a non-git scratch cwd', () => {
  it('checkoutRootFor prefers the cwd work tree, then the script checkout, never a bare non-git cwd', () => {
    expect(checkoutRootFor({ cwdTopLevel: '/w/lane-3', scriptCheckout: '/w/ctl', cwd: '/w/lane-3/scripts' })).toBe('/w/lane-3');
    expect(checkoutRootFor({ cwdTopLevel: null, scriptCheckout: '/w/ctl', cwd: '/w/.operations/dispatch/x' })).toBe('/w/ctl');
  });

  it('resolves the origin from the script checkout instead of failing (the live prepare failure)', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lane-pool-scratch-cwd-'));
    try {
      const r = spawnSync(process.execPath, [LANE_POOL_CLI, 'list'], {
        cwd: scratch, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, LANE_POOL_ROOT: join(scratch, 'pool') },
      });
      expect(r.stderr).not.toMatch(/could not determine an origin URL/);
      expect(r.status).toBe(0);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
});
