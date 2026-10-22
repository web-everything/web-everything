/**
 * @file lane-git-diet-cleanup.test.mjs — proof for the one-time lane cleanup: eligibility rules (pure), the
 *   count-objects projection, and the CLI on real repos (dry-run changes nothing; apply claims the lane, skips
 *   leased/borrowed/symlinked lanes, keeps the working tree, frees the ledger blobs, is idempotent).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LANE_DEFAULT_FETCH, LANE_OPS_NEGATIVE_FETCH } from '../lane-git-diet.mjs';
import { cleanupEligibility, parseCountObjects, projectedFreedBytes } from '../lane-git-diet-cleanup.mjs';

const REPO = join(import.meta.dirname, '..', '..', '..');
const CLI = join(REPO, 'scripts', 'lane-git-diet.mjs');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.LANE_SESSION;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const refs = (cwd, prefix = 'refs/remotes/origin/') => git(cwd, 'for-each-ref', '--format=%(refname)', prefix).split('\n').filter(Boolean);

describe('cleanupEligibility (pure)', () => {
  const poolRoot = '/h/workspace/.lanes';
  const nowMs = Date.parse('2026-10-21T15:00:00Z');
  const fresh = { acquiredAt: '2026-10-21T14:50:00Z', purpose: 'x' };
  const stale = { acquiredAt: '2026-10-20T00:00:00Z' };
  it('allows an unleased pool lane', () => expect(cleanupEligibility({ dir: `${poolRoot}/web-everything/lane-5`, poolRoot, nowMs }).ok).toBe(true));
  it('refuses even a stale lease marker (the cleanup only claims an ABSENT marker, O_EXCL)', () => expect(cleanupEligibility({ dir: `${poolRoot}/web-everything/lane-5`, poolRoot, lease: stale, nowMs })).toMatchObject({ ok: false, reason: expect.stringMatching(/stale lease marker/) }));
  it('refuses a lane another repo borrows objects from', () => expect(cleanupEligibility({ dir: `${poolRoot}/web-everything/lane-13`, poolRoot, nowMs, borrowers: ['/x/lane-48'] })).toMatchObject({ ok: false, reason: expect.stringMatching(/borrowed by/) }));
  it('refuses a symlink alias or a .git that resolves elsewhere', () => {
    expect(cleanupEligibility({ dir: `${poolRoot}/web-everything/lane-5`, poolRoot, nowMs, realDir: '/h/workspace/webeverything' }).ok).toBe(false);
    expect(cleanupEligibility({ dir: `${poolRoot}/web-everything/lane-5`, poolRoot, nowMs, realDir: `${poolRoot}/web-everything/lane-5`, realGitDir: '/h/workspace/wev-review-daemon/.git' }).ok).toBe(false);
  });
  it('refuses a redirected common dir or object store', () => {
    const d = `${poolRoot}/web-everything/lane-5`;
    expect(cleanupEligibility({ dir: d, poolRoot, nowMs, realCommonDir: '/h/workspace/webeverything/.git' }).reason).toMatch(/common dir/);
    expect(cleanupEligibility({ dir: d, poolRoot, nowMs, realCommonDir: `${d}/.git`, realObjectsDir: '/h/workspace/webeverything/.git/objects' }).reason).toMatch(/object store/);
  });
  it('refuses a lane with a gc.recentObjectsHook', () => expect(cleanupEligibility({ dir: `${poolRoot}/web-everything/lane-5`, poolRoot, nowMs, gcHooks: ['x'] }).ok).toBe(false));
  it('refuses a live lease', () => expect(cleanupEligibility({ dir: `${poolRoot}/web-everything/lane-5`, poolRoot, lease: fresh, nowMs })).toMatchObject({ ok: false, reason: expect.stringMatching(/live lease/) }));
  it('refuses a reserved lease even when old', () => expect(cleanupEligibility({ dir: `${poolRoot}/web-everything/lane-5`, poolRoot, lease: { ...stale, reserved: true }, nowMs })).toMatchObject({ ok: false, reason: 'reserved lease' }));
  it('refuses a lane with a git lock', () => expect(cleanupEligibility({ dir: `${poolRoot}/web-everything/lane-5`, poolRoot, nowMs, locks: ['index.lock'] }).ok).toBe(false));
  it('refuses the drain daemon clone even though it is shaped lane-N', () => expect(cleanupEligibility({ dir: `${poolRoot}/we-drain-daemon/lane-1`, poolRoot, nowMs }).ok).toBe(false));
  it('refuses the primary checkout, wev-* daemon clones, and nested paths', () => {
    for (const dir of ['/h/workspace/webeverything', '/h/workspace/wev-review-daemon', `${poolRoot}/web-everything/lane-5/sub`, `${poolRoot}/web-everything`]) {
      expect(cleanupEligibility({ dir, poolRoot, nowMs }).ok).toBe(false);
    }
  });
});

describe('count-objects projection', () => {
  it('counts loose + garbage KiB as the lower bound', () => {
    const c = parseCountObjects('count: 3\nsize: 100\nin-pack: 9\npacks: 2\nsize-pack: 50\nprune-packable: 1\ngarbage: 0\nsize-garbage: 4\n');
    expect(c).toMatchObject({ count: 3, size: 100, packs: 2, 'size-garbage': 4 });
    expect(projectedFreedBytes(c)).toBe(104 * 1024);
  });
});

describe('real git: cleanup CLI', () => {
  let root;
  let poolRoot;
  let up;
  const lane = (n) => join(poolRoot, 'web-everything', `lane-${n}`);
  // Plumbing-only ledger append on upstream's ops/review-requests (no checkout moves): a fresh ~400 KB blob.
  const pushLedgerTip = () => {
    const blobFile = join(root, 'blob.tmp');
    writeFileSync(blobFile, randomBytes(200_000).toString('hex'));
    const blob = git(up, 'hash-object', '-w', blobFile);
    const tree = execFileSync('git', ['mktree'], { cwd: up, env, input: `100644 blob ${blob}\tledger.jsonl\n`, encoding: 'utf8' }).trim();
    let parent = null;
    try { parent = git(up, 'rev-parse', '--verify', '--quiet', 'refs/heads/ops/review-requests'); } catch { parent = null; }
    const commit = git(up, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'ledger');
    git(up, 'update-ref', 'refs/heads/ops/review-requests', commit);
  };
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'lane-git-diet-'));
    poolRoot = join(root, '.lanes');
    up = join(root, 'up');
    mkdirSync(up);
    git(up, 'init', '-q', '-b', 'main');
    writeFileSync(join(up, 'a.txt'), 'a');
    git(up, 'add', 'a.txt');
    git(up, 'commit', '-qm', 'a');
    pushLedgerTip();
    mkdirSync(join(poolRoot, 'web-everything'), { recursive: true });
    for (const n of [1, 2]) {
      git(root, 'clone', '-q', up, lane(n));
      git(lane(n), 'config', 'fetch.unpackLimit', '100'); // stock behaviour: small fetches land loose
    }
    // grow the ledger a few times so each lane holds several loose blobs from default fetches
    for (let i = 0; i < 3; i++) { pushLedgerTip(); for (const n of [1, 2]) git(lane(n), 'fetch', '-q', 'origin'); }
    writeFileSync(join(lane(1), 'dirty.txt'), 'uncommitted work'); // the cleanup must never touch this
    writeFileSync(join(lane(2), '.git', '.lane-lease'), JSON.stringify({ acquiredAt: new Date().toISOString(), purpose: 'busy' }));
    git(root, 'clone', '-q', up, lane(3)); // lane-3 is borrowed by another repo: pruning it could break the borrower
    mkdirSync(join(root, 'borrower', 'objects', 'info'), { recursive: true });
    writeFileSync(join(root, 'borrower', 'objects', 'info', 'alternates'), `${join(lane(3), '.git', 'objects')}\n`);
    symlinkSync(lane(1), lane(4)); // lane-4 is a symlink alias of lane-1
  }, 60_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it.each(['shallow', 'index', 'gc.log', 'FETCH_HEAD', 'ORIG_HEAD', 'custom/nested/file', 'custom/dangling'])('reports and refuses a symlink at .git/%s', (path) => {
    const dir = lane(13);
    git(root, 'clone', '-q', up, dir);
    const victim = join(root, 'outside-git-file');
    const contents = `${git(dir, 'rev-parse', 'HEAD')}\n`;
    writeFileSync(victim, contents);
    const link = join(dir, '.git', path);
    rmSync(link, { force: true });
    mkdirSync(join(link, '..'), { recursive: true });
    symlinkSync(path.endsWith('dangling') ? join(root, 'absent') : victim, link);
    const configBefore = readFileSync(join(dir, '.git', 'config'), 'utf8');
    const refsBefore = refs(dir);
    try {
      for (const mode of [[], ['--apply']]) {
        const out = JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--lanes=13', '--json', ...mode], { env, encoding: 'utf8' }));
        expect(out.rows[0].skipped).toBe(`symlinked git paths (${path})`);
        expect(readFileSync(victim, 'utf8')).toBe(contents);
        expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).toBe(configBefore);
        expect(refs(dir)).toEqual(refsBefore);
        expect(existsSync(join(dir, '.git', '.lane-lease'))).toBe(false);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it.each(['scan root', 'pool root', 'pool', 'tmp root', 'late scan root', 'borrower object store', 'alternate target'])('fails closed when borrower discovery cannot inspect the %s', (variant) => {
    const dir = lane(14);
    git(root, 'clone', '-q', up, dir);
    const late = variant === 'late scan root';
    const borrower = join(root, 'unreadable-borrower');
    const intermediate = join(root, 'unreadable-cache', 'nested', 'objects');
    const resolving = ['borrower object store', 'alternate target'].includes(variant);
    if (resolving) {
      mkdirSync(join(borrower, 'objects', 'info'), { recursive: true });
      mkdirSync(join(intermediate, 'info'), { recursive: true });
      writeFileSync(join(borrower, 'objects', 'info', 'alternates'), `${intermediate}\n`);
      writeFileSync(join(intermediate, 'info', 'alternates'), `${join(dir, '.git', 'objects')}\n`);
    }
    const denied = resolving ? (variant === 'borrower object store' ? join(borrower, 'objects') : intermediate)
      : variant === 'pool root' ? poolRoot : variant === 'pool' ? join(poolRoot, 'web-everything') : variant === 'tmp root' ? tmpdir() : root;
    const method = resolving ? 'realpathSync' : 'readdirSync';
    // Patch the builtin in the child process: deterministic EACCES even when tests run as root.
    const preload = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const original = fs.${method}; const literal = ${JSON.stringify(denied)}; const denied = fs.realpathSync(literal); let calls = 0;
      fs.${method} = function(path, ...args) {
        if ((String(path) === denied || String(path) === literal) && ++calls >= ${late ? 2 : 1}) throw Object.assign(new Error('injected EACCES scanning ' + path), { code: 'EACCES' });
        return original.call(this, path, ...args);
      }; syncBuiltinESMExports();`;
    const configBefore = readFileSync(join(dir, '.git', 'config'), 'utf8');
    const refsBefore = refs(dir);
    const countsBefore = git(dir, 'count-objects', '-v');
    try {
      const out = spawnSync('node', ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--apply', '--lanes=14', '--json'], { env, encoding: 'utf8', timeout: 50_000, maxBuffer: 1024 * 1024 });
      if (late) {
        expect(out.status).toBe(0);
        expect(JSON.parse(out.stdout).rows[0].error).toContain('injected EACCES');
      } else {
        expect(out.status).toBe(1);
        expect(out.stderr).toContain('injected EACCES');
        expect(out.stderr).toContain('borrowerMap');
        expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).toBe(configBefore);
        expect(refs(dir)).toEqual(refsBefore);
      }
      expect(git(dir, 'count-objects', '-v')).toBe(countsBefore);
      expect(existsSync(join(dir, '.git', '.lane-lease'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(borrower, { recursive: true, force: true });
      rmSync(join(root, 'unreadable-cache'), { recursive: true, force: true });
    }
  }, 60_000);

  it.each(['info', 'info/refs'])('refuses a symlink at .git/%s before server-info can overwrite an outside file', (path) => {
    const dir = lane(10);
    const outside = join(root, 'outside-info');
    git(root, 'clone', '-q', up, dir);
    mkdirSync(outside, { recursive: true });
    const victim = join(outside, 'refs');
    writeFileSync(victim, 'valuable outside contents\n');
    const link = join(dir, '.git', path);
    rmSync(link, { recursive: true, force: true });
    symlinkSync(path === 'info' ? outside : victim, link);
    const configBefore = readFileSync(join(dir, '.git', 'config'), 'utf8');
    try {
      const out = JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--apply', '--lanes=10', '--json'], { env, encoding: 'utf8' }));
      expect(readFileSync(victim, 'utf8')).toBe('valuable outside contents\n');
      expect(out.rows[0].skipped).toMatch(/symlinked git paths/);
      expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).toBe(configBefore);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it.each([false, true])('protects transitive alternates through an undiscovered store, including cycles (late: %s)', (late) => {
    const dir = lane(11);
    const borrower = join(root, 'transitive-borrower');
    const intermediate = join(root, 'cache', 'deep', 'objects');
    git(root, 'clone', '-q', up, dir);
    git(root, 'clone', '-q', up, borrower);
    mkdirSync(join(intermediate, 'info'), { recursive: true });
    const objects = join(dir, '.git', 'objects');
    const borrowerObjects = join(borrower, '.git', 'objects');
    writeFileSync(join(borrowerObjects, 'info', 'alternates'), `"${relative(borrowerObjects, intermediate)}"\n`);
    writeFileSync(join(intermediate, 'info', 'alternates'), `"${relative(intermediate, objects)}"\n${borrowerObjects}\n`);
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, env, input: 'transitive borrower only', encoding: 'utf8' }).trim();
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(join(objects, blob.slice(0, 2), blob.slice(2)), old, old);
    git(borrower, 'update-ref', 'refs/keep/borrowed', blob);
    try {
      expect(git(borrower, 'cat-file', '-p', blob)).toBe('transitive borrower only');
      if (late) rmSync(join(intermediate, 'info', 'alternates'));
      const out = JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--apply', '--lanes=11', '--json'], {
        env: late ? { ...env, VITEST: 'true', LANE_GIT_DIET_TEST_LATE_BORROWER: intermediate, LANE_GIT_DIET_TEST_QUOTED_ALTERNATE: '1' } : env, encoding: 'utf8',
      }));
      expect(git(borrower, 'cat-file', '-p', blob)).toBe('transitive borrower only');
      expect(out.rows[0].skipped).toMatch(/borrowed by .*transitive-borrower/);
      if (late) expect(out.rows[0].skipped).toMatch(/gc skipped/);
    } finally {
      for (const path of [dir, borrower, join(root, 'cache')]) rmSync(path, { recursive: true, force: true });
    }
  }, 60_000);

  it.each(['filter', 'filterTo', 'both'])('refuses GC repack filtering (%s), preserving reachable packed blobs', (variant) => {
    const dir = lane(12);
    const outside = join(root, 'filtered');
    git(root, 'clone', '-q', up, dir);
    git(dir, 'repack', '-ad');
    mkdirSync(outside, { recursive: true });
    if (variant !== 'filterTo') git(dir, 'config', 'gc.repackFilter', 'blob:none');
    if (variant !== 'filter') git(dir, 'config', 'gc.repackFilterTo', join(outside, 'pack'));
    const configBefore = readFileSync(join(dir, '.git', 'config'), 'utf8');
    try {
      const out = JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--apply', '--lanes=12', '--json'], { env, encoding: 'utf8' }));
      expect(git(dir, 'cat-file', '-p', 'HEAD:a.txt')).toBe('a');
      expect(git(dir, 'fsck', '--connectivity-only', '--no-progress')).toBe('');
      expect(out.rows[0].skipped).toMatch(/repack filter/i);
      expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).toBe(configBefore);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  const snapshot = (dir) => ({ config: readFileSync(join(dir, '.git', 'config'), 'utf8'), refs: refs(dir), objects: git(dir, 'count-objects', '-v') });
  const hasOpsRef = (dir) => existsSync(join(dir, '.git', 'refs', 'remotes', 'origin', 'ops', 'review-requests'))
    || readFileSync(join(dir, '.git', 'packed-refs'), 'utf8').includes('refs/remotes/origin/ops/review-requests');
  const hook = (dir, ran) => git(dir, 'config', 'gc.recentObjectsHook', `touch '${ran}'`);
  const commondir = (dir, target) => writeFileSync(join(dir, '.git', 'commondir'), `${target}\n`);

  // Each startup refusal through the CLI (both modes): the lane, and any repo it points into, stay untouched.
  it.each([
    ...['index.lock', 'HEAD.lock', 'packed-refs.lock', 'gc.pid', 'shallow.lock', 'config.lock'].map((name) => [`git lock ${name}`, (dir) => writeFileSync(join(dir, '.git', name), ''), `git lock present (${name})`]),
    ['gc.recentObjectsHook', (dir, other, ran) => hook(dir, ran), 'gc.recentObjectsHook configured (gc would run it)'],
    ['absolute commondir', (dir, other) => commondir(dir, join(other, '.git')), /^git common dir is redirected/],
    ['relative commondir', (dir, other) => commondir(dir, relative(join(dir, '.git'), join(other, '.git'))), /^git common dir is redirected/],
    ['redirected object store', (dir, other) => {
      rmSync(join(dir, '.git', 'objects'), { recursive: true, force: true });
      symlinkSync(join(other, '.git', 'objects'), join(dir, '.git', 'objects'));
    }, /^object store is redirected/],
  ])('refuses a lane with a %s at startup, changing nothing', (_, plant, reason) => {
    const dir = lane(15);
    const other = join(root, 'refusal-other');
    const ran = join(root, 'refusal-hook-ran');
    git(root, 'clone', '-q', up, dir);
    git(root, 'clone', '-q', up, other);
    plant(dir, other, ran);
    const laneBefore = snapshot(dir);
    const otherBefore = snapshot(other);
    try {
      for (const mode of [[], ['--prune-expire=now', '--apply']]) {
        const out = JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--lanes=15', '--json', ...mode], { env, encoding: 'utf8' }));
        expect(out.rows[0].skipped).toMatch(reason);
        expect(snapshot(dir)).toEqual(laneBefore);
        expect(snapshot(other)).toEqual(otherBefore);
        expect(existsSync(ran)).toBe(false);
        expect(existsSync(join(dir, '.git', '.lane-lease'))).toBe(false);
      }
    } finally {
      for (const path of [dir, other, ran]) rmSync(path, { recursive: true, force: true });
    }
  }, 60_000);

  // Run --apply paused at `stage` (the CLI's vitest-only seam), change the lane there, then let it continue.
  const runPaused = async (n, stage, change) => {
    const signals = mkdtempSync(join(root, 'pause-'));
    const child = spawn('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--prune-expire=now', '--apply', `--lanes=${n}`, '--json'], {
      env: { ...env, VITEST: 'true', LANE_GIT_DIET_TEST_PAUSE_AT: stage, LANE_GIT_DIET_TEST_PAUSE_DIR: signals },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const exited = new Promise((done) => child.on('close', done));
    try {
      while (!existsSync(join(signals, 'ready'))) {
        if (child.exitCode !== null) throw new Error(`CLI exited before pausing: ${stderr}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      change();
    } finally {
      writeFileSync(join(signals, 'go'), '');
    }
    expect(await exited, stderr).toBe(0);
    rmSync(signals, { recursive: true, force: true });
    return JSON.parse(stdout);
  };

  it.each([
    ['git lock', (dir) => writeFileSync(join(dir, '.git', 'index.lock'), ''), 'git lock present (index.lock)'],
    ['gc.recentObjectsHook', (dir, other, ran) => hook(dir, ran), 'gc.recentObjectsHook configured (gc would run it)'],
    ['redirected common dir', (dir, other) => commondir(dir, join(other, '.git')), /^git common dir is redirected/],
  ])('the under-claim recheck refuses a %s that appears after the startup check', async (_, plant, reason) => {
    const dir = lane(16);
    const other = join(root, 'recheck-other');
    const ran = join(root, 'recheck-hook-ran');
    git(root, 'clone', '-q', up, dir);
    git(root, 'clone', '-q', up, other);
    const otherBefore = snapshot(other);
    try {
      const out = await runPaused(16, 'after-claim', () => plant(dir, other, ran));
      expect(out.rows[0].skipped).toMatch(reason);
      // The recheck runs before any write: no diet config, the ops ref kept, the hook never ran, our claim dropped.
      expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).not.toContain(LANE_OPS_NEGATIVE_FETCH);
      expect(hasOpsRef(dir)).toBe(true);
      expect(existsSync(ran)).toBe(false);
      expect(snapshot(other)).toEqual(otherBefore);
      expect(existsSync(join(dir, '.git', '.lane-lease'))).toBe(false);
    } finally {
      for (const path of [dir, other, ran]) rmSync(path, { recursive: true, force: true });
    }
  }, 60_000);

  it('loses the O_EXCL claim race to a marker written after the startup check, and leaves that marker', async () => {
    const dir = lane(17);
    git(root, 'clone', '-q', up, dir);
    const configBefore = readFileSync(join(dir, '.git', 'config'), 'utf8');
    const foreign = JSON.stringify({ holder: 'someone-else', session: 'someone-else', purpose: 'busy', acquiredAt: new Date().toISOString() });
    try {
      const out = await runPaused(17, 'before-claim', () => writeFileSync(join(dir, '.git', '.lane-lease'), foreign));
      expect(out.rows[0].skipped).toBe('lost the claim race (someone took the lane)');
      expect(readFileSync(join(dir, '.git', '.lane-lease'), 'utf8')).toBe(foreign);
      expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).toBe(configBefore);
      expect(hasOpsRef(dir)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('unclaim removes only a marker that is still ours', async () => {
    const dir = lane(18);
    git(root, 'clone', '-q', up, dir);
    const foreign = JSON.stringify({ holder: 'someone-else', session: 'someone-else', purpose: 'busy', acquiredAt: new Date().toISOString() });
    try {
      await runPaused(18, 'after-claim', () => writeFileSync(join(dir, '.git', '.lane-lease'), foreign));
      expect(readFileSync(join(dir, '.git', '.lane-lease'), 'utf8')).toBe(foreign);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('dry-run reports a projection and changes nothing', () => {
    const before = git(lane(1), 'count-objects', '-v');
    const out = JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--json'], { env, encoding: 'utf8' }));
    expect(out.mode).toBe('dry-run');
    const r1 = out.rows.find((r) => r.lane === 1);
    expect(r1.opsRefs).toBe(1);
    expect(r1.loose).toBeGreaterThan(0);
    expect(out.rows.find((r) => r.lane === 2).skipped).toMatch(/live lease/);
    expect(out.rows.find((r) => r.lane === 3).skipped).toMatch(/borrowed by/);
    expect(out.rows.find((r) => r.lane === 4).skipped).toMatch(/symlink alias/);
    expect(git(lane(1), 'count-objects', '-v')).toBe(before);
    expect(git(lane(1), 'config', '--get-all', 'remote.origin.fetch')).not.toContain('^refs/heads/ops/');
  });

  it('--apply without an explicit --lanes list is refused', () => {
    expect(() => execFileSync('node', [CLI, `--pool-root=${poolRoot}`, '--apply'], { env, stdio: 'pipe' })).toThrow();
  });

  it('apply cleans the idle lane, keeps its working tree, and never touches the leased one', () => {
    const leasedBefore = { refs: refs(lane(2)), counts: git(lane(2), 'count-objects', '-v'), config: git(lane(2), 'config', '--get-all', 'remote.origin.fetch') };
    const head1 = git(lane(1), 'rev-parse', 'HEAD');
    git(lane(1), 'symbolic-ref', 'refs/remotes/origin/ops/evil', 'refs/heads/main'); // a symref must not delete main
    const out = JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--prune-expire=now', '--apply', '--lanes=1,2,3,4', '--json'], { env, encoding: 'utf8' }));
    const r1 = out.rows.find((r) => r.lane === 1);
    expect(r1).toMatchObject({ mode: 'apply', opsRefsDeleted: 2 });
    expect(git(lane(1), 'rev-parse', 'refs/heads/main')).toBe(head1);
    expect(r1.freedBytes).toBeGreaterThan(0);
    expect(refs(lane(1)).some((r) => r.includes('/ops/'))).toBe(false);
    expect(git(lane(1), 'config', '--get-all', 'remote.origin.fetch').split('\n')).toEqual([LANE_DEFAULT_FETCH, LANE_OPS_NEGATIVE_FETCH]);
    expect(parseCountObjects(git(lane(1), 'count-objects', '-v')).count).toBe(0);
    expect(readFileSync(join(lane(1), 'dirty.txt'), 'utf8')).toBe('uncommitted work');
    expect(git(lane(1), 'rev-parse', 'HEAD')).toBe(head1);
    expect(git(lane(1), 'fsck', '--connectivity-only', '--no-progress')).toBe('');
    expect(out.rows.find((r) => r.lane === 2).skipped).toMatch(/live lease/);
    expect(out.rows.find((r) => r.lane === 3).skipped).toMatch(/borrowed by/);
    expect(refs(lane(3))).toContain('refs/remotes/origin/ops/review-requests');
    expect(existsSync(join(lane(1), '.git', '.lane-lease'))).toBe(false); // the claim marker is dropped afterwards
    expect({ refs: refs(lane(2)), counts: git(lane(2), 'count-objects', '-v'), config: git(lane(2), 'config', '--get-all', 'remote.origin.fetch') }).toEqual(leasedBefore);
    // idempotent: a second apply is a no-op on config and refs
    const again = JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--prune-expire=now', '--apply', '--lanes=1', '--json'], { env, encoding: 'utf8' }));
    expect(again.rows[0]).toMatchObject({ configOps: 0, opsRefsDeleted: 0 });
    expect(existsSync(join(lane(1), '.git'))).toBe(true);
  }, 60_000);

  it('a lane whose .git/config symlinks into another repo is refused and the target config is untouched', () => {
    const primary = join(root, 'primary');
    git(root, 'clone', '-q', up, primary);
    git(root, 'clone', '-q', up, lane(6));
    rmSync(join(lane(6), '.git', 'config'));
    symlinkSync(join(primary, '.git', 'config'), join(lane(6), '.git', 'config'));
    const before = readFileSync(join(primary, '.git', 'config'), 'utf8');
    const out = JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--prune-expire=now', '--apply', '--lanes=6', '--json'], { env, encoding: 'utf8' }));
    expect(out.rows[0].skipped).toMatch(/symlinked git paths \(config\)/);
    expect(readFileSync(join(primary, '.git', 'config'), 'utf8')).toBe(before);
  }, 60_000);

  it.each([false, true])('a borrower that appears after startup stops gc (quoted alternate: %s)', (quoted) => {
    rmSync(lane(5), { recursive: true, force: true });
    rmSync(join(root, 'late-borrower'), { recursive: true, force: true });
    git(root, 'clone', '-q', up, lane(5));
    git(lane(5), 'config', 'fetch.unpackLimit', '100');
    pushLedgerTip();
    git(lane(5), 'fetch', '-q', 'origin');
    const looseBefore = parseCountObjects(git(lane(5), 'count-objects', '-v')).count;
    expect(looseBefore).toBeGreaterThan(0);
    const late = join(root, 'late-borrower', 'objects');
    const out = JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--prune-expire=now', '--apply', '--lanes=5', '--json'], {
      env: { ...env, VITEST: 'true', LANE_GIT_DIET_TEST_LATE_BORROWER: late, LANE_GIT_DIET_TEST_QUOTED_ALTERNATE: quoted ? '1' : '' }, encoding: 'utf8',
    }));
    expect(out.rows[0].skipped).toMatch(/borrowed by .*late-borrower.*gc skipped/);
    expect(parseCountObjects(git(lane(5), 'count-objects', '-v')).count).toBe(looseBefore); // gc never ran
    expect(existsSync(join(lane(5), '.git', '.lane-lease'))).toBe(false);
  }, 60_000);

  it.each(['logs/refs/remotes/origin/ops/sub', 'logs/refs/remotes/origin/ops/sub/important.txt', 'refs/remotes/origin/ops/sub'])('refuses a nested symlink at %s without deleting an outside file', (path) => {
    const dir = lane(7);
    git(root, 'clone', '-q', up, dir);
    const ref = 'refs/remotes/origin/ops/sub/important.txt';
    git(dir, 'update-ref', ref, 'HEAD');
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    const victim = join(outside, 'important.txt');
    const contents = `${git(dir, 'rev-parse', 'HEAD')}\n`;
    writeFileSync(victim, contents);
    const link = join(dir, '.git', path);
    rmSync(link, { recursive: true, force: true });
    mkdirSync(join(link, '..'), { recursive: true });
    symlinkSync(path.endsWith('important.txt') ? victim : outside, link);
    const configBefore = readFileSync(join(dir, '.git', 'config'), 'utf8');
    try {
      const out = JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--apply', '--lanes=7', '--json'], { env, encoding: 'utf8' }));
      // Check the real victim first: Git's reflog deletion follows intermediate symlinks.
      expect(existsSync(victim)).toBe(true);
      expect(readFileSync(victim, 'utf8')).toBe(contents);
      expect(out.rows[0].skipped).toMatch(/symlinked git paths/);
      expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).toBe(configBefore);
      expect(existsSync(join(dir, '.git', '.lane-lease'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it.each(['absolute', 'relative', 'linked worktree'].flatMap((variant) => [false, true].map((late) => [variant, late])))('protects objects borrowed through a %s Gitfile (late: %s)', (variant, late) => {
    const dir = lane(9);
    const borrower = join(root, 'gitfile-borrower');
    const metadata = join(root, 'metadata', 'borrower git');
    git(root, 'clone', '-q', up, dir);
    mkdirSync(join(root, 'metadata'), { recursive: true });
    git(root, 'clone', '-q', `--separate-git-dir=${metadata}`, up, borrower);
    if (variant === 'relative') writeFileSync(join(borrower, '.git'), `gitdir: ${relative(borrower, metadata)}\n`);
    if (variant === 'linked worktree') {
      const hidden = join(root, 'metadata', 'original');
      git(borrower, 'worktree', 'add', '--detach', hidden);
      // Expose only the linked worktree to the bounded borrower scan.
      rmSync(borrower, { recursive: true, force: true });
      git(hidden, 'worktree', 'add', '--detach', borrower);
    }
    const objects = join(dir, '.git', 'objects');
    writeFileSync(join(metadata, 'objects', 'info', 'alternates'), `${objects}\n`);
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, env, input: 'gitfile borrower only', encoding: 'utf8' }).trim();
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(join(objects, blob.slice(0, 2), blob.slice(2)), old, old);
    git(borrower, 'update-ref', 'refs/keep/borrowed', blob);
    try {
      expect(git(borrower, 'cat-file', '-p', blob)).toBe('gitfile borrower only');
      if (late) rmSync(join(metadata, 'objects', 'info', 'alternates'));
      const out = JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--apply', '--lanes=9', '--json'], {
        env: late ? { ...env, VITEST: 'true', LANE_GIT_DIET_TEST_LATE_BORROWER: join(metadata, 'objects') } : env, encoding: 'utf8',
      }));
      expect(git(borrower, 'cat-file', '-p', blob)).toBe('gitfile borrower only');
      expect(out.rows[0].skipped).toMatch(/borrowed by .*gitfile-borrower/);
      if (late) expect(out.rows[0].skipped).toMatch(/gc skipped/);
      else expect(refs(dir)).toContain('refs/remotes/origin/ops/review-requests');
    } finally {
      rmSync(borrower, { recursive: true, force: true });
      rmSync(join(root, 'metadata'), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it.each(['quoted absolute', 'quoted relative', 'octal', 'escaped', 'unicode', 'unquoted spaces', 'quoted BOM', 'unquoted BOM'])('protects objects borrowed via %s alternates', (variant) => {
    const dir = lane(8);
    const borrower = join(root, 'quoted-borrower');
    git(root, 'clone', '-q', up, dir);
    git(root, 'clone', '-q', up, borrower);
    const objects = join(dir, '.git', 'objects');
    const alias = variant.endsWith('BOM') ? join(borrower, '.git', 'objects', '\uFEFFalias') : join(root, variant === 'escaped' ? 'objects "\\\t\n' : variant === 'unicode' ? 'objects-é' : 'objects with spaces');
    if (['escaped', 'unicode', 'unquoted spaces', 'quoted BOM', 'unquoted BOM'].includes(variant)) symlinkSync(objects, alias);
    let line = `"${objects}"`;
    if (variant === 'quoted relative') line = '"../../../.lanes/web-everything/lane-8/.git/objects"';
    if (variant === 'octal') line = `"${objects.replaceAll('/', '\\057')}"`;
    if (variant === 'escaped') line = `"${alias.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\t', '\\t').replaceAll('\n', '\\n')}"`;
    if (variant === 'unicode') line = `"${alias.replace('é', '\\303\\251')}"`;
    if (variant === 'unquoted spaces') line = alias;
    if (variant === 'quoted BOM') line = '"\\357\\273\\277alias"';
    if (variant === 'unquoted BOM') line = '\uFEFFalias';
    writeFileSync(join(borrower, '.git', 'objects', 'info', 'alternates'), `${line}\n`);
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, env, input: 'borrower-only object', encoding: 'utf8' }).trim();
    git(borrower, 'update-ref', 'refs/keep/borrowed', blob);
    try {
      expect(git(borrower, 'cat-file', '-p', blob)).toBe('borrower-only object'); // Git accepts this spelling.
      const out = JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--prune-expire=now', '--apply', '--lanes=8', '--json'], { env, encoding: 'utf8' }));
      expect(out.rows[0].skipped).toMatch(/borrowed by .*quoted-borrower/);
      expect(git(borrower, 'cat-file', '-p', blob)).toBe('borrower-only object');
      expect(refs(dir)).toContain('refs/remotes/origin/ops/review-requests');
    } finally {
      rmSync(borrower, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
      rmSync(alias, { force: true });
    }
  }, 60_000);
});
