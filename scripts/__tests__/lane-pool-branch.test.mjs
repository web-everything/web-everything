import { beforeEach, afterEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const script = resolve('scripts/lane-pool.mjs');
let root, primary, lane, origin, pool, marker, first, tip;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
function setupFixture(objectFormat = 'sha1') {
  root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'lane-branch-'));
  primary = join(root, 'primary');
  mkdirSync(primary);
  git(primary, 'init', '--quiet', '--initial-branch=main', `--object-format=${objectFormat}`);
  writeFileSync(join(primary, 'file.txt'), 'first\n');
  git(primary, 'add', '.');
  git(primary, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'first');
  first = git(primary, 'rev-parse', 'HEAD');
  writeFileSync(join(primary, 'file.txt'), 'tip\n');
  git(primary, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-am', 'tip', '--quiet');
  tip = git(primary, 'rev-parse', 'HEAD');
  origin = join(root, 'origin.git');
  git(root, 'clone', '--quiet', '--bare', primary, origin);
  pool = join(root, '.lanes');
  mkdirSync(join(pool, 'fixture'), { recursive: true });
  lane = join(pool, 'fixture', 'lane-1');
  git(root, 'clone', '--quiet', '--reference', primary, origin, lane);
  marker = join(lane, '.git', '.lane-lease');
  writeFileSync(marker, JSON.stringify({ session: 'dispatcher', holder: 'holder', acquiredAt: new Date().toISOString(), ttlMinutes: 120 }));
}
beforeEach(() => setupFixture());
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(overrides = {}, poolName = 'fixture', env = {}, command = 'branch', options = {}) {
  const args = { lane: '1', session: 'holder', name: 'lane/test', ...overrides };
  return spawnSync(process.execPath, [options.script || script, command, ...(poolName === undefined ? [] : [`--pool=${poolName}`]), ...(options.fromCwd ? [] : [`--reference=${primary}`, `--origin=${origin}`]),
    ...Object.entries(args).filter(([, v]) => v !== undefined).map(([k, v]) => v === true ? `--${k}` : `--${k}=${v}`)],
  { cwd: options.cwd, encoding: 'utf8', maxBuffer: 1024 * 1024, env: { ...process.env, LANE_POOL_ROOT: pool, WE_LANE_HOLD: 'enforce', ...env } });
}
function refused(overrides, reason, env) {
  const before = git(primary, 'show-ref');
  const laneBefore = git(lane, 'show-ref');
  const head = git(lane, 'rev-parse', 'HEAD');
  const branch = git(lane, 'branch', '--show-current');
  const result = run(overrides, 'fixture', env);
  expect(result.status).not.toBe(0);
  expect(result.stderr).not.toMatch(/unknown command/);
  expect(result.stderr).toMatch(reason);
  expect(git(primary, 'show-ref')).toBe(before);
  expect(git(lane, 'show-ref')).toBe(laneBefore);
  expect(git(lane, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(lane, 'branch', '--show-current')).toBe(branch);
}

it.each([undefined, 'sha', 'origin/main'])('lane-pool branch creates a lane branch from %s', from => {
  const lease = readFileSync(marker, 'utf8');
  const result = run({ from: from === 'sha' ? first : from });
  expect(result.status, result.stderr).toBe(0);
  expect(git(lane, 'branch', '--show-current')).toBe('lane/test');
  expect(git(lane, 'rev-parse', 'HEAD')).toBe(from === 'sha' ? first : tip);
  expect(git(primary, 'branch', '--show-current')).toBe('main');
  expect(git(primary, 'branch', '--list', 'lane/test')).toBe('');
  expect(readFileSync(marker, 'utf8')).toBe(lease);
});
it.each([undefined, 'sha', 'origin/main'])('creates a SHA-256 lane branch from %s', from => {
  rmSync(root, { recursive: true, force: true });
  setupFixture('sha256');
  expect(tip).toMatch(/^[a-f0-9]{64}$/);
  const lease = readFileSync(marker, 'utf8');
  const target = from === 'sha' ? first : tip;
  const options = { from: from === 'sha' ? first : from };
  const refs = git(lane, 'show-ref');
  const dryRun = run({ ...options, 'dry-run': true });
  expect(dryRun.status, dryRun.stderr).toBe(0);
  expect(dryRun.stdout).toContain(`would create lane/test at ${target}`);
  expect(git(lane, 'show-ref')).toBe(refs);
  expect(git(lane, 'branch', '--show-current')).toBe('main');
  const result = run(options);
  expect(result.status, result.stderr).toBe(0);
  expect(git(lane, 'branch', '--show-current')).toBe('lane/test');
  expect(git(lane, 'rev-parse', 'HEAD')).toBe(target);
  expect(git(primary, 'branch', '--show-current')).toBe('main');
  expect(git(primary, 'branch', '--list', 'lane/test')).toBe('');
  expect(readFileSync(marker, 'utf8')).toBe(lease);
});
it.each(['primary', 'self', 'other'].flatMap(cwd => ['original', 'lane-copy'].map(script => ({ cwd, script }))))(
  'creates a branch from $cwd cwd using the $script script and derived pool root', ({ cwd, script: scriptKind }) => {
    const other = join(pool, 'fixture', 'lane-2');
    git(root, 'clone', '--quiet', '--reference', primary, origin, other);
    let entry = script;
    if (scriptKind === 'lane-copy') {
      // Copy the entry point so import.meta.url belongs to a lane, sharing only its dependencies.
      const scriptsDir = join(other, 'scripts');
      mkdirSync(scriptsDir);
      for (const name of readdirSync(dirname(script))) {
        if (name !== 'lane-pool.mjs') symlinkSync(join(dirname(script), name), join(scriptsDir, name));
      }
      entry = join(scriptsDir, 'lane-pool.mjs');
      copyFileSync(script, entry);
    }
    const lease = readFileSync(marker, 'utf8');
    const result = run({}, 'fixture', {
      LANE_POOL_ROOT: '', WE_ALLOW_REAL_LANE_POOL_IN_TESTS: '1',
    }, 'branch', { cwd: cwd === 'primary' ? primary : cwd === 'self' ? lane : other, script: entry, fromCwd: true });
    expect(result.status, result.stderr).toBe(0);
    expect(git(lane, 'branch', '--show-current')).toBe('lane/test');
    expect(git(lane, 'rev-parse', 'HEAD')).toBe(tip);
    expect(git(primary, 'branch', '--list', 'lane/test')).toBe('');
    expect(git(other, 'branch', '--list', 'lane/test')).toBe('');
    expect(readFileSync(marker, 'utf8')).toBe(lease);
  },
);
it('refuses an unleased lane', () => { rmSync(marker); refused({}, /unleased/); });
it('refuses the wrong holder, including the dispatcher session', () => { refused({ session: 'dispatcher' }, /holder/); });
it.each([undefined, '', true])('refuses missing or unreadable session %s', session => { refused({ session }, /session/); });
it.each(['{', '{}', 'null', '[]', '{"holder":12}'])('refuses unreadable or unknown lease %s', body => {
  writeFileSync(marker, body); refused({}, /lease|holder/);
});
it('refuses a lease that cannot be read as a file', () => { rmSync(marker); mkdirSync(marker); refused({}, /lease/); });
it.each([undefined, 'main', 'lane/../x', 'lane/a..b', '-x', 'lane/-x', 'lane/x\n', true])('refuses invalid branch name %s', name => {
  refused({ name }, /name/);
});
it('refuses an existing branch', () => { git(lane, 'branch', 'lane/test'); refused({}, /already exists/); });
it.each(['tracked', 'untracked', 'staged'])('refuses a dirty worktree (%s)', kind => {
  writeFileSync(join(lane, kind === 'untracked' ? 'new.txt' : 'file.txt'), 'dirty\n');
  if (kind === 'staged') git(lane, 'add', '.');
  refused({}, /dirty/);
});
it.each(['origin/missing', 'f'.repeat(40), '--help', '', true, 'HEAD:file.txt'])('refuses a from value that does not resolve to a commit: %s', from => {
  refused({ from }, /from|commit/);
});
it('refuses an unknown lane', () => { refused({ lane: '2' }, /lane.*(unknown|exist|unreadable)/); });
it('refuses an unreadable lane repository', () => {
  rmSync(join(lane, '.git', 'HEAD')); 
  const result = run();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/lane|repository/);
  expect(git(primary, 'branch', '--list', 'lane/test')).toBe('');
});
it('refuses a pool lane symlink pointing at the primary checkout', () => {
  rmSync(lane, { recursive: true }); symlinkSync(primary, lane, 'dir');
  refused({}, /clone|shared|symlink/);
});
it('refuses a shared git directory', () => {
  rmSync(join(lane, '.git'), { recursive: true }); symlinkSync(join(primary, '.git'), join(lane, '.git'), 'dir');
  refused({}, /clone|shared|symlink/);
});
it('refuses a pool path outside the pool root', () => {
  const before = git(lane, 'show-ref');
  const result = run({}, '../outside');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/shared|clone/);
  expect(git(lane, 'show-ref')).toBe(before);
});

