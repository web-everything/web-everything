import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  it.each([
    ['without force', []],
    ['with force', ['--force']],
  ])('rejects bare --lane %s before resetting or unmapping any lane', (_name, extra) => {
    commit('next\n');
    for (const n of [1, 2, 3]) {
      writeFileSync(join(lane(n), 'file.txt'), `dirty work ${n}\n`);
      writeFileSync(join(lane(n), 'untracked.txt'), `untracked work ${n}\n`);
    }
    const registry = join(referenceDir, '.claude', 'lane-ports.json');
    mkdirSync(join(referenceDir, '.claude'), { recursive: true });
    const mapping = JSON.stringify({
      101: { repo: 'refresh-test', lane: 1 },
      102: { repo: 'refresh-test', lane: 2 },
      103: { repo: 'refresh-test', lane: 3 },
    });
    writeFileSync(registry, mapping);
    const before = [1, 2, 3].map((n) => git(['status', '--porcelain'], lane(n)));

    const r = runPool(['refresh', '--lane', ...extra]);
    expect.soft(r.code, r.err).not.toBe(0);
    expect.soft(r.err).toContain('--lane requires a lane number');
    for (const n of [1, 2, 3]) {
      expect.soft(head(n)).toBe(oldHead);
      expect.soft(readFileSync(join(lane(n), 'file.txt'), 'utf8')).toBe(`dirty work ${n}\n`);
      expect.soft(git(['status', '--porcelain'], lane(n))).toBe(before[n - 1]);
    }
    expect(readFileSync(registry, 'utf8')).toBe(mapping);
  });

  it('rejects malformed lane numbers before refreshing any lane', () => {
    commit('next\n');
    for (const value of ['', '0', '01', '-1', '+1', '1.0', '1e0', '0x1', ' 1', '1 ', '1\n', '１', '1\u200b', '9007199254740993', '9'.repeat(400)]) {
      const r = runPool(['refresh', `--lane=${value}`, '--force']);
      expect(r.code, JSON.stringify(value)).not.toBe(0);
      expect(r.err, JSON.stringify(value)).toContain('--lane requires a lane number');
      for (const n of [1, 2, 3]) expect(head(n)).toBe(oldHead);
    }
  });

  it('rejects bare --lane in every other lane consumer before command-specific actions', () => {
    for (const command of ['acquire', 'release', 'status', 'path', 'remove', 'reclaim', 'keep', 'adopt', 'map', 'unmap']) {
      const r = runPool([command, '--lane', '--force']);
      expect(r.code, command).not.toBe(0);
      expect(r.err, command).toContain('--lane requires a lane number');
      for (const n of [1, 2, 3]) expect(head(n)).toBe(oldHead);
    }
  });

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
