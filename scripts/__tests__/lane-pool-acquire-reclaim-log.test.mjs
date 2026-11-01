/**
 * Smoke-acquire fix (live 2026-11-01, rebuild of main 86eeb484): the rebuild smoke's `acquire` claimed lane-33,
 * printed "reclaiming 127 local commit(s) … safe to drop", then REFUSED the reset (a parked fixer's lane-hold) and
 * failed with "no free lane" — but stderr ended inside the commit listing (macOS async pipe + `process.exit`), so
 * the smoke reported the reclaim line as the failure. Real CLI, throwaway pool: the reclaim line is printed only
 * when the reset really runs, the listing is bounded, unique work is still never dropped, and the `✗` reason
 * always reaches a slow reader.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';

const SCRIPT = resolve('scripts/lane-pool.mjs');
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t.t'];
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }).trim();
let fixtureRoot, sharedFixture, origin, reference, base, pool, bin;
const lane = (n) => join(pool, 'reclaimlog', `lane-${n}`);
const repoArgs = () => [`--origin=${origin}`, `--reference=${reference}`, '--name=reclaimlog', '--branch=main', '--no-install', '--no-reap'];
const env = () => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, LANE_POOL_ROOT: pool, LANE_POOL_NO_RECOVER: '1',
  LANE_POOL_ACQUIRE_GROWTH_MAX_NEW: '0', WE_LANE_HOLD: 'enforce', WE_AWAIT_VERIFY_STORE: join(base, 'await-store') });
function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, ...repoArgs()], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: env() });
  expect(r.error).toBeUndefined();
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const acquire = () => run(['acquire', '--no-free-list', '--json', '--session=reclaim-log-picker', '--wait-ms=0', '--cache-ttl-ms=0']);
/** `count` commits on lane `n`; when `pushEquivalent`, the same patches land on origin/main under different SHAs. */
function aheadCommits(n, count, { pushEquivalent }) {
  const dir = lane(n);
  for (let i = 1; i <= count; i++) {
    writeFileSync(join(dir, `c${n}-${i}.txt`), `${i}\n`);
    git([...ID, 'add', `c${n}-${i}.txt`], dir);
    git([...ID, 'commit', '--quiet', '-m', `lane ${n} work ${i}`], dir);
  }
  if (pushEquivalent) {
    const mbox = git(['format-patch', '--stdout', 'origin/main..HEAD'], dir);
    writeFileSync(join(base, 'p.mbox'), mbox + '\n');
    git(['-c', 'user.name=other', '-c', 'user.email=o@o.o', 'am', '--quiet', join(base, 'p.mbox')], reference);
    git(['push', '--quiet', 'origin', 'main'], reference);
    git(['fetch', '--quiet', 'origin'], dir);
  }
  return git(['rev-parse', 'HEAD'], dir);
}
const park = (n) => writeFileSync(join(lane(n), '.git', '.fix-await-verify'),
  JSON.stringify({ v: 1, pr: 123, requestedAt: new Date().toISOString(), session: `fixer-${n}` }));

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-reclaim-log-fixture-'));
  origin = join(fixtureRoot, 'origin.git');
  reference = join(fixtureRoot, 'reference');
  git(['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  git(['clone', '--quiet', origin, reference]);
  writeFileSync(join(reference, 'file.txt'), 'main tip\n');
  git(['add', 'file.txt'], reference);
  git([...ID, 'commit', '--quiet', '-m', 'fixture'], reference);
  git(['push', '--quiet', 'origin', 'main'], reference);
  sharedFixture = sharedRepos(fixtureRoot, [origin, reference]);
});
afterAll(() => sharedFixture?.dispose());
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-reclaim-log-'));
  pool = join(base, 'pool');
  bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); sharedFixture.restore(); });

describe('lane-pool acquire reclaim log', () => {
  it('a held lane with only patch-equivalent commits is skipped WITHOUT a "reclaiming … safe to drop" line', () => {
    expect(run(['provision', '--count=2']).code).toBe(0);
    const head = aheadCommits(1, 3, { pushEquivalent: true });
    park(1);
    const r = acquire();
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).lane).toBe(2);
    expect(r.err).toContain('lane-1: reset REFUSED — lane-hold:');
    expect(r.err).not.toContain('reclaiming');
    expect(git(['rev-parse', 'HEAD'], lane(1))).toBe(head);
  }, 120_000);

  it('reclaims an unheld patch-equivalent lane and bounds the dropped-commit listing', () => {
    expect(run(['provision', '--count=1']).code).toBe(0);
    const head = aheadCommits(1, 25, { pushEquivalent: true });
    const r = acquire();
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).lane).toBe(1);
    expect(r.err).toContain('lane-1: reclaiming 25 local commit(s), already patch-equivalent');
    expect(r.err.match(/^ {4}[0-9a-f]{7,} lane 1 work \d+$/gm)).toHaveLength(20);
    expect(r.err).toContain(`… and 5 more (full list: git log --oneline origin/main..${head})`);
    expect(git(['rev-parse', 'HEAD'], lane(1))).toBe(git(['rev-parse', 'origin/main'], lane(1)));
  }, 120_000);

  it('never drops a lane with a unique unpushed commit (skips it to the next lane)', () => {
    expect(run(['provision', '--count=2']).code).toBe(0);
    const head = aheadCommits(1, 1, { pushEquivalent: false });
    const r = acquire();
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).lane).toBe(2);
    expect(r.err).not.toContain('reclaiming');
    expect(git(['rev-parse', 'HEAD'], lane(1))).toBe(head);
  }, 120_000);

  it('delivers the whole stderr, ✗ reason included, to a reader that only drains after exit', async () => {
    // One fail() write far larger than a pipe buffer, then process.exit(1): with an async pipe the tail is lost.
    // Many short unknown flags (one huge argv string hits E2BIG): fail() lists them all in ONE ~200KB line.
    const flags = Array.from({ length: 2000 }, (_, i) => `--unknown-${String(i).padStart(4, '0')}-${'x'.repeat(90)}`);
    const child = spawn(process.execPath, [SCRIPT, 'status', ...flags], { stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANE_POOL_ROOT: pool } }); // small env: argv+env stay under ARG_MAX
    const exited = new Promise((done) => child.on('exit', done));
    child.stderr.pause();
    await new Promise((done) => setTimeout(done, 1_500)); // a stalled reader: the pipe fills meanwhile
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { err += d; });
    // Bounded: with the old async pipe the dropped tail never arrives, so stop reading after 5s and assert.
    await new Promise((done) => { child.stderr.on('end', done).resume(); setTimeout(done, 5_000).unref(); });
    const code = await exited;
    expect(code).toBe(1);
    expect(err).toContain('unrecognized flag(s)');
    expect(err).toContain('full flag list');
    expect(existsSync(pool)).toBe(false);
  }, 60_000);
});