it.each([
  { acquiredAt: '2000-01-01T00:00:00Z' },
  { acquiredAt: new Date().toISOString(), ttlMinutes: 0 },
  { acquiredAt: undefined },
  { acquiredAt: 'not-a-date' },
  { acquiredAt: undefined, reserved: true },
])('refuses stale, expired or undatable leases: %j', patch => {
  writeFileSync(marker, JSON.stringify({ ...JSON.parse(readFileSync(marker)), ...patch }));
  refused({}, /lease stale or undatable/);
});
it('uses --ttl-minutes for leases without their own TTL', () => {
  writeFileSync(marker, JSON.stringify({ holder: 'holder', acquiredAt: new Date(Date.now() - 120_000).toISOString() }));
  refused({ 'ttl-minutes': 1 }, /lease stale/);
});
it('honours a renewed lease', () => {
  writeFileSync(marker, JSON.stringify({ holder: 'holder', acquiredAt: '2000-01-01T00:00:00Z', renewedAt: new Date().toISOString() }));
  const result = run();
  expect(result.status, result.stderr).toBe(0);
});
it.each(['running', 'corrupt'])('refuses a verification hold (%s)', status => {
  // An unreadable verify record holds only when unpushed work is at risk.
  if (status === 'corrupt') git(lane, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'unpushed work');
  writeFileSync(join(lane, '.git', '.lane-verify'), status === 'corrupt' ? '{' : JSON.stringify({ sha: tip, status, startedAt: new Date().toISOString() }));
  refused({}, /lane-hold/);
});
it.each(['assume-unchanged', 'skip-worktree'])('refuses tracked changes hidden by %s', flag => {
  git(lane, 'update-index', `--${flag}`, 'file.txt');
  writeFileSync(join(lane, 'file.txt'), 'hidden edit\n');
  refused({}, /dirty/);
});
it('refuses tracked changes masked by repository config', () => {
  git(lane, 'config', 'core.ignoreStat', 'true');
  refused({}, /dirty/);
});
it('dry-run validates and reports the branch without changing refs, HEAD, index, tree or lease', () => {
  const paths = [join(lane, '.git', 'HEAD'), join(lane, '.git', 'index'), join(lane, 'file.txt'), marker];
  const before = paths.map(path => readFileSync(path));
  const refs = git(lane, 'show-ref');
  const result = run({ 'dry-run': true, from: first });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(`would create lane/test at ${first}`);
  expect(git(lane, 'show-ref')).toBe(refs);
  paths.forEach((path, i) => expect(readFileSync(path)).toEqual(before[i]));
});
it('dry-run still refuses dirty work and invalid from commits', () => {
  refused({ 'dry-run': true, from: 'origin/missing' }, /commit/);
  writeFileSync(join(lane, 'new.txt'), 'untracked\n');
  refused({ 'dry-run': true }, /dirty/);
});
it('rejects --from on acquire as an unknown flag before any mutation', () => {
  const lease = readFileSync(marker, 'utf8');
  const result = run({ from: first }, 'fixture', {}, 'acquire');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/unrecognized flag\(s\): --from/);
  expect(readFileSync(marker, 'utf8')).toBe(lease);
  expect(git(lane, 'branch', '--show-current')).toBe('main');
});
it.each(['changed', 'removed', 'corrupt', 'expired'])('rechecks ownership before switching when lease is %s', state => {
  const preload = join(root, 'change-lease.mjs');
  writeFileSync(preload, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function(path, ...args) {
      if (String(path) === process.env.TEST_LEASE && ++reads === 2) {
        const state = process.env.TEST_LEASE_STATE;
        if (state === 'removed') fs.rmSync(path);
        else if (state === 'corrupt') fs.writeFileSync(path, '{');
        else {
          const lease = JSON.parse(original(path, 'utf8'));
          if (state === 'changed') lease.holder = 'someone-else';
          else { lease.acquiredAt = '2000-01-01T00:00:00Z'; delete lease.renewedAt; }
          fs.writeFileSync(path, JSON.stringify(lease));
        }
      }
      return original.call(this, path, ...args);
    };
    syncBuiltinESMExports();
  `);
  refused({}, /lease.*(holder changed|unreadable)/, {
    NODE_OPTIONS: `--import=${preload}`, TEST_LEASE: marker, TEST_LEASE_STATE: state,
  });
});
it('scrubs inherited Git location and config for branch probes and switch', () => {
  const result = run({ from: first }, 'fixture', {
    GIT_DIR: join(primary, '.git'), GIT_WORK_TREE: primary,
    GIT_CONFIG_PARAMETERS: "'core.bare'='true'",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(git(lane, 'branch', '--show-current')).toBe('lane/test');
  expect(git(lane, 'rev-parse', 'HEAD')).toBe(first);
  expect(git(primary, 'branch', '--show-current')).toBe('main');
  expect(git(primary, 'branch', '--list', 'lane/test')).toBe('');
});
