/**
 * @file lane-git-diet-cleanup.test.mjs — proof for the one-time lane cleanup: eligibility rules (pure), the
 *   count-objects projection, and the CLI on real repos (dry-run changes nothing; apply claims the lane, skips
 *   leased/borrowed/symlinked lanes, keeps the working tree, frees the ledger blobs, is idempotent).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, renameSync, symlinkSync, utimesSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LANE_DEFAULT_FETCH, LANE_OPS_NEGATIVE_FETCH } from '../lane-git-diet.mjs';
import { cleanupEligibility, CLEANUP_POOLS, parseCountObjects, projectedFreedBytes } from '../lane-git-diet-cleanup.mjs';

const REPO = join(import.meta.dirname, '..', '..', '..');
const CLI = join(REPO, 'scripts', 'lane-git-diet.mjs');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.LANE_SESSION;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const refs = (cwd, prefix = 'refs/remotes/origin/') => git(cwd, 'for-each-ref', '--format=%(refname)', prefix).split('\n').filter(Boolean);
// Planted by the CLI startup-refusal test below. The guard holds them to the CLI's own IN_FLIGHT set, so every
// in-flight name the CLI refuses on has a named test, and a name added there without one fails here.
const TOP_LOCK_NAMES = ['index.lock', 'HEAD.lock', 'packed-refs.lock', 'gc.pid', 'shallow.lock', 'config.lock'];
const IN_FLIGHT_PATHS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'AUTO_MERGE', 'BISECT_HEAD', 'BISECT_START',
  'rebase-merge/head-name', 'rebase-apply/next', 'sequencer/todo', 'worktrees/w/REBASE_HEAD', 'NOTES_MERGE_PARTIAL', 'NOTES_MERGE_REF', 'NOTES_MERGE_WORKTREE/x'];
const inFlightName = (path) => path.split('/')[path.startsWith('worktrees/') ? 2 : 0];

describe('CLI repack and prune retention guarantees', () => {
  const old = new Date('2000-01-01T00:00:00Z');
  // Each case gets independent, old objects: neither another root nor the prune grace period can save them.
  function fixture(run) {
    const root = mkdtempSync(join(tmpdir(), 'lane-diet-retention-'));
    const poolRoot = join(root, '.lanes');
    const dir = join(poolRoot, 'web-everything', 'lane-1');
    mkdirSync(dir, { recursive: true });
    const inputGit = (args, input) => execFileSync('git', args, { cwd: dir, env, input, encoding: 'utf8' }).trim();
    const age = (oid) => utimesSync(join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), old, old);
    const graph = (text, parent) => {
      const blob = inputGit(['hash-object', '-w', '--stdin'], text);
      const tree = inputGit(['mktree'], `100644 blob ${blob}\tretained.txt\n`);
      const commit = git(dir, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', text);
      for (const oid of [blob, tree, commit]) age(oid);
      return { blob, tree, commit };
    };
    try {
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'config', 'core.logAllRefUpdates', 'false');
      const base = graph('base');
      git(dir, 'update-ref', 'refs/heads/main', base.commit);
      const retained = graph('retained');
      const garbage = graph('unprotected control');
      const apply = () => {
        const out = JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`,
          '--apply', '--lanes=1', '--json'], { env, encoding: 'utf8' }));
        expect(out.rows).toHaveLength(1);
        expect(out.rows[0]).toMatchObject({ mode: 'apply' }); // A refusal/error must not masquerade as preservation.
        for (const oid of Object.values(garbage)) expect(() => git(dir, 'cat-file', '-e', oid)).toThrow();
      };
      run({ dir, root, base, retained, graph, apply });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  const expectGraph = (dir, graph) => {
    expect(git(dir, 'cat-file', '-t', graph.commit)).toBe('commit');
    expect(git(dir, 'cat-file', '-t', graph.tree)).toBe('tree');
    expect(git(dir, 'cat-file', '-p', graph.blob)).toBe('retained');
  };

  it.each(['ref', 'index', 'detached HEAD'])('prune keeps old objects reachable only from %s', (root) => fixture(({ dir, retained, apply }) => {
    if (root === 'ref') git(dir, 'update-ref', 'refs/keep/retained', retained.commit);
    if (root === 'index') git(dir, 'update-index', '--add', '--cacheinfo', `100644,${retained.blob},retained.txt`);
    if (root === 'detached HEAD') git(dir, 'update-ref', '--no-deref', 'HEAD', retained.commit);
    expect(existsSync(join(dir, '.git', 'logs'))).toBe(false);
    if (root !== 'ref') expect(refs(dir, 'refs/')).toEqual(['refs/heads/main']);
    const headBefore = readFileSync(join(dir, '.git', 'HEAD'), 'utf8');
    const indexBefore = root === 'index' ? readFileSync(join(dir, '.git', 'index')) : null;
    apply();
    expect(readFileSync(join(dir, '.git', 'HEAD'), 'utf8')).toBe(headBefore);
    if (root === 'index') {
      expect(readFileSync(join(dir, '.git', 'index'))).toEqual(indexBefore);
      expect(git(dir, 'show', ':retained.txt')).toBe('retained');
      expect(() => git(dir, 'cat-file', '-e', retained.commit)).toThrow(); // Only the staged blob is rooted.
    } else {
      expectGraph(dir, retained);
      expect(git(dir, 'rev-parse', root === 'ref' ? 'refs/keep/retained' : 'HEAD')).toBe(retained.commit);
    }
  }), 60_000);

  it.each([
    ['gc.reflogExpire', 'reachable'],
    ['gc.reflogExpireUnreachable', 'unreachable'],
  ])('repack preserves old %s %s reflog entries despite repo expiry=now', (setting, reachability) => fixture(({ dir, base, retained, graph, apply }) => {
    // Isolate each expiry setting: the other cannot account for this case staying green.
    git(dir, 'config', 'gc.reflogExpire', 'never');
    git(dir, 'config', 'gc.reflogExpireUnreachable', 'never');
    git(dir, 'config', setting, 'now');
    const tip = reachability === 'reachable' ? graph('descendant', retained.commit).commit : base.commit;
    for (const oid of [retained.commit, tip]) execFileSync('git', ['update-ref', '--create-reflog', '-m', 'retention probe', 'refs/heads/history', oid], {
      cwd: dir, env: { ...env, GIT_COMMITTER_DATE: old.toISOString() }, stdio: 'pipe',
    });
    const log = join(dir, '.git', 'logs', 'refs', 'heads', 'history');
    const before = readFileSync(log, 'utf8');
    expect(before).toContain(retained.commit);
    // A dry run proves this fixture is eligible for expiry without altering any production guard.
    expect(git(dir, 'reflog', 'expire', '--dry-run', '--verbose', 'refs/heads/history')).toContain('prune retention probe');
    expect(refs(dir, 'refs/')).toEqual(['refs/heads/history', 'refs/heads/main']);
    expect(existsSync(join(dir, '.git', 'index'))).toBe(false);
    apply();
    expect(readFileSync(log, 'utf8')).toBe(before);
    expectGraph(dir, retained);
  }), 60_000);

  // `apply` passes no --prune-expire, so this pins the default 1.hour.ago window from both sides.
  it('default prune grace keeps recent unreachable objects and drops ones older than an hour', () => fixture(({ dir, apply }) => {
    const write = (text) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, env, input: text, encoding: 'utf8' }).trim();
    const backdate = (oid, ms) => {
      const at = new Date(Date.now() - ms);
      utimesSync(join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), at, at);
    };
    const fresh = write('fresh unreachable');
    const halfHour = write('half-hour unreachable');
    const twoHours = write('two-hour unreachable');
    backdate(halfHour, 30 * 60_000);
    backdate(twoHours, 2 * 60 * 60_000);
    apply();
    expect(git(dir, 'cat-file', '-p', fresh)).toBe('fresh unreachable');
    expect(git(dir, 'cat-file', '-p', halfHour)).toBe('half-hour unreachable');
    expect(() => git(dir, 'cat-file', '-e', twoHours)).toThrow();
  }), 60_000);

  it('repack keeps stale linked-worktree metadata and its HEAD-only history despite repo expiry=now', () => fixture(({ dir, root, retained, apply }) => {
    const linked = join(root, 'offline-worktree');
    git(dir, 'worktree', 'add', '--detach', linked, retained.commit);
    const admin = git(linked, 'rev-parse', '--absolute-git-dir');
    // Model an unmounted worktree whose only remaining reachability root is its administrative HEAD.
    rmSync(linked, { recursive: true });
    rmSync(join(admin, 'logs'), { recursive: true, force: true });
    rmSync(join(admin, 'index'));
    utimesSync(join(admin, 'gitdir'), old, old);
    git(dir, 'config', 'gc.worktreePruneExpire', 'now');
    // Git versions differ in which stream carries verbose worktree-prune diagnostics.
    const prune = spawnSync('git', ['worktree', 'prune', '--dry-run', '--verbose', '--expire=now'], {
      cwd: dir, env, encoding: 'utf8', timeout: 10_000,
    });
    expect(prune.error).toBeUndefined();
    expect(prune.status, prune.stderr).toBe(0);
    expect(prune.stdout + prune.stderr).toContain('offline-worktree');
    expect(refs(dir, 'refs/')).toEqual(['refs/heads/main']);
    expect(existsSync(join(dir, '.git', 'logs'))).toBe(false);
    const headBefore = readFileSync(join(admin, 'HEAD'), 'utf8');
    const gitdirBefore = readFileSync(join(admin, 'gitdir'), 'utf8');
    apply();
    expect(readFileSync(join(admin, 'HEAD'), 'utf8')).toBe(headBefore);
    expect(readFileSync(join(admin, 'gitdir'), 'utf8')).toBe(gitdirBefore);
    expectGraph(dir, retained);
  }), 60_000);
});

describe('in-flight refusal coverage', () => {
  it('every name in the CLI IN_FLIGHT set is planted at the top level by a named CLI refusal test', () => {
    const src = readFileSync(CLI, 'utf8').match(/const IN_FLIGHT = new Set\(\[([^\]]*)\]\)/);
    expect(src).not.toBeNull();
    const names = [...src[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    const topLevel = new Set([...TOP_LOCK_NAMES, ...IN_FLIGHT_PATHS.filter((p) => !p.startsWith('worktrees/')).map(inFlightName)]);
    expect(names.filter((name) => !topLevel.has(name))).toEqual([]);
  });
});

describe('cleanupEligibility (pure)', () => {
  const poolRoot = '/h/workspace/.lanes';
  const nowMs = Date.parse('2026-10-21T15:00:00Z');
  const fresh = { acquiredAt: '2026-10-21T14:50:00Z', purpose: 'x' };
  const stale = { acquiredAt: '2026-10-20T00:00:00Z' };
  // The CLI documents exactly these pools: a pool dropped from the list must go red, not just lose its case below.
  it('allow-lists exactly the documented pools', () => expect(CLEANUP_POOLS).toEqual(['web-everything', 'frontierui', 'plateau-app']));
  // Every allow-listed pool gets a positive case, so a pool added to CLEANUP_POOLS is covered automatically.
  it.each(CLEANUP_POOLS)('allows an unleased lane in the %s pool', (pool) => expect(cleanupEligibility({ dir: `${poolRoot}/${pool}/lane-5`, poolRoot, nowMs }).ok).toBe(true));
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
  it('refuses a lane with config-defined hooks', () => expect(cleanupEligibility({ dir: `${poolRoot}/web-everything/lane-5`, poolRoot, nowMs, configHooks: ['hook.x.command', 'hook.x.event'] }))
    .toEqual({ ok: false, reason: 'config-defined hooks configured (hook.x.command, hook.x.event; core.hooksPath does not stop them)' }));
  it('refuses a ref store that lives in another repository, and allows a bare format', () => {
    expect(cleanupEligibility({ dir: `${poolRoot}/web-everything/lane-5`, poolRoot, nowMs, refStorage: ['files:///x/.git'] }))
      .toEqual({ ok: false, reason: 'ref store is redirected (extensions.refStorage=files:///x/.git)' });
    expect(cleanupEligibility({ dir: `${poolRoot}/web-everything/lane-5`, poolRoot, nowMs, refStorage: ['files'] }).ok).toBe(true);
    // Pool lanes are files-format: a bare `reftable` on one hides every ref, so prune would see no history at all.
    expect(cleanupEligibility({ dir: `${poolRoot}/web-everything/lane-5`, poolRoot, nowMs, refStorage: ['reftable'] }))
      .toEqual({ ok: false, reason: 'ref store is redirected (extensions.refStorage=reftable)' });
  });
  it('refuses an unreadable common dir', () => expect(cleanupEligibility({ dir: `${poolRoot}/web-everything/lane-5`, poolRoot, nowMs, realCommonDir: null }).ok).toBe(false));
  it('refuses a lane with per-ref reflog expiry', () => expect(cleanupEligibility({ dir: `${poolRoot}/web-everything/lane-5`, poolRoot, nowMs, gcReflogPatterns: ['gc.refs/heads/*.reflogexpire'] }))
    .toEqual({ ok: false, reason: 'per-ref reflog expiry configured (gc.refs/heads/*.reflogexpire)' }));
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
  // Keep the lane's refs in `other`: every ref write (the ops-ref delete) and gc's reachability walk would act there.
  const foreignRefStore = (dir, other) => {
    git(dir, 'config', 'core.repositoryformatversion', '1');
    git(dir, 'config', 'extensions.refStorage', `files://${join(other, '.git')}`);
  };
  const configHook = (dir, ran) => {
    git(dir, 'config', 'hook.attack.event', 'reference-transaction');
    git(dir, 'config', 'hook.attack.command', `touch '${ran}'`);
  };

  // Each startup refusal through the CLI (both modes): the lane, and any repo it points into, stay untouched.
  it.each([
    ...TOP_LOCK_NAMES.map((name) => [`git lock ${name}`, (dir) => writeFileSync(join(dir, '.git', name), ''), `git lock present (${name})`]),
    // Nested locks: a pending ref transaction, a reflog write, a reftable stack update, a commit-graph write.
    ...['refs/heads/x.lock', 'refs/remotes/origin/ops/review-requests.lock', 'logs/refs/heads/main.lock', 'reftable/tables.list.lock', 'objects/info/commit-graphs/commit-graph-chain.lock'].map((path) => [`git lock ${path}`, (dir) => {
      mkdirSync(join(dir, '.git', path, '..'), { recursive: true });
      writeFileSync(join(dir, '.git', path), '');
    }, `git lock present (${path})`]),
    // Unfinished operations: gc does not keep the commits these name.
    ...IN_FLIGHT_PATHS.map((path) => [`in-flight ${path}`, (dir) => {
      mkdirSync(join(dir, '.git', path, '..'), { recursive: true });
      writeFileSync(join(dir, '.git', path), `${git(dir, 'rev-parse', 'HEAD')}\n`);
    }, `git lock present (${path.split('/').slice(0, path.startsWith('worktrees/') ? 3 : 1).join('/')})`]),
    ['gc.recentObjectsHook', (dir, other, ran) => hook(dir, ran), 'gc.recentObjectsHook configured (gc would run it)'],
    // A per-ref setting beats the generic `never` the gc pins, so it must never reach a gc.
    ['per-ref reflogExpire', (dir) => git(dir, 'config', 'gc.refs/heads/*.reflogExpire', 'now'), 'per-ref reflog expiry configured (gc.refs/heads/*.reflogexpire)'],
    ['per-ref reflogExpireUnreachable', (dir) => git(dir, 'config', 'gc.HEAD.reflogExpireUnreachable', 'now'), 'per-ref reflog expiry configured (gc.HEAD.reflogexpireunreachable)'],
    // Config-defined hooks ignore core.hooksPath: the ops-ref delete (update-ref) would run this one.
    ['config-defined reference-transaction hook', (dir, other, ran) => configHook(dir, ran), 'config-defined hooks configured (hook.attack.event, hook.attack.command; core.hooksPath does not stop them)'],
    ['ref store in another repo', (dir, other) => foreignRefStore(dir, other), /^ref store is redirected \(extensions\.refStorage=files:\/\//],
    ['bare reftable on a files lane (every ref hidden)', (dir) => {
      git(dir, 'config', 'core.repositoryformatversion', '1');
      git(dir, 'config', 'extensions.refStorage', 'reftable');
    }, 'ref store is redirected (extensions.refStorage=reftable)'],
    // Git keeps the trailing space of a commondir path: `<lane>/.git ` is another store, not the lane's own `.git`.
    ['trailing-space commondir', (dir) => {
      cpSync(join(dir, '.git'), join(dir, '.git '), { recursive: true });
      commondir(dir, join(dir, '.git '));
    }, /^git common dir is redirected/],
    ['absolute commondir',(dir, other) => commondir(dir, join(other, '.git')), /^git common dir is redirected/],
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
      const deadline = Date.now() + 30_000;
      while (!existsSync(join(signals, 'ready'))) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`CLI exited before pausing: ${stderr}`);
        if (Date.now() > deadline) throw new Error('CLI never reached the pause');
        await new Promise((r) => setTimeout(r, 20));
      }
      change();
    } catch (err) {
      child.kill('SIGKILL'); // never let a half-planted run go on to --apply
      await exited;
      throw err;
    }
    writeFileSync(join(signals, 'go'), '');
    expect(await exited, stderr).toBe(0);
    rmSync(signals, { recursive: true, force: true });
    return JSON.parse(stdout);
  };

  // Every input of the under-claim recheck, planted after the startup check passed.
  it.each([
    ['git lock', (dir) => writeFileSync(join(dir, '.git', 'index.lock'), ''), 'git lock present (index.lock)'],
    ['in-flight merge', (dir) => writeFileSync(join(dir, '.git', 'MERGE_HEAD'), `${git(dir, 'rev-parse', 'HEAD')}\n`), 'git lock present (MERGE_HEAD)'],
    ['gc.recentObjectsHook', (dir, other, ran) => hook(dir, ran), 'gc.recentObjectsHook configured (gc would run it)'],
    ['GC repack filter', (dir) => git(dir, 'config', 'gc.repackFilter', 'blob:none'), /^GC repack filtering configured/],
    ['per-ref reflog expiry', (dir) => git(dir, 'config', 'gc.refs/remotes/*.reflogExpireUnreachable', 'now'), 'per-ref reflog expiry configured (gc.refs/remotes/*.reflogexpireunreachable)'],
    ['config-defined hook', (dir, other, ran) => configHook(dir, ran), /^config-defined hooks configured \(hook\.attack\./],
    ['ref store in another repo', (dir, other) => foreignRefStore(dir, other), /^ref store is redirected/],
    ['trailing-space common dir', (dir) => {
      cpSync(join(dir, '.git'), join(dir, '.git '), { recursive: true });
      commondir(dir, join(dir, '.git '));
    }, /^git common dir is redirected/],
    ['redirected common dir',(dir, other) => commondir(dir, join(other, '.git')), /^git common dir is redirected/],
    ['symlinked .git/info', (dir, other) => {
      rmSync(join(dir, '.git', 'info'), { recursive: true, force: true });
      symlinkSync(join(other, '.git', 'info'), join(dir, '.git', 'info'));
    }, 'symlinked git paths (info)'],
    ['redirected object store', (dir, other) => {
      rmSync(join(dir, '.git', 'objects'), { recursive: true, force: true });
      symlinkSync(join(other, '.git', 'objects'), join(dir, '.git', 'objects'));
    }, /^object store is redirected/],
    ['redirected .git', (dir, other) => {
      const moved = join(other, 'moved-git');
      renameSync(join(dir, '.git'), moved);
      symlinkSync(moved, join(dir, '.git'));
    }, /^\.git is not the lane's own directory/],
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

  it('a prepared update-ref transaction blocks gc, so the commit it is about to publish survives', async () => {
    const dir = lane(19);
    git(root, 'clone', '-q', up, dir);
    // An old commit reachable from nothing yet: exactly what a pending transaction is about to reference.
    const tree = git(dir, 'rev-parse', 'HEAD^{tree}');
    const rescue = git(dir, 'commit-tree', tree, '-p', 'HEAD', '-m', 'rescue');
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(join(dir, '.git', 'objects', rescue.slice(0, 2), rescue.slice(2)), old, old);
    const tx = spawn('git', ['update-ref', '--stdin'], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise((done) => tx.on('close', done));
    try {
      tx.stdin.write(`start\nupdate refs/heads/rescue ${rescue}\nprepare\n`);
      const lock = join(dir, '.git', 'refs', 'heads', 'rescue.lock');
      const deadline = Date.now() + 10_000;
      while (!existsSync(lock)) {
        if (Date.now() > deadline) throw new Error('update-ref never prepared');
        await new Promise((r) => setTimeout(r, 20));
      }
      const out = JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--prune-expire=now', '--apply', '--lanes=19', '--json'], { env, encoding: 'utf8' }));
      expect(out.rows[0].skipped).toBe('git lock present (refs/heads/rescue.lock)');
      tx.stdin.end('commit\n');
      expect(await closed).toBe(0);
      expect(git(dir, 'rev-parse', 'refs/heads/rescue')).toBe(rescue);
      expect(git(dir, 'cat-file', '-t', rescue)).toBe('commit');
      expect(existsSync(join(dir, '.git', '.lane-lease'))).toBe(false);
    } finally {
      tx.kill();
      await closed;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('a ref lock that appears after the recheck, just before gc, still skips gc and keeps the old unreachable commit', async () => {
    const dir = lane(20);
    git(root, 'clone', '-q', up, dir);
    const rescue = git(dir, 'commit-tree', git(dir, 'rev-parse', 'HEAD^{tree}'), '-p', 'HEAD', '-m', 'late rescue');
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(join(dir, '.git', 'objects', rescue.slice(0, 2), rescue.slice(2)), old, old);
    try {
      const out = await runPaused(20, 'before-gc', () => writeFileSync(join(dir, '.git', 'refs', 'heads', 'late.lock'), `${rescue}\n`));
      expect(out.rows[0].skipped).toBe('git lock present (refs/heads/late.lock) (config + ref cleanup done, gc skipped)');
      expect(git(dir, 'cat-file', '-t', rescue)).toBe('commit');
      expect(existsSync(join(dir, '.git', '.lane-lease'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('a ref transaction prepared during the repack, before prune, skips prune and keeps the old unreachable commit', async () => {
    const dir = lane(21);
    git(root, 'clone', '-q', up, dir);
    const rescue = git(dir, 'commit-tree', git(dir, 'rev-parse', 'HEAD^{tree}'), '-p', 'HEAD', '-m', 'mid-gc rescue');
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(join(dir, '.git', 'objects', rescue.slice(0, 2), rescue.slice(2)), old, old);
    try {
      const out = await runPaused(21, 'before-prune', () => writeFileSync(join(dir, '.git', 'refs', 'heads', 'mid.lock'), `${rescue}\n`));
      expect(out.rows[0].skipped).toBe('git lock present (refs/heads/mid.lock) (repack done, prune skipped)');
      expect(git(dir, 'cat-file', '-t', rescue)).toBe('commit');
      expect(existsSync(join(dir, '.git', '.lane-lease'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('a borrower appearing during the repack, before prune, skips prune and keeps the old object it borrows', async () => {
    const dir = lane(24);
    const borrower = join(root, 'repack-borrower');
    git(root, 'clone', '-q', up, dir);
    const borrowed = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, env, input: 'borrowed during repack', encoding: 'utf8' }).trim();
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(join(dir, '.git', 'objects', borrowed.slice(0, 2), borrowed.slice(2)), old, old);
    try {
      const out = await runPaused(24, 'before-prune', () => {
        git(root, 'init', '-q', borrower);
        writeFileSync(join(borrower, '.git', 'objects', 'info', 'alternates'), `${join(dir, '.git', 'objects')}\n`);
      });
      // The scan root is realpath'd (macOS /var → /private/var), so match the borrower by its tail.
      expect(out.rows[0].skipped).toMatch(/^objects borrowed by .*\/repack-borrower \(repack done, prune skipped\)$/);
      expect(git(borrower, 'cat-file', '-p', borrowed)).toBe('borrowed during repack');
      expect(existsSync(join(dir, '.git', '.lane-lease'))).toBe(false);
    } finally {
      rmSync(borrower, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // An operation that starts mid-run names a commit gc does not keep: the same audit must stop gc or prune.
  it.each([
    ['MERGE_HEAD', 'before-gc', '(config + ref cleanup done, gc skipped)'],
    ['MERGE_HEAD', 'before-prune', '(repack done, prune skipped)'],
    ['rebase-merge/stopped-sha', 'before-gc', '(config + ref cleanup done, gc skipped)'],
    ['rebase-merge/stopped-sha', 'before-prune', '(repack done, prune skipped)'],
  ])('an in-flight %s that appears at %s skips the rest and keeps the old unreachable commit it names', async (path, stage, suffix) => {
    const dir = lane(23);
    git(root, 'clone', '-q', up, dir);
    const rescue = git(dir, 'commit-tree', git(dir, 'rev-parse', 'HEAD^{tree}'), '-p', 'HEAD', '-m', `in-flight rescue ${path} ${stage}`);
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(join(dir, '.git', 'objects', rescue.slice(0, 2), rescue.slice(2)), old, old);
    try {
      const out = await runPaused(23, stage, () => {
        mkdirSync(join(dir, '.git', path, '..'), { recursive: true });
        writeFileSync(join(dir, '.git', path), `${rescue}\n`);
      });
      expect(out.rows[0].skipped).toBe(`git lock present (${path.split('/')[0]}) ${suffix}`);
      expect(git(dir, 'cat-file', '-t', rescue)).toBe('commit');
      expect(existsSync(join(dir, '.git', '.lane-lease'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);

  it('a claim taken over during the repack skips prune and leaves the new holder\'s marker', async () => {
    const dir = lane(22);
    git(root, 'clone', '-q', up, dir);
    const rescue = git(dir, 'commit-tree', git(dir, 'rev-parse', 'HEAD^{tree}'), '-p', 'HEAD', '-m', 'taken-over rescue');
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    utimesSync(join(dir, '.git', 'objects', rescue.slice(0, 2), rescue.slice(2)), old, old);
    const marker = join(dir, '.git', '.lane-lease');
    const theirs = JSON.stringify({ holder: 'someone-else', session: 'someone-else' });
    try {
      const out = await runPaused(22, 'before-prune', () => writeFileSync(marker, theirs));
      expect(out.rows[0].skipped).toBe('claim lost (lease marker is no longer ours) (repack done, prune skipped)');
      expect(git(dir, 'cat-file', '-t', rescue)).toBe('commit');
      expect(readFileSync(marker, 'utf8')).toBe(theirs);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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

  it.each([true, false])('a claim taken over after it was made stops all writes; unclaim leaves the new marker (marker rewritten: %s)', async (rewritten) => {
    const dir = lane(18);
    git(root, 'clone', '-q', up, dir);
    const configBefore = readFileSync(join(dir, '.git', 'config'), 'utf8');
    const countsBefore = git(dir, 'count-objects', '-v');
    const marker = join(dir, '.git', '.lane-lease');
    const foreign = JSON.stringify({ holder: 'someone-else', session: 'someone-else', purpose: 'busy', acquiredAt: new Date().toISOString() });
    try {
      const out = await runPaused(18, 'after-claim', () => (rewritten ? writeFileSync(marker, foreign) : rmSync(marker)));
      expect(out.rows[0].skipped).toBe('claim lost (lease marker is no longer ours)');
      expect(readFileSync(join(dir, '.git', 'config'), 'utf8')).toBe(configBefore);
      expect(git(dir, 'count-objects', '-v')).toBe(countsBefore);
      expect(hasOpsRef(dir)).toBe(true);
      if (rewritten) expect(readFileSync(marker, 'utf8')).toBe(foreign);
      else expect(existsSync(marker)).toBe(false);
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

  // Inherited git env must neither redirect the run nor change what the safety checks read from the lane's config.
  it.each([
    ['GIT_DIR + GIT_WORK_TREE at a decoy repo', ({ decoy }) => ({ GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy })],
    ['GIT_CONFIG_PARAMETERS', () => ({ GIT_CONFIG_PARAMETERS: "'gc.repackfilter'='blob:none'" })],
    ['GIT_CONFIG_COUNT / KEY_n / VALUE_n', () => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'gc.repackFilter', GIT_CONFIG_VALUE_0: 'blob:none' })],
    ['GIT_CONFIG_GLOBAL', ({ file }) => ({ GIT_CONFIG_GLOBAL: file('[gc]\n\trepackFilter = blob:none\n') })],
    ['GIT_CONFIG_SYSTEM', ({ file }) => ({ GIT_CONFIG_NOSYSTEM: undefined, GIT_CONFIG_SYSTEM: file('[gc]\n\trepackFilter = blob:none\n') })],
    // The decoy holds the ops ref: a ref store redirected there would have it deleted.
    ['GIT_REFERENCE_BACKEND at a decoy repo', ({ decoy }) => ({ GIT_REFERENCE_BACKEND: `files://${join(decoy, '.git')}` })],
    // A shallow file naming the ops tip makes its history look unreachable to gc.
    ['GIT_SHALLOW_FILE', ({ file, dir }) => ({ GIT_SHALLOW_FILE: file(`${git(dir, 'rev-parse', 'refs/remotes/origin/ops/review-requests^')}\n`) })],
  ])('inherited %s reaches neither the lane cleanup nor another repo', (_, inherit) => {
    const dir = lane(10);
    const decoy = join(root, 'env-decoy');
    const files = [];
    const file = (text) => { const path = join(root, `env-config-${files.length}`); writeFileSync(path, text); files.push(path); return path; };
    git(root, 'clone', '-q', up, dir);
    git(root, 'clone', '-q', up, decoy);
    const decoyBefore = snapshot(decoy);
    try {
      const out = JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--prune-expire=now', '--apply', '--lanes=10', '--json'], {
        env: { ...env, ...inherit({ decoy, file, dir }) }, encoding: 'utf8',
      }));
      expect(out.rows[0]).toMatchObject({ lane: 10, mode: 'apply' });
      expect(git(dir, 'config', '--get-all', 'remote.origin.fetch').split('\n')).toEqual([LANE_DEFAULT_FETCH, LANE_OPS_NEGATIVE_FETCH]);
      expect(git(dir, 'cat-file', '-p', 'HEAD:a.txt')).toBe('a');
      expect(snapshot(decoy)).toEqual(decoyBefore);
    } finally {
      for (const path of [dir, decoy, ...files]) rmSync(path, { recursive: true, force: true });
    }
  }, 60_000);

  it('an inherited GIT_REF_PARANOIA=0 cannot make gc skip a broken ref, so the commit only it names survives', () => {
    const dir = lane(10);
    git(root, 'clone', '-q', up, dir);
    const side = git(dir, 'commit-tree', git(dir, 'rev-parse', 'HEAD^{tree}'), '-p', 'HEAD', '-m', 'side work');
    writeFileSync(join(dir, '.git', 'refs', 'heads', 'bad..name'), `${side}\n`); // an invalid name git refuses to write
    try {
      execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--prune-expire=now', '--apply', '--lanes=10', '--json'], {
        env: { ...env, GIT_REF_PARANOIA: '0' }, encoding: 'utf8',
      });
      expect(git(dir, 'cat-file', '-t', side)).toBe('commit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('an inherited GIT_CONFIG cannot hide the lane\'s own gc.recentObjectsHook from the check', () => {
    const dir = lane(10);
    const empty = join(root, 'env-empty-config');
    const ran = join(root, 'env-hook-ran');
    git(root, 'clone', '-q', up, dir);
    hook(dir, ran);
    writeFileSync(empty, '');
    try {
      const out = JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--prune-expire=now', '--apply', '--lanes=10', '--json'], {
        env: { ...env, GIT_CONFIG: empty }, encoding: 'utf8',
      }));
      expect(out.rows[0].skipped).toBe('gc.recentObjectsHook configured (gc would run it)');
      expect(existsSync(ran)).toBe(false);
      expect(readFileSync(empty, 'utf8')).toBe('');
    } finally {
      for (const path of [dir, empty, ran]) rmSync(path, { recursive: true, force: true });
    }
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

describe('CLI pools and per-lane failure isolation', () => {
  let root;
  let up;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'lane-diet-pools-'));
    up = join(root, 'up');
    mkdirSync(up);
    git(up, 'init', '-q', '-b', 'main');
    writeFileSync(join(up, 'a.txt'), 'a');
    git(up, 'add', 'a.txt');
    git(up, 'commit', '-qm', 'a');
  }, 60_000);
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const cli = (poolRoot, ...args) => JSON.parse(execFileSync('node', [CLI, `--pool-root=${poolRoot}`, `--scan-root=${root}`, '--json', ...args], { env, encoding: 'utf8' }));

  // One lane per pool, each with its own number, so a `--pool` the CLI ignores lists the wrong lane.
  it('--pool reads only that pool\'s lanes, for every allow-listed pool', () => {
    const poolRoot = join(root, 'pools');
    CLEANUP_POOLS.forEach((pool, i) => git(root, 'clone', '-q', up, join(poolRoot, pool, `lane-${i + 1}`)));
    for (const [i, pool] of CLEANUP_POOLS.entries()) {
      const out = cli(poolRoot, `--pool=${pool}`);
      expect(out).toMatchObject({ mode: 'dry-run', pool });
      expect(out.rows).toEqual([expect.objectContaining({ lane: i + 1, mode: 'dry-run' })]);
    }
    expect(cli(poolRoot).rows).toEqual([expect.objectContaining({ lane: CLEANUP_POOLS.indexOf('web-everything') + 1, mode: 'dry-run' })]);
    expect(spawnSync('node', [CLI, `--pool-root=${poolRoot}`, '--pool=we-drain-daemon'], { env, encoding: 'utf8' }).status).toBe(2);
  }, 60_000);

  it('a lane whose git config cannot be read gets an error row, and the lanes around it are still cleaned', () => {
    const poolRoot = join(root, 'isolation');
    const lane = (n) => join(poolRoot, 'web-everything', `lane-${n}`);
    for (const n of [1, 2, 3]) git(root, 'clone', '-q', up, lane(n));
    writeFileSync(join(lane(2), '.git', 'config'), `${readFileSync(join(lane(2), '.git', 'config'), 'utf8')}[[[\n`);
    for (const mode of [[], ['--prune-expire=now', '--apply', '--lanes=1,2,3']]) {
      const out = cli(poolRoot, ...mode);
      const want = mode.length ? 'apply' : 'dry-run';
      expect(out.rows).toEqual([
        expect.objectContaining({ lane: 1, mode: want }),
        { lane: 2, error: expect.stringMatching(/bad config/) },
        expect.objectContaining({ lane: 3, mode: want }),
      ]);
      expect(existsSync(join(lane(2), '.git', '.lane-lease'))).toBe(false);
    }
  }, 60_000);
});
