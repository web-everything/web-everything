import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';

const script = resolve('scripts/lane-pool.mjs');
let fixture, origin, reference, base, poolRoot;
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const lane = n => join(poolRoot, 'removedrytest', `lane-${n}`);
function run(args) {
  return spawnSync(process.execPath, [script, ...args, `--origin=${origin}`, `--reference=${reference}`,
    '--name=removedrytest', '--branch=main', '--no-install'], {
    encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    env: withGhStub({ ...process.env, LANE_POOL_ROOT: poolRoot }),
  });
}
beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'lane-remove-fixture-'));
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
  base = mkdtempSync(join(tmpdir(), 'lane-remove-dry-'));
  poolRoot = join(base, 'pool');
  const result = run(['provision', '--count=2']);
  expect(result.status, result.stderr).toBe(0);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  fixture.restore();
});

describe('lane-pool remove dry-run', () => {
  it('remove --lane=N --dry-run prints would remove and leaves the directory and contents intact', () => {
    const result = run(['remove', '--lane=1', '--dry-run']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/would remove/i);
    expect(existsSync(lane(1))).toBe(true);
    expect(readFileSync(join(lane(1), 'file.txt'), 'utf8')).toBe('v1\n');
  });
  it('remove --lane=N without dry-run still removes the directory (control)', () => {
    const result = run(['remove', '--lane=1']);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(lane(1))).toBe(false);
    expect(existsSync(lane(2))).toBe(true);
  });
  it('remove --all --dry-run removes nothing', () => {
    const result = run(['remove', '--all', '--dry-run']);
    expect(result.status, result.stderr).toBe(0);
    for (const n of [1, 2]) {
      expect(existsSync(lane(n))).toBe(true);
      expect(readFileSync(join(lane(n), 'file.txt'), 'utf8')).toBe('v1\n');
    }
  });
});
