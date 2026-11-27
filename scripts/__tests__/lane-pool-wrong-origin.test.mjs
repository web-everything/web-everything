/** Pool binding and probe diagnostics, exercised through the real CLI with private Git repositories. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../lane-pool.mjs');
const REAL_GIT = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
let root, ws, pool, alpha, beta, origins, env, calls, trace;
const git = (args, cwd = root) => execFileSync(REAL_GIT, args, { cwd, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 }).trim();

function tree(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path).sort().flatMap(name => {
    const p = join(path, name), s = lstatSync(p);
    return s.isDirectory() ? tree(p).map(row => [name + '/' + row[0], ...row.slice(1)])
      : [[name, s.size, createHash('sha256').update(readFileSync(p)).digest('hex')]];
  });
}

function run(args, extraEnv = {}, cwd = beta) {
  writeFileSync(calls, ''); writeFileSync(trace, '');
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--branch=main', '--no-install'], {
    cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 25_000, maxBuffer: 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout, err: r.stderr, calls: readFileSync(calls, 'utf8'), trace: readFileSync(trace, 'utf8') };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lane-pool-origin-'));
  ws = join(root, 'ws'); pool = join(root, 'lanes');
  alpha = join(ws, 'alpha'); beta = join(ws, 'beta');
  origins = { alpha: join(root, 'origins', 'alpha.git'), beta: join(root, 'origins', 'beta.git') };
  mkdirSync(ws); mkdirSync(join(root, 'origins')); mkdirSync(join(root, 'home')); mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'tmp'));
  calls = join(root, 'calls'); trace = join(root, 'git-trace');
  const preload = join(root, 'clock.cjs');
  writeFileSync(preload, `const RealDate = Date; global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [1795780800000])); } static now() { return 1795780800000; } };
    const os = require('node:os'); os.hostname = () => 'fixture-host'; os.homedir = () => process.env.HOME;
    os.userInfo = () => ({ homedir: process.env.HOME, username: 'fixture', uid: 123, gid: 123, shell: '/bin/sh' });
    require('node:module').syncBuiltinESMExports();`);
  env = {
    PATH: process.env.PATH, DEVELOPER_DIR: process.env.DEVELOPER_DIR, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
    GIT_AUTHOR_DATE: '2026-11-27T12:00:00Z', GIT_COMMITTER_DATE: '2026-11-27T12:00:00Z',
    LANE_POOL_ROOT: pool, LANE_POOL_TRACE_ORIGIN: '1', WE_UNDER_TEST: '1', WE_TELEMETRY: '0',
    WE_COORDINATION_ROOT: join(root, 'coordination'), NODE_OPTIONS: `--require=${preload}`,
    FIXTURE_ROOT: root, FIXTURE_GIT: REAL_GIT, FIXTURE_CALLS: calls,
  };
  for (const name of ['alpha', 'beta']) {
    git(['init', '--quiet', '--bare', '--initial-branch=main', origins[name]]);
    const primary = join(ws, name);
    git(['clone', '--quiet', origins[name], primary]);
    writeFileSync(join(primary, 'file.txt'), name + '\n');
    git(['add', '.'], primary); git(['commit', '--quiet', '-m', name], primary); git(['push', '--quiet', 'origin', 'main'], primary);
  }
  const shim = join(root, 'bin', 'git');
  writeFileSync(shim, `#!/bin/sh
case "$PWD/" in "$FIXTURE_ROOT/"*) ;; *) echo 'fixture refuses external cwd' >&2; exit 91;; esac
printf '%s\\n' "$PWD $*" >> "$FIXTURE_CALLS"
check_git() {
while [ "$1" = '-c' ]; do shift 2; done
case "$1" in
  rev-parse|remote)
    if [ "$PWD" = "$FIXTURE_BAD_DIR" ]; then printf '%s\\n' 'fixture unreadable owner' >&2; exit 1; fi;;
  rev-list)
    case " $* " in *' --count '*)
      case "$PWD" in */lane-*)
        if [ -n "$FIXTURE_COUNT" ]; then printf '%s\\n' "$FIXTURE_COUNT"; exit 0; fi
        if [ -n "$FIXTURE_ERROR" ]; then printf '%s\\n' "$FIXTURE_ERROR" >&2; exit 1; fi;;
      esac;;
    esac;;
