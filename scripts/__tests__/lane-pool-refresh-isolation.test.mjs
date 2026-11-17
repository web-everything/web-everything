import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';

const SCRIPT = resolve('scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
let fixtureRoot, originDir, referenceDir, sharedFixture, base, poolRoot, oldHead;

function commit(contents) {
  writeFileSync(join(originDir, 'file.txt'), contents);
  git(['add', 'file.txt'], originDir);
  git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', contents], originDir);
  return git(['rev-parse', 'HEAD'], originDir);
}

function runPool(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, `--origin=${originDir}`,
    `--reference=${referenceDir}`, '--name=refresh-test', '--branch=main', '--no-install'], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
    env: withGhStub({ ...process.env, LANE_POOL_ROOT: poolRoot, LANE_SESSION: 'refresh-isolation-test' }),
  });
  return { code: r.status ?? 1, out: r.stdout || '', err: r.stderr || '' };
}

const lane = (n) => join(poolRoot, 'refresh-test', `lane-${n}`);
const head = (n) => git(['rev-parse', 'HEAD'], lane(n));

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-refresh-fixture-'));
  originDir = join(fixtureRoot, 'origin');
  referenceDir = join(fixtureRoot, 'reference');
  git(['init', '--quiet', '--initial-branch=main', originDir]);
  oldHead = commit('initial\n');
  git(['clone', '--quiet', originDir, referenceDir]);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});
afterAll(() => sharedFixture?.dispose());
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-refresh-isolation-'));
  poolRoot = join(base, 'pool');
  const r = runPool(['provision', '--count=3']);
  expect(r.code, r.err).toBe(0);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('lane-pool refresh isolation (3725 defect 2)', () => {
  it('--lane=N refreshes exactly the selected lane', () => {
    const next = commit('next\n');
    const r = runPool(['refresh', '--lane=2']);
    expect(r.code, r.err).toBe(0);
    expect(head(1)).toBe(oldHead);
    expect(head(2)).toBe(next);
    expect(head(3)).toBe(oldHead);
  });

  it('rejects a missing selected lane without refreshing any lane', () => {
    commit('next\n');
    const r = runPool(['refresh', '--lane=99']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('lane-99 does not exist');
    for (const n of [1, 2, 3]) expect(head(n)).toBe(oldHead);
  });

  it('without --lane refreshes all lanes', () => {
    const next = commit('next\n');
    const r = runPool(['refresh']);
    expect(r.code, r.err).toBe(0);
    for (const n of [1, 2, 3]) expect(head(n)).toBe(next);
  });

  it.each([
    ['refresh', ['refresh']],
    ['plain provision', ['provision', '--count=3']],
    ['acquirable provision', ['provision', '--count=2', '--acquirable', '--max-new=0']],
  ])('%s logs a broken origin, continues later lanes, and exits non-zero', (_name, args) => {
    const next = commit('next\n');
    git(['remote', 'set-url', 'origin', join(base, 'missing-origin')], lane(2));
    const r = runPool(args);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('lane-2: FAILED (');
    expect(head(1)).toBe(next);
    expect(head(2)).toBe(oldHead);
    expect(head(3)).toBe(next);
  });

  it('keeps a leased lane unreset even with --force while refreshing other lanes', () => {
    const acquired = runPool(['acquire', '--lane=2']);
    expect(acquired.code, acquired.err).toBe(0);
    const marker = join(lane(2), '.git', '.lane-lease');
    const lease = readFileSync(marker, 'utf8');
    writeFileSync(join(lane(2), 'file.txt'), 'leased work\n');
    const next = commit('next\n');
    const r = runPool(['refresh', '--force']);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain('lane-2: SKIPPED');
    expect(head(2)).toBe(oldHead);
    expect(readFileSync(join(lane(2), 'file.txt'), 'utf8')).toBe('leased work\n');
    expect(readFileSync(marker, 'utf8')).toBe(lease);
    expect(head(1)).toBe(next);
    expect(head(3)).toBe(next);
  });
});
