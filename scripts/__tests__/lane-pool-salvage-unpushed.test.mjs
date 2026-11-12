import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const script = resolve('scripts/lane-pool.mjs');
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const git = (args, cwd) => execFileSync(realGit, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let root, origin, primary, pool, lane, env, common;
const run = (command, args = [], extra = {}) => spawnSync(process.execPath, [script, command, ...common, ...args], {
  env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000,
});
const commit = (dir, value) => {
  writeFileSync(join(dir, 'work.txt'), value);
  git(['add', '.'], dir);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', value], dir);
  return git(['rev-parse', 'HEAD'], dir);
};
const events = () => readFileSync(join(root, 'git-log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const refs = () => git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/lane/', 'refs/heads/salvage/'], origin);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lane-salvage-'));
  origin = join(root, 'origin.git'); primary = join(root, 'primary'); pool = join(root, 'pool');
  git(['init', '--bare', '--initial-branch=main', origin]);
  git(['clone', origin, primary]);
  const initial = commit(primary, 'initial');
  // Local fixtures publish objects without network or a git push invocation.
  git(['fetch', primary, 'main:main'], origin);
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync, unlinkSync, existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_GIT_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (process.env.TEST_BAD_HEADS && args.includes('ls-remote') && args.at(-1) === 'refs/heads/*') { process.stdout.write('incomplete'); process.exit(0); }
if (process.env.TEST_FAIL_PUSH && args.includes('push')) process.exit(1);
if (process.env.TEST_COLLISION_ORIGIN && args.includes('push')) {
  const ref = args.at(-1).split(':').at(-1);
  const competing = spawnSync(${JSON.stringify(realGit)}, ['--git-dir', process.env.TEST_COLLISION_ORIGIN,
    'update-ref', ref, process.env.TEST_COLLISION_SHA], { stdio: 'inherit' });
  if (competing.status !== 0) process.exit(competing.status ?? 1);
  appendFileSync(process.env.TEST_COLLISION_RECORD, ref);
}

if (process.env.TEST_BAD_VERIFY && readFileSync(process.env.TEST_GIT_LOG, 'utf8').includes('\"push\"') && args.includes('ls-remote') && args.some(a => a.includes('salvage-lane-'))) {
  process.stdout.write('0'.repeat(40) + '\\t' + args.at(-1) + '\\n'); process.exit(0);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
if (result.status === 0 && process.cwd() === process.env.TEST_LEASE_LANE
    && ((process.env.TEST_LEASE_PHASE === 'fetch' && args.includes('fetch') && args.includes('origin'))
      || (process.env.TEST_LEASE_PHASE === 'checkout' && args.includes('checkout') && args.includes('-B'))
      || (process.env.TEST_LEASE_PHASE === 'clean' && args.includes('clean')))) {
  const marker = process.cwd() + '/.git/.lane-lease';
  const lease = JSON.parse(readFileSync(marker, 'utf8'));
  const mode = process.env.TEST_LEASE_CHANGE;
  writeFileSync(marker, mode === 'unreadable' ? '{' : JSON.stringify(mode === 'expired'
    ? { ...lease, acquiredAt: '2000-01-01T00:00:00.000Z' }
    : { ...lease, session: 'new-owner', holder: 'new-holder', acquiredAt: new Date().toISOString() }));
  if (mode === 'missing') unlinkSync(marker);
  // Represent the new occupant's work before returning from the interrupted provisioning step.
  writeFileSync(process.cwd() + '/work.txt', 'new occupant stash');
  const stashed = spawnSync(${JSON.stringify(realGit)}, ['stash', 'push', '-m', 'new occupant'], { stdio: 'inherit' });
  if (stashed.status !== 0) process.exit(stashed.status ?? 1);
  writeFileSync(process.env.TEST_LEASE_RECORD, existsSync(marker) ? readFileSync(marker, 'utf8') : 'missing');
}
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  // Private host state and deterministic liveness probes; no workstation agents or locks are touched.
  const preload = join(root, 'host.cjs');
  writeFileSync(preload, `const os = require('node:os');
const userInfo = os.userInfo;
os.userInfo = () => ({ ...userInfo(), homedir: process.env.TEST_HOST_HOME });
require('node:module').syncBuiltinESMExports();
if (process.env.TEST_WATCH_ONCE) global.setTimeout = () => {};`);
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
if (process.env.TEST_AGENTS === 'unknown') process.exit(1);
process.stdout.write(process.env.TEST_AGENTS || '[]');`, { mode: 0o755 });
  writeFileSync(join(bin, 'lsof'), `#!${process.execPath}
if (process.env.TEST_CWDS === 'unknown') process.exit(1);
if (process.env.TEST_LIVE_AFTER_PUSH && require('node:fs').readFileSync(process.env.TEST_GIT_LOG, 'utf8').includes('\"push\"')) {
  process.stdout.write('p999999\\nn' + process.env.TEST_LIVE_AFTER_PUSH + '\\n'); process.exit(0);
}
process.stdout.write(process.env.TEST_CWDS || '');`, { mode: 0o755 });
  env = { ...process.env, NODE_OPTIONS: `--require=${preload}`, TEST_HOST_HOME: root,
    VITEST: 'true', WE_TEST_HOST_LOAD1: '0', WE_TEST_HOST_MEMORY_MB: '999999',
    WE_HOST_CAPACITY_SIGNAL: 'load', WE_LANE_SALVAGE_QUIET_MIN: '0', PATH: bin + ':' + process.env.PATH, LANE_POOL_ROOT: pool,
    TEST_GIT_LOG: join(root, 'git-log'), LANE_POOL_AUTO_RECOVER: '0', LANE_POOL_NO_RECOVER: '1' };
  common = [`--origin=${origin}`, `--reference=${primary}`, '--name=salvage-test', '--branch=main', '--no-install'];
  const provision = run('provision', ['--count=2']);
  expect(provision.status, provision.stderr).toBe(0);
  lane = join(pool, 'salvage-test', 'lane-1');
  expect(git(['rev-parse', 'HEAD'], lane)).toBe(initial);
  writeFileSync(join(root, 'git-log'), '');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('lane-pool salvage-unpushed', () => {
  const assertKept = sha => {
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(sha);
    expect(refs()).toBe('');
    expect(events().some(e => e.args.includes('push') || e.args.includes('reset')
      || (e.args.includes('checkout') && e.args.includes('-B'))
      || (e.args.includes('stash') && e.args.includes('clear')))).toBe(false);
  };

  it.each(['absent', 'expired'].flatMap(lease =>
    ['agent', 'cwd', 'recent', 'unknown agents', 'unknown cwds'].map(signal => [lease, signal])))
  ('refuses %s lease salvage with %s liveness evidence and asks for manual inspection', (lease, signal) => {
    const sha = commit(lane, 'still in use');
    if (lease === 'expired') writeFileSync(join(lane, '.git', '.lane-lease'), JSON.stringify({
      session: 'old', acquiredAt: '2000-01-01T00:00:00.000Z',
    }));
    const extra = signal === 'agent' ? { TEST_AGENTS: JSON.stringify([{ cwd: lane, state: 'running' }]) }
      : signal === 'cwd' ? { TEST_CWDS: `p${process.pid}\nn${lane}\n` }
      : signal === 'recent' ? { WE_LANE_SALVAGE_QUIET_MIN: '30' }
      : signal === 'unknown agents' ? { TEST_AGENTS: 'unknown' } : { TEST_CWDS: 'unknown' };
    const result = run('salvage-unpushed', [], extra);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/liveness.*inspect manually/);
    assertKept(sha);
  });

  it('refuses an expired lease whose owner session is still live outside the lane', () => {
    const sha = commit(lane, 'live expired owner');
    writeFileSync(join(lane, '.git', '.lane-lease'), JSON.stringify({
      session: 'old', acquiredAt: '2000-01-01T00:00:00.000Z',
    }));
    const result = run('salvage-unpushed', [], { TEST_AGENTS: JSON.stringify([{ sessionId: 'old', cwd: primary }]) });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/liveness.*inspect manually/);
    expect(JSON.parse(readFileSync(join(lane, '.git', '.lane-lease'), 'utf8')).session).toBe('old');
    assertKept(sha);
  });

  it('rechecks liveness after pushing and refuses reset if a process has entered the lane', () => {
    const sha = commit(lane, 'late live process');
    const result = run('salvage-unpushed', [], { TEST_LIVE_AFTER_PUSH: lane });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/liveness.*inspect manually/);
    expect(refs()).toContain(sha);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(sha);
    expect(events().some(e => e.args.includes('checkout') && e.args.includes('-B'))).toBe(false);
  });

  it.each([
    { TEST_WATCH_ONCE: '1', LANE_POOL_AUTO_RECOVER: '0', LANE_POOL_NO_RECOVER: '0' },
    { TEST_WATCH_ONCE: '1', LANE_POOL_AUTO_RECOVER: '1', LANE_POOL_NO_RECOVER: '1' },
    { LANE_POOL_AUTO_RECOVER: '0', LANE_POOL_NO_RECOVER: '0' },
    { LANE_POOL_AUTO_RECOVER: '1', LANE_POOL_NO_RECOVER: '1' },
  ])('gc honours the recovery opt-out %j', extra => {
    const sha = commit(lane, 'opt out');
    const result = run('gc', extra.TEST_WATCH_ONCE ? ['--watch'] : [], extra);
    expect(result.status, result.stderr).toBe(0);
    if (!extra.TEST_WATCH_ONCE) expect(result.stderr).toContain('gc: pass completed');
    assertKept(sha);
  });

  it.each(['lock', 'schedule', 'load', 'unknown load', 'unknown cursor', 'watch load'])
  ('gc performs no salvage when admission refuses %s', refusal => {
    const sha = commit(lane, 'admission refused');
    const state = join(root, '.cache', 'we-host-overload');
    mkdirSync(state, { recursive: true });
    if (refusal === 'lock') writeFileSync(join(state, 'gc.lock'), `${process.pid}\n`);
    if (refusal === 'schedule') {
      const cursor = Object.fromEntries([1, 2].map(n => [createHash('sha256')
        .update(join(pool, 'salvage-test', `lane-${n}`)).digest('hex'), Date.now()]));
      writeFileSync(join(state, 'gc-cursor.json'), JSON.stringify(cursor));
    }
    if (refusal === 'unknown cursor') writeFileSync(join(state, 'gc-cursor.json'), '{');
    const result = run('gc', refusal === 'watch load' ? ['--watch'] : [], { LANE_POOL_AUTO_RECOVER: '1', LANE_POOL_NO_RECOVER: '0',
      ...(refusal === 'watch load' ? { TEST_WATCH_ONCE: '1', WE_TEST_HOST_LOAD1: '999999' } : {}),
      ...(refusal === 'load' ? { WE_TEST_HOST_LOAD1: '999999' }
        : refusal === 'unknown load' ? { WE_TEST_HOST_LOAD1: 'unknown' } : {}),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('gc: pass completed');
    assertKept(sha);
  });

  it('gc leaves a lane whose schedule is not due intact when another lane admits', () => {
    const sha = commit(lane, 'not due');
    const state = join(root, '.cache', 'we-host-overload');
    mkdirSync(state, { recursive: true });
    const key = createHash('sha256').update(lane).digest('hex');
    writeFileSync(join(state, 'gc-cursor.json'), JSON.stringify({ [key]: Date.now() }));
    const result = run('gc', [], { LANE_POOL_AUTO_RECOVER: '1', LANE_POOL_NO_RECOVER: '0' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('gc: pass completed');
    // Only the not-due lane must be untouched; the admitting lane-2 is recycled normally.
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(sha);
    expect(refs()).toBe('');
    expect(events().some(e => e.cwd === lane && (e.args.includes('push') || e.args.includes('reset')
      || (e.args.includes('checkout') && e.args.includes('-B'))
      || (e.args.includes('stash') && e.args.includes('clear'))))).toBe(false);
  });

  it('gc salvages only after an admitted pass with recovery enabled', () => {
    const sha = commit(lane, 'admitted salvage');
    const result = run('gc', [], { LANE_POOL_AUTO_RECOVER: '1', LANE_POOL_NO_RECOVER: '0' });
    expect(result.status, result.stderr).toBe(0);
    expect(refs()).toContain(sha);
    const log = events();
    expect(log.findIndex(e => e.args.includes('gc'))).toBeLessThan(log.findIndex(e => e.args.includes('push')));
  });

  it.each(['unpushed', 'unreadable'])('explicit acquire refuses %s preservation evidence with unpublished main off HEAD', evidence => {
    const sha = commit(lane, 'unpublished main');
    git(['checkout', '-b', 'clean-head', 'origin/main'], lane);
    const head = git(['rev-parse', 'HEAD'], lane);
    const result = run('acquire', ['--lane=1', '--no-reap'], evidence === 'unreadable' ? { TEST_BAD_HEADS: '1' } : {});
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unpushed work or unreadable preservation evidence.*salvage-unpushed or inspect it manually/);
    expect(git(['rev-parse', 'main'], lane)).toBe(sha);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(head);
    expect(git(['symbolic-ref', '--short', 'HEAD'], lane)).toBe('clean-head');
    expect(existsSync(join(lane, '.git', '.lane-lease'))).toBe(false);
    expect(events().some(e => e.args.includes('checkout') && e.args.includes('-B'))).toBe(false);
  });

  it.each(['fetch', 'checkout', 'clean'].flatMap(phase => ['replaced', 'expired', 'unreadable', 'missing'].map(change => [phase, change])))
  ('salvage aborts destructive work after %s when its lease is %s', (phase, change) => {
    const sha = commit(lane, 'abandoned work');
    const record = join(root, 'changed-lease');
    const result = run('salvage-unpushed', [], {
      TEST_LEASE_LANE: lane, TEST_LEASE_PHASE: phase, TEST_LEASE_CHANGE: change, TEST_LEASE_RECORD: record,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/lease changed or expired during salvage/);
    const marker = join(lane, '.git', '.lane-lease');
    expect(existsSync(marker) ? readFileSync(marker, 'utf8') : 'missing').toBe(readFileSync(record, 'utf8'));
    expect(git(['stash', 'list'], lane)).toContain('new occupant');
    const log = events().filter(e => e.cwd === lane);
    expect(log.some(e => e.args.includes('stash') && e.args.includes('clear'))).toBe(false);
    expect(log.some(e => e.args.includes('clean'))).toBe(phase === 'clean');
    if (phase === 'fetch') {
      expect(git(['rev-parse', 'HEAD'], lane)).toBe(sha);
      expect(log.some(e => e.args.includes('checkout') && e.args.includes('-B'))).toBe(false);
    }
  });

  it.each(['branch', 'stash', 'detached'])('acquire skips free lanes holding unpushed %s work', kind => {
    if (kind === 'stash') {
      writeFileSync(join(lane, 'work.txt'), 'stashed'); git(['stash', 'push'], lane);
    } else {
      if (kind === 'branch') git(['checkout', '-b', 'leftover'], lane);
      else git(['checkout', '--detach'], lane);
      commit(lane, 'unpublished');
      if (kind === 'branch') git(['checkout', 'main'], lane);
    }
    const result = run('acquire', ['--no-reap', '--no-free-list', '--no-cache', '--json']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).lane).toBe(2);
  });

  it('gc skips a lane with no local-only commits without any origin listing, fetch or lease claim (R903 tick bound)', () => {
    const result = run('gc', [], { LANE_POOL_AUTO_RECOVER: '1', LANE_POOL_NO_RECOVER: '0' });
    expect(result.status, result.stderr).toBe(0);
    const log = events().filter(e => e.args.includes('ls-remote')
      || e.args.some(arg => String(arg).includes(':refs/release-verify/')));
    expect(log).toEqual([]);
    expect(refs()).toBe('');
  });

  it('acquire never lists or verification-fetches the canonical origin (R903 tick bound)', () => {
    const result = run('acquire', ['--no-reap', '--no-free-list', '--no-cache', '--json']);
    expect(result.status, result.stderr).toBe(0);
    const log = events();
    expect(log.some(e => e.args.includes('ls-remote'))).toBe(false);
    expect(log.some(e => e.args.some(arg => String(arg).includes(':refs/release-verify/')))).toBe(false);
  });

  it('acquires an unfetched free lane after canonical origin/main advances without object-only verification', () => {
    const publisher = join(root, 'publisher');
    git(['clone', origin, publisher]);
    const advanced = commit(publisher, 'advanced main');
    git(['fetch', publisher, 'main:main'], origin);
    // The publisher is independent of the primary whose objects the lane borrows.
    expect(() => git(['cat-file', '-e', advanced], lane)).toThrow();
    const result = run('acquire', ['--no-reap', '--no-free-list', '--no-cache', '--json']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).lane).toBe(1);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(advanced);
    const log = events();
    // The ordinary fetch fills the objects and refreshes the tracking refs the pre-reset check reads: no `ls-remote`.
    expect(log.some(e => e.args.includes('ls-remote') || e.args.some(arg => String(arg).includes(':refs/release-verify/')))).toBe(false);
    expect(log.some(e => e.cwd === lane && e.args.includes('checkout') && e.args.includes('-B'))).toBe(true);
    expect(git(['for-each-ref', '--format=%(refname)', 'refs/release-verify/'], lane)).toBe('');
  });

  it('create-only salvage preserves a competing ref created between inspection and push', () => {
    const ancestor = git(['rev-parse', 'HEAD'], lane);
    const sha = commit(lane, 'descendant eligible for fast-forward');
    const record = join(root, 'competing-ref');
    const result = run('salvage-unpushed', [], {
      TEST_COLLISION_ORIGIN: origin, TEST_COLLISION_SHA: ancestor, TEST_COLLISION_RECORD: record,
    });
    // Without a create-only condition, the ordinary push replaces this ancestor by fast-forward.
    expect(existsSync(record)).toBe(true);
    const ref = readFileSync(record, 'utf8');
    expect(git(['rev-parse', ref], origin)).toBe(ancestor);
    expect(result.status).not.toBe(0); expect(result.stderr).toMatch(/FAILED/);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(sha);
    const log = events();
    const push = log.findIndex(e => e.args.includes('push'));
    const inspection = log.findIndex(e => e.args.includes('ls-remote') && e.args.includes(ref));
    expect(inspection).toBeGreaterThanOrEqual(0); expect(push).toBeGreaterThan(inspection);
    expect(log.some(e => e.args.includes('checkout') && e.args.includes('-B'))).toBe(false);
  });

  it('pushes every branch and detached HEAD, verifies remote SHAs before normal reset', () => {
    const first = commit(lane, 'first');
    git(['branch', 'leftover', first], lane);
    git(['checkout', '--detach', 'origin/main'], lane);
    const second = commit(lane, 'detached');
    const result = run('salvage-unpushed');
    expect(result.status, result.stderr).toBe(0);
    expect(refs()).toContain(first); expect(refs()).toContain(second);
    expect(refs()).toMatch(/lane\/salvage-lane-1-\d{8}T\d{6}Z-parked/);
    const log = events();
    const reset = log.findIndex(e => e.cwd === lane && e.args.includes('checkout') && e.args.includes('-B'));
    const pushes = log.map((e, i) => e.args.includes('push') ? i : -1).filter(i => i >= 0);
    expect(pushes.length).toBeGreaterThan(0);
    for (const at of pushes) {
      const ref = log[at].args.at(-1).split(':')[1];
      const verified = log.findIndex((e, i) => i > at && e.args.includes('ls-remote') && e.args.includes(ref));
      expect(verified).toBeGreaterThan(at); expect(reset).toBeGreaterThan(verified);
    }
    expect(git(['symbolic-ref', '--short', 'HEAD'], lane)).toBe('main');
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(git(['rev-parse', 'main'], origin));
    expect(git(['status', '--porcelain'], lane)).toBe('');
  });

  it.each([false, true])('never touches a live lease (reserved=%s)', reserved => {
    const acquired = run('acquire', ['--lane=1', '--session=live', ...(reserved ? ['--reserve'] : [])]);
    expect(acquired.status, acquired.stderr).toBe(0);
    const sha = commit(lane, 'live work'); writeFileSync(join(root, 'git-log'), '');
    const result = run('salvage-unpushed');
    expect(result.status, result.stderr).toBe(0);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(sha);
    expect(events().filter(e => e.cwd === lane)).toEqual([]);
    expect(refs()).toBe('');
  });

  it.each(['TEST_FAIL_PUSH', 'TEST_BAD_VERIFY'])('%s leaves work intact and exits nonzero', failure => {
    const sha = commit(lane, 'keep me');
    const result = run('salvage-unpushed', [], { [failure]: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/FAILED/);
    if (failure === 'TEST_BAD_VERIFY') expect(events().some(e => e.args.includes('push'))).toBe(true);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(sha);
    expect(events().some(e => e.args.includes('checkout') && e.args.includes('-B'))).toBe(false);
  });

  it('refuses unpushed commits with unstaged tracked edits without push, reset or stash-clear', () => {
    const sha = commit(lane, 'unpushed work');
    const file = join(lane, 'work.txt');
    const edited = 'unpushed work\nunstaged tracked edit\n';
    writeFileSync(file, edited);
    expect(git(['diff', '--name-only'], lane)).toBe('work.txt');
    const result = run('salvage-unpushed');
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/tracked changes.*commit\/stash work and retry/);
    expect(readFileSync(file, 'utf8')).toBe(edited);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(sha);
    expect(refs()).toBe('');
    const log = events();
    expect(log.some(e => e.args.includes('push'))).toBe(false);
    expect(log.some(e => e.args.includes('reset') || e.args.includes('checkout'))).toBe(false);
    expect(log.some(e => e.args.includes('stash') && e.args.includes('clear'))).toBe(false);
  });

  it('unreadable canonical-origin evidence fails closed without push or reset', () => {
    const sha = commit(lane, 'unknown evidence');
    const result = run('salvage-unpushed', [], { TEST_BAD_HEADS: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/incomplete preservation evidence/);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(sha);
    expect(events().some(e => e.args.includes('push') || e.args.includes('checkout'))).toBe(false);
  });

  it('salvages a dead lease then supports the acquire/release smoke', () => {
    const acquired = run('acquire', ['--lane=1', '--session=old']);
    expect(acquired.status, acquired.stderr).toBe(0);
    const marker = join(lane, '.git', '.lane-lease');
    const lease = JSON.parse(readFileSync(marker, 'utf8'));
    writeFileSync(marker, JSON.stringify({ ...lease, acquiredAt: '2000-01-01T00:00:00.000Z' }));
    const sha = commit(lane, 'abandoned');
    const salvaged = run('salvage-unpushed');
    expect(salvaged.status, salvaged.stderr).toBe(0); expect(refs()).toContain(sha);
    const result = run('acquire', ['--no-reap', '--no-cache', '--no-free-list', '--session=smoke', '--json']);
    expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).lane).toBe(1);
    const released = run('release', ['--lane=1', '--session=smoke']);
    expect(released.status, released.stderr).toBe(0);
  });

  it('dry-run changes no refs, stash, lease or working copy and never pushes or fetches', () => {
    const sha = commit(lane, 'dry');
    writeFileSync(join(lane, 'work.txt'), 'stash'); git(['stash', 'push'], lane);
    const before = git(['show-ref'], lane); const stash = git(['stash', 'list'], lane);
    const result = run('salvage-unpushed', ['--dry-run']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/would/i);
    expect(existsSync(join(lane, '.git', '.lane-lease'))).toBe(false);
    expect(git(['show-ref'], lane)).toBe(before); expect(git(['stash', 'list'], lane)).toBe(stash);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(sha); expect(refs()).toBe('');
    expect(events().some(e => e.args.includes('push') || e.args.includes('fetch') || e.args.includes('checkout'))).toBe(false);
  });

  it('salvages every stash entry including older reflog tips before clearing the stash', () => {
    const shas = [];
    for (const text of ['old stash', 'new stash']) {
      writeFileSync(join(lane, 'work.txt'), text); git(['stash', 'push'], lane);
      shas.push(git(['rev-parse', 'refs/stash'], lane));
    }
    const result = run('salvage-unpushed');
    expect(result.status, result.stderr).toBe(0);
    for (const sha of shas) expect(refs()).toContain(sha);
    expect(refs()).toContain('-parked-stash0');
    expect(git(['stash', 'list'], lane)).toBe('');
  });
});