esac
}
check_git "$@"
exec "$FIXTURE_GIT" "$@"
`);
  chmodSync(shim, 0o755);
  for (const name of ['gh', 'pgrep', 'ps', 'launchctl']) {
    const path = join(root, 'bin', name);
    writeFileSync(path, '#!/bin/sh\nprintf \'%s\\n\' "stub ' + name + ' $*" >> "$FIXTURE_CALLS"\nexit 1\n'); chmodSync(path, 0o755);
  }
  env.PATH = join(root, 'bin') + ':' + env.PATH;
  env.GIT_TRACE = trace;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function seedLane(n = 1, name = 'alpha') {
  const dir = join(pool, name, `lane-${n}`); mkdirSync(dirname(dir), { recursive: true });
  git(['clone', '--quiet', origins.alpha, dir]); return dir;
}
function bound(r, path = alpha, origin = origins.alpha) {
  expect(r.code, r.err).toBe(0);
  expect(r.err).toContain(`lane-pool: bound origin ${origin} (from primary:${path})`);
}
function refused(args, extraEnv = {}) {
  const beforePool = tree(pool), beforeAlpha = tree(origins.alpha), beforeBeta = tree(origins.beta);
  const r = run(args, extraEnv);
  expect(r.code, r.err).toBe(1);
  expect(r.err).toContain(`${args[0]} --pool=alpha: no primary checkout for pool alpha whose origin names alpha (looked in `);
  expect(r.err).toContain('pass --reference=<alpha checkout> or --origin=<url>');
  expect(r.calls).not.toMatch(/\b(clone|ls-remote|fetch|push)\b/);
  expect(r.trace).not.toMatch(/built-in: git (clone|ls-remote|fetch|push)\b/);
  expect(tree(pool)).toEqual(beforePool); expect(tree(origins.alpha)).toEqual(beforeAlpha); expect(tree(origins.beta)).toEqual(beforeBeta);
  return r;
}

describe('pool origin binding', () => {
  it('acquire --pool=alpha from beta grows a lane cloned from alpha, never beta', () => {
    const held = seedLane(); writeFileSync(join(held, 'file.txt'), 'uncommitted work\n');
    const before = tree(origins.beta);
    const r = run(['acquire', '--pool=alpha', '--session=fixture', '--wait-ms=0', '--no-reap', '--no-reset', '--json']);
    bound(r);
    const lane = JSON.parse(r.out).path;
    expect(git(['config', '--local', '--get-all', 'remote.origin.url'], lane)).toBe(origins.alpha);
    expect(tree(origins.beta)).toEqual(before);
  });

  it('provision binds alpha for both dry-run and real cloning', () => {
    const before = tree(origins.beta);
    const dry = run(['provision', '--pool=alpha', '--count=1', '--dry-run']); bound(dry);
    expect(dry.err).toContain(`clone source: ${origins.alpha}`); expect(existsSync(pool)).toBe(false);
    bound(run(['provision', '--pool=alpha', '--count=1']));
    expect(git(['config', '--local', '--get-all', 'remote.origin.url'], join(pool, 'alpha', 'lane-1'))).toBe(origins.alpha);
    expect(tree(origins.beta)).toEqual(before);
  });

  it('list --acquirable probes alpha only when a lane is ahead', () => {
    const lane = seedLane(); writeFileSync(join(lane, 'ahead'), 'ahead'); git(['add', '.'], lane); git(['commit', '--quiet', '-m', 'ahead'], lane);
    const before = tree(origins.beta);
    const r = run(['list', '--pool=alpha', '--acquirable', '--no-cache', '--no-reap', '--json']); bound(r);
    const probes = r.calls.split('\n').filter(line => line.includes('ls-remote'));
    expect(probes.length).toBeGreaterThan(0); expect(probes.every(line => line.includes(origins.alpha))).toBe(true);
    expect(r.trace).toContain(origins.alpha); expect(tree(origins.beta)).toEqual(before);
  });

  for (const variant of ['missing', 'wrong origin', 'lane-shaped', 'unreadable owner', 'malformed git']) {
    it.each(['acquire', 'provision', 'list'])('%s refuses without a qualifying primary: ' + variant, cmd => {
      seedLane();
      let extra = {};
      if (variant === 'missing') rmSync(alpha, { recursive: true });
      if (variant === 'wrong origin') git(['remote', 'set-url', 'origin', origins.beta], alpha);
      if (variant === 'lane-shaped') { const lane = join(ws, 'lane-9'); renameSync(alpha, lane); symlinkSync(lane, alpha); }
      if (variant === 'unreadable owner') extra = { FIXTURE_BAD_DIR: alpha };
      if (variant === 'malformed git') { rmSync(join(alpha, '.git'), { recursive: true }); writeFileSync(join(alpha, '.git'), 'gitdir: missing\n'); }
      const r = refused([cmd, '--pool=alpha', '--count=1', '--acquirable', '--wait-ms=0', '--no-reap'], extra);
      expect(r.err).toContain(alpha + ':');
    });
  }

  it.each(['refresh', 'remove', 'trim', 'reclaim', 'salvage-unpushed'])('%s refuses before any effect even with a valid primary', cmd => {
    seedLane(); refused([cmd, '--pool=alpha', '--lane=1']);
  });

  it('candidate qualification never exits: invalid first candidate falls back to constellation alias', () => {
    const first = join(ws, 'web-everything'), second = join(ws, 'webeverything');
    git(['clone', '--quiet', origins.beta, first]); git(['clone', '--quiet', origins.alpha, second]);
    const url = 'git@github.com:chalbert/web-everything.git'; git(['remote', 'set-url', 'origin', url], second);
    const r = run(['provision', '--pool=web-everything', '--count=1', '--dry-run']); bound(r, second, url);
  });

  it('all candidates invalid produces one aggregate refusal with each skip reason', () => {
    const first = join(ws, 'web-everything'), second = join(ws, 'webeverything');
    git(['clone', '--quiet', origins.beta, first]); mkdirSync(second);
    const r = run(['provision', '--pool=web-everything', '--count=1', '--dry-run']);
    expect(r.code).toBe(1); expect(r.err.match(/✗/g)).toHaveLength(1);
    expect(r.err).toContain(first + ': origin names beta'); expect(r.err).toContain(second + ':');
    expect(r.calls).not.toMatch(/\b(clone|ls-remote|fetch|push)\b/);
  });

  it('a primary worktree qualifies', () => {
    const worktree = join(ws, 'primary-worktree'); git(['worktree', 'add', '--quiet', '-b', 'fixture-worktree', worktree], alpha);
    renameSync(alpha, join(ws, 'owner')); git(['worktree', 'repair', worktree], join(ws, 'owner'));
    renameSync(worktree, alpha); git(['worktree', 'repair', alpha], join(ws, 'owner'));
    bound(run(['provision', '--pool=alpha', '--count=1', '--dry-run']));
  });

  it('an external worktree owned by a lane is skipped without exiting qualification', () => {
    const lane = seedLane(); rmSync(alpha, { recursive: true });
    git(['worktree', 'add', '--quiet', '-b', 'external', alpha], lane);
    expect(refused(['provision', '--pool=alpha', '--count=1', '--dry-run']).err).toMatch(/lane|pool root/);
  });

  it.each([
    'git@github.com:owner/ALPHA.git', 'ssh://git@github.com/owner/alpha.git',
    'https://github.com/owner/alpha.git', 'https://github.com/owner/Alpha/',
    '/local/alpha.git', '../alpha.git',
  ])('repo-name comparison treats %s as the selected pool', url => {
    git(['remote', 'set-url', 'origin', url], beta);
    const r = run(['provision', '--pool=alpha', '--count=1', '--dry-run']);
    expect(r.code, r.err).toBe(0); expect(r.err).toContain('(from caller)'); expect(r.err).not.toContain('primary:');
  });

  it.each([
    () => [`--origin=${origins.beta}`], () => [`--reference=${beta}`], () => [`--repo=${beta}`, '--name=custom'],
  ])('explicit authority stays unchanged (%#)', authority => {
    const r = run(['provision', '--pool=alpha', '--count=1', '--dry-run', ...authority()]);
    expect(r.code, r.err).toBe(0); expect(r.err).toContain(`clone source: ${origins.beta}`); expect(r.err).toContain('(from explicit)');
  });

  it('the daemon --repo with --name form stays authoritative', () => {
    const r = run(['provision', `--repo=${beta}`, '--name=custom', '--count=1', '--dry-run']);
    expect(r.code, r.err).toBe(0); expect(r.err).toContain(`clone source: ${origins.beta}`); expect(r.err).toContain('(from explicit)');
  });

  it.each(['missing', 'wrong origin', 'valid'])('gc/release retain the existing redirect: %s primary', variant => {
    if (variant === 'missing') rmSync(alpha, { recursive: true });
    if (variant === 'wrong origin') git(['remote', 'set-url', 'origin', origins.beta], alpha);
    const r = run(['release', '--pool=alpha', '--lane=1', '--session=fixture']);
    expect(r.code, r.err).toBe(0); expect(r.err).toContain('no lease to release'); expect(r.err).not.toContain('no primary checkout');
    const gc = run(['gc', '--pool=alpha', '--dry-run']);
    expect(gc.code, gc.err).toBe(0); expect(gc.err).not.toContain('no primary checkout');
  });
});

describe('eligibility probe diagnostics', () => {
  function acquire(extra = {}) { return run(['acquire', '--pool=alpha', '--session=fixture', '--wait-ms=0', '--no-reap'], extra); }
  it('names the failing git command and error in both the scan log and final refusal; growth stays blocked', () => {
    const lane = seedLane(); git(['update-ref', '-d', 'refs/remotes/origin/main'], lane);
    const r = acquire(); expect(r.code).toBe(1);
    const diagnostic = 'git rev-list --count origin/main..HEAD:';
    expect(r.err.split('\n').filter(line => line.includes(diagnostic))).toHaveLength(2);
    expect(r.err).toContain('failed: lane-1 ('); expect(r.calls).not.toMatch(/\b(clone|fetch|push)\b/);
    expect(existsSync(join(pool, 'alpha', 'lane-2'))).toBe(false);
  });
  it('malformed rev-list output uses the unparseable-output diagnostic', () => {
    seedLane(); const r = acquire({ FIXTURE_COUNT: 'not-a-count' });
    expect(r.code).toBe(1); expect(r.err).toContain('git rev-list --count origin/main..HEAD: unparseable output');
  });
  it('the final refusal lists at most three lanes in numeric order and counts the rest', () => {
    for (const n of [10, 2, 4, 1]) seedLane(n);
    const r = acquire({ FIXTURE_COUNT: 'bad' });
    const refusal = r.err.split('\n').find(line => line.startsWith('✗'));
    expect(refusal).toMatch(/failed: lane-1 \(.*lane-2 \(.*lane-4 \(.*\+1 more/); expect(refusal).not.toContain('lane-10');
  });
  it('errors are stripped of controls, limited to their first line and cut to 200 characters', () => {
    seedLane(); const r = acquire({ FIXTURE_ERROR: 'bad\u001b\u0007' + 'x'.repeat(250) + '\nSECOND-LINE' });
    expect(r.code).toBe(1);
    const line = r.err.split('\n').find(line => line.includes('lane-1: eligibility probe failed'));
    expect(line).toContain('git rev-list --count origin/main..HEAD: ' + 'bad  ' + 'x'.repeat(195) + ')');
    expect(r.err).not.toContain('SECOND-LINE'); expect(r.err).not.toMatch(/[\u001b\u0007]/);
  });
});
