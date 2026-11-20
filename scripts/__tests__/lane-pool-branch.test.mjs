import { beforeEach, afterEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const script = resolve('scripts/lane-pool.mjs');
let root, primary, lane, origin, pool, marker, first, tip;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
beforeEach(() => {
  root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'lane-branch-'));
  primary = join(root, 'primary');
  mkdirSync(primary);
  git(primary, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(primary, 'file.txt'), 'first\n');
  git(primary, 'add', '.');
  git(primary, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'first');
  first = git(primary, 'rev-parse', 'HEAD');
  writeFileSync(join(primary, 'file.txt'), 'tip\n');
  git(primary, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-am', 'tip', '--quiet');
  tip = git(primary, 'rev-parse', 'HEAD');
  origin = join(root, 'origin.git');
  git(root, 'clone', '--quiet', '--bare', primary, origin);
  pool = join(root, 'pool');
  mkdirSync(join(pool, 'fixture'), { recursive: true });
  lane = join(pool, 'fixture', 'lane-1');
  git(root, 'clone', '--quiet', origin, lane);
  marker = join(lane, '.git', '.lane-lease');
  writeFileSync(marker, JSON.stringify({ session: 'dispatcher', holder: 'holder', acquiredAt: new Date().toISOString(), ttlMinutes: 120 }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(overrides = {}, poolName = 'fixture') {
  const args = { lane: '1', session: 'holder', name: 'lane/test', ...overrides };
  return spawnSync(process.execPath, [script, 'branch', ...(poolName === undefined ? [] : [`--pool=${poolName}`]), `--reference=${primary}`, `--origin=${origin}`,
    ...Object.entries(args).filter(([, v]) => v !== undefined).map(([k, v]) => v === true ? `--${k}` : `--${k}=${v}`)],
  { encoding: 'utf8', maxBuffer: 1024 * 1024, env: { ...process.env, LANE_POOL_ROOT: pool } });
}
function refused(overrides, reason) {
  const before = git(primary, 'show-ref');
  const laneBefore = git(lane, 'show-ref');
  const head = git(lane, 'rev-parse', 'HEAD');
  const branch = git(lane, 'branch', '--show-current');
  const result = run(overrides);
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
it('refuses a lane pointing at the primary checkout', () => {
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
