import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';

const script = resolve('scripts/lane-pool.mjs');
let fixture, origin, reference, base, poolRoot;
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const lane = n => join(poolRoot, 'capcounttest', `lane-${n}`);
function run(args) {
  return spawnSync(process.execPath, [script, ...args, `--origin=${origin}`, `--reference=${reference}`,
    '--name=capcounttest', '--branch=main', '--no-install'], {
    encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    env: withGhStub({ ...process.env, LANE_POOL_ROOT: poolRoot, LANE_POOL_HARD_MAX: '3',
      LANE_POOL_ACQUIRE_GROWTH_MAX_NEW: '1' }),
  });
}
function hold(count) {
  const provision = run(['provision', `--count=${count}`]);
  expect(provision.status, provision.stderr).toBe(0);
  for (let n = 1; n <= count; n++) {
    const result = run(['acquire', `--lane=${n}`, '--no-reset', '--no-reap', `--session=foreign-holder-${n}`]);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(lane(n), '.git', '.lane-lease'), 'utf8')).toContain(`foreign-holder-${n}`);
  }
}
const acquire = () => run(['acquire', '--no-reap', '--no-free-list', '--wait-ms=0', '--session=picker']);
beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'lane-cap-count-fixture-'));
  origin = join(root, 'origin.git');
  reference = join(root, 'reference');
  git(['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  git(['clone', '--quiet', origin, reference]);
  writeFileSync(join(reference, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], reference);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], reference);
  git(['push', '--quiet', 'origin', 'main'], reference);
  fixture = sharedRepos(root, [origin, reference]);
});
afterAll(() => fixture?.dispose());
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-cap-count-'));
  poolRoot = join(base, 'pool');
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  fixture.restore();
});

describe('lane-pool acquire counts valid lanes for its hard cap', () => {
  it('ignores lane-999999 and grows lane-3 when the two real lanes are leased', () => {
    hold(2);
    mkdirSync(lane(999999));
    const result = acquire();
    expect(result.stdout + result.stderr).not.toMatch(/already at its hard cap/i);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/lane-3$/);
    expect(existsSync(join(lane(3), '.git'))).toBe(true);
    expect(readFileSync(join(lane(3), '.git', '.lane-lease'), 'utf8')).toContain('picker');
  });
  it('ignores a stray lane-abc directory without crashing or counting it toward the cap', () => {
    hold(2);
    mkdirSync(join(poolRoot, 'capcounttest', 'lane-abc'));
    const result = acquire();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toMatch(/already at its hard cap/i);
    expect(result.stdout.trim()).toMatch(/lane-3$/);
    expect(existsSync(join(lane(3), '.git'))).toBe(true);
  });
  it('fails with the hard cap message when all three real lanes are leased (control)', () => {
    hold(3);
    const result = acquire();
    expect(result.status).not.toBeNull();
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/hard cap/i);
    expect(existsSync(lane(4))).toBe(false);
    for (const n of [1, 2, 3]) expect(existsSync(lane(n))).toBe(true);
  });
});
