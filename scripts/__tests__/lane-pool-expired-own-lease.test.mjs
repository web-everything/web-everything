/**
 * @file scripts/__tests__/lane-pool-expired-own-lease.test.mjs
 * @description lane-lease-occupant (2026-10-22). An EXPIRED lease is never silently re-used by its old holder:
 *   re-acquiring it goes through the stale take-over (fresh holder slug, journalled expiry), so the old slug stops
 *   proving anything. And an acquirer that gets a lane back refuses to reset over uncommitted work it does not own.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let fixtureRoot, originDir, referenceDir, sharedFixture, ghStubDir, base, poolRoot;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-expired-own-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');
  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'HEAD:refs/heads/trunk'], referenceDir);
  ghStubDir = join(fixtureRoot, 'ghstub');
  mkdirSync(ghStubDir, { recursive: true });
  writeFileSync(join(ghStubDir, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});
afterAll(() => { sharedFixture?.dispose(); rmSync(fixtureRoot, { recursive: true, force: true }); });
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'lane-pool-expired-own-')); poolRoot = join(base, 'pool'); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); sharedFixture.restore(); });

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=expired', '--branch=trunk', '--no-install', '--no-reap', '--no-free-list'];
const runPool = (args, env = {}) => {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${ghStubDir}:${process.env.PATH}`, LANE_POOL_ROOT: poolRoot, CLAUDE_CODE_SESSION_ID: 'sess-A', ...env },
  });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
};
const laneDir = () => join(poolRoot, 'expired', 'lane-1');
const marker = () => join(laneDir(), '.git', '.lane-lease');
const readLease = () => JSON.parse(readFileSync(marker(), 'utf8'));
const age = (minutes) => { const l = readLease(); l.acquiredAt = new Date(Date.now() - minutes * 60_000).toISOString(); delete l.renewedAt; writeFileSync(marker(), JSON.stringify(l)); };

describe('an expired own lease is never re-used in place', () => {
  it('a LIVE re-acquire by the same session keeps its slug (unchanged behaviour)', () => {
    expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
    expect(runPool(['acquire', '--lane=1', ...poolArgs(), '--session=me']).code).toBe(0);
    const slug = readLease().holder;
    expect(runPool(['acquire', '--lane=1', ...poolArgs(), '--session=me']).code).toBe(0);
    expect(readLease().holder).toBe(slug);
  });
  it('an EXPIRED re-acquire by the same session mints a fresh slug, so the old one stops proving anything', () => {
    expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
    expect(runPool(['acquire', '--lane=1', ...poolArgs(), '--session=me']).code).toBe(0);
    const oldSlug = readLease().holder;
    age(300);
    const again = runPool(['acquire', '--lane=1', ...poolArgs(), '--session=me']);
    expect(again.code).toBe(0);
    expect(readLease().holder).not.toBe(oldSlug);
    expect(Date.now() - Date.parse(readLease().acquiredAt)).toBeLessThan(60_000);
  });
  it('adopt prints the holder slug the occupant must assert', () => {
    expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
    expect(runPool(['acquire', '--lane=1', ...poolArgs(), '--session=me']).code).toBe(0);
    const r = runPool(['adopt', '--lane=1', ...poolArgs()]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`holder slug: ${readLease().holder}`);
  });
});

describe('getting a lane back never resets over work the acquirer does not own', () => {
  it('a stale take-over of a lane with uncommitted changes is refused and the lane is left as it was', () => {
    expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
    expect(runPool(['acquire', '--lane=1', ...poolArgs(), '--session=first'], { CLAUDE_CODE_SESSION_ID: 'sess-first' }).code).toBe(0);
    writeFileSync(join(laneDir(), 'file.txt'), 'in-flight edit\n');
    age(300);
    const r = runPool(['acquire', '--lane=1', ...poolArgs(), '--session=second'], { CLAUDE_CODE_SESSION_ID: 'sess-second' });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/uncommitted change/);
    expect(readFileSync(join(laneDir(), 'file.txt'), 'utf8')).toBe('in-flight edit\n');
  });
});
