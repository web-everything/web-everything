import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let fixtureRoot, originDir, referenceDir, sharedFixture, ghStubDir, base, poolRoot;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-double-handout-own-fixture-'));
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
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'lane-pool-double-handout-own-')); poolRoot = join(base, 'pool'); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); sharedFixture.restore(); });

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=double-handout', '--branch=trunk', '--no-install', '--no-reap', '--no-free-list'];
const runPool = (args, env = {}) => {
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${ghStubDir}:${process.env.PATH}`, LANE_POOL_ROOT: poolRoot, CLAUDE_CODE_SESSION_ID: 'sess-A', ...env },
  });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
};
const laneDir = () => join(poolRoot, 'double-handout', 'lane-1');
const marker = () => join(laneDir(), '.git', '.lane-lease');
const readLease = () => JSON.parse(readFileSync(marker(), 'utf8'));
const provision = (count = 1) => expect(runPool(['provision', `--count=${count}`, ...poolArgs()]).code).toBe(0);
const acquire = (...extra) => runPool(['acquire', '--lane=1', '--session=fix-9', ...poolArgs(), ...extra]);
const release = (...extra) => runPool(['release', '--lane=1', '--force', ...poolArgs(), ...extra]);

async function pausedAcquire(extra, mutate, { auto = false, barrierEnv = 'LANE_POOL_TEST_AFTER_CLAIM_BARRIER' } = {}) {
  const barrier = join(base, 'after-claim');
  const child = spawn('node', [SCRIPT, 'acquire', ...(auto ? [] : ['--lane=1']), '--session=fix-9', ...poolArgs(), ...extra], {
    env: { ...process.env, PATH: `${ghStubDir}:${process.env.PATH}`, LANE_POOL_ROOT: poolRoot,
      CLAUDE_CODE_SESSION_ID: 'sess-A', [barrierEnv]: barrier },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const result = new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolveResult({ code, out, err }));
  });
  try {
    const deadline = Date.now() + 8_000;
    while (!existsSync(`${barrier}.ready`) && Date.now() < deadline && child.exitCode === null) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(existsSync(`${barrier}.ready`), err).toBe(true);
    mutate();
    writeFileSync(`${barrier}.go`, '');
    return await result;
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await result;
  }
}

// Each test owns its pool; no production session listing or remote GitHub calls are needed.
describe('a live lease cannot be handed to a second session', () => {
  it('refuses a reaper release judged against an older holder; auto-pick gets lane-2', () => {
    provision(2);
    expect(acquire().code).toBe(0);
    const original = readFileSync(marker(), 'utf8');
    const refused = release('--expect-holder=older-holder');
    expect(refused.code).toBe(0);
    expect(refused.err).toContain('lease is no longer the one the caller judged');
    expect(readFileSync(marker(), 'utf8')).toBe(original);
    const second = runPool(['acquire', '--session=other', ...poolArgs()], { CLAUDE_CODE_SESSION_ID: 'sess-B' });
    expect(second.code).toBe(0);
    expect(second.out.trim()).toBe(join(poolRoot, 'double-handout', 'lane-2'));
  });

  it('still releases a matching judged holder and acquiredAt', () => {
    provision();
    expect(acquire().code).toBe(0);
    const lease = readLease();
    expect(release(`--expect-holder=${lease.holder}`, `--expect-acquired-at=${lease.acquiredAt}`).code).toBe(0);
    expect(existsSync(marker())).toBe(false);
  });

  it('refuses a matching holder with a different judged acquiredAt, including legacy timestamp-only releases', () => {
    provision();
    expect(acquire().code).toBe(0);
    const original = readFileSync(marker(), 'utf8');
    expect(release(`--expect-holder=${readLease().holder}`, '--expect-acquired-at=old').code).toBe(0);
    expect(readFileSync(marker(), 'utf8')).toBe(original);
    expect(release('--expect-acquired-at=old').code).toBe(0);
    expect(readFileSync(marker(), 'utf8')).toBe(original);
    expect(release(`--expect-acquired-at=${readLease().acquiredAt}`).code).toBe(0);
    expect(existsSync(marker())).toBe(false);
  });

  it.each(['delete', 'replace'])('fails without stdout or a reset when its lease is lost mid-acquire (%s)', async (mode) => {
    provision();
    const head = git(['rev-parse', 'HEAD'], laneDir());
    // Make the reset target different from the lane's current HEAD.
    writeFileSync(join(referenceDir, 'file.txt'), 'v2\n');
    git(['add', 'file.txt'], referenceDir);
    git(['commit', '--quiet', '-m', 'v2'], referenceDir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/trunk'], referenceDir);
    let foreign;
    const result = await pausedAcquire([], () => {
      foreign = JSON.stringify({ ...readLease(), holder: 'foreign-holder', session: 'other' });
      if (mode === 'delete') rmSync(marker());
      else writeFileSync(marker(), foreign);
    });
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('lease lost mid-acquire');
    expect(result.out).toBe('');
    expect(git(['rev-parse', 'HEAD'], laneDir())).toBe(head);
    if (mode === 'replace') expect(readFileSync(marker(), 'utf8')).toBe(foreign);
    else expect(existsSync(marker())).toBe(false);
  }, 20_000);

  it('recovery requires the matching live holder and never recreates a released marker', () => {
    provision();
    expect(acquire().code).toBe(0);
    const holder = readLease().holder;
    expect(acquire(`--expect-holder=${holder}`).code).toBe(0);
    expect(readLease().holder).toBe(holder);
    const original = readFileSync(marker(), 'utf8');
    expect(acquire('--expect-holder=WRONG').code).not.toBe(0);
    expect(readFileSync(marker(), 'utf8')).toBe(original);
    expect(release(`--expect-holder=${holder}`).code).toBe(0);
    expect(acquire(`--expect-holder=${holder}`).code).not.toBe(0);
    expect(existsSync(marker())).toBe(false);
  });

  it('recovery refuses an expired matching holder without modifying the marker', () => {
    provision();
    expect(acquire().code).toBe(0);
    const lease = readLease();
    lease.acquiredAt = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    delete lease.renewedAt;
    const original = JSON.stringify(lease);
    writeFileSync(marker(), original);
    expect(acquire(`--expect-holder=${lease.holder}`).code).not.toBe(0);
    expect(readFileSync(marker(), 'utf8')).toBe(original);
  });

  it('a failed base acquire removes only its own claim on a free lane', () => {
    provision();
    expect(acquire('--base=does-not-exist').code).not.toBe(0);
    expect(existsSync(marker())).toBe(false);
  });

  it('a refused bad-base acquire preserves a foreign replacement during the claim window', async () => {
    provision();
    let foreign;
    const result = await pausedAcquire(['--base=does-not-exist'], () => {
      foreign = JSON.stringify({ ...readLease(), holder: 'foreign-holder', session: 'other' });
      writeFileSync(marker(), foreign);
    });
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('lease lost mid-acquire');
    expect(readFileSync(marker(), 'utf8')).toBe(foreign);
  }, 20_000);

  it.each(['replace', 'claim'])('own-lease re-acquire fails without clobbering a foreign lease or resetting HEAD (%s)', async (mode) => {
    provision();
    expect(acquire().code).toBe(0);
    const head = git(['rev-parse', 'HEAD'], laneDir());
    // A successful re-acquire would reset to this newer origin commit.
    writeFileSync(join(referenceDir, 'file.txt'), 'v2\n');
    git(['add', 'file.txt'], referenceDir);
    git(['commit', '--quiet', '-m', 'v2'], referenceDir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/trunk'], referenceDir);
    let foreign;
    const result = await pausedAcquire([], () => {
      if (mode === 'replace') {
        foreign = JSON.stringify({ ...readLease(), holder: 'foreign-holder', session: 'other', ownerSession: 'sess-B' });
        writeFileSync(marker(), foreign);
      } else {
        rmSync(marker());
        const second = runPool(['acquire', '--lane=1', '--session=other', '--no-reset', ...poolArgs()], { CLAUDE_CODE_SESSION_ID: 'sess-B' });
        expect(second.code, second.err).toBe(0);
        foreign = readFileSync(marker(), 'utf8');
      }
    }, { barrierEnv: 'LANE_POOL_TEST_RENEWAL_BARRIER' });
    expect(result.code).not.toBe(0);
    expect(result.out).toBe('');
    expect(readFileSync(marker(), 'utf8')).toBe(foreign);
    expect(git(['rev-parse', 'HEAD'], laneDir())).toBe(head);
  }, 20_000);

  it('own-lease re-acquire fails if an exclusive claimant wins after marker removal', async () => {
    provision();
    expect(acquire().code).toBe(0);
    const originalHolder = readLease().holder;
    const head = git(['rev-parse', 'HEAD'], laneDir());
    const workingFile = join(laneDir(), 'file.txt');
    writeFileSync(workingFile, 'working holder edit\n');
    let foreign;
    const result = await pausedAcquire([], () => {
      expect(existsSync(marker())).toBe(false);
      // This exercises the explicitly permitted gap winner, without resetting the occupant's work.
      const second = runPool(['acquire', '--lane=1', '--session=other', '--no-reset', ...poolArgs()], { CLAUDE_CODE_SESSION_ID: 'sess-B' });
      expect(second.code, second.err).toBe(0);
      expect(readLease().holder).not.toBe(originalHolder);
      foreign = readFileSync(marker(), 'utf8');
    }, { barrierEnv: 'LANE_POOL_TEST_RENEWAL_AFTER_TAKE_BARRIER' });
    expect(result.code).not.toBe(0);
    expect(result.out).toBe('');
    expect(readFileSync(marker(), 'utf8')).toBe(foreign);
    expect(git(['rev-parse', 'HEAD'], laneDir())).toBe(head);
    expect(readFileSync(workingFile, 'utf8')).toBe('working holder edit\n');
  }, 20_000);

  it('auto-pick skips a lost claim and hands out the next candidate', async () => {
    provision(2);
    const result = await pausedAcquire([], () => {
      writeFileSync(marker(), JSON.stringify({ ...readLease(), holder: 'foreign-holder', session: 'other' }));
    }, { auto: true });
    expect(result.code).toBe(0);
    expect(result.err).toContain('lease lost mid-acquire');
    expect(result.out.trim()).toBe(join(poolRoot, 'double-handout', 'lane-2'));
    expect(readLease().holder).toBe('foreign-holder');
  }, 20_000);
});
