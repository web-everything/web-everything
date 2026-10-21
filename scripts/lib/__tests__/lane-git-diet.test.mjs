/**
 * @file lane-git-diet.test.mjs — proof for the lane git diet: the config ops (pure + idempotent), the real-git
 *   semantics it relies on (negative refspec excludes ops/* from a default fetch, but an explicit full refspec
 *   still updates origin/ops/x), the ops-ref reader inventory (complete, every reader fetches by name), and the
 *   cleanup CLI (dry-run changes nothing; apply skips leased lanes, keeps the working tree, frees the blobs).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  LANE_DEFAULT_FETCH, LANE_OPS_NEGATIVE_FETCH, laneDietConfigOps, applyLaneDietConfig, cleanupEligibility,
  OPS_REF_READERS, parseCountObjects, projectedFreedBytes,
} from '../lane-git-diet.mjs';

const REPO = join(import.meta.dirname, '..', '..', '..');
const CLI = join(REPO, 'scripts', 'lane-git-diet.mjs');
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.LANE_SESSION;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const refs = (cwd, prefix = 'refs/remotes/origin/') => git(cwd, 'for-each-ref', '--format=%(refname)', prefix).split('\n').filter(Boolean);

describe('laneDietConfigOps (pure)', () => {
  it('adds the negative refspec and both unpack limits to a stock clone', () => {
    expect(laneDietConfigOps({ fetchValues: [LANE_DEFAULT_FETCH], kv: {} })).toEqual([
      ['config', '--local', '--add', 'remote.origin.fetch', LANE_OPS_NEGATIVE_FETCH],
      ['config', '--local', '--replace-all', 'fetch.unpackLimit', '1'],
      ['config', '--local', '--replace-all', 'transfer.unpackLimit', '1'],
    ]);
  });
  it('is idempotent: a diet lane needs nothing', () => {
    expect(laneDietConfigOps({ fetchValues: [LANE_DEFAULT_FETCH, LANE_OPS_NEGATIVE_FETCH], kv: { 'fetch.unpackLimit': '1', 'transfer.unpackLimit': '1' } })).toEqual([]);
  });
  it('never leaves a negative refspec alone: restores the default positive one when none exists', () => {
    const ops = laneDietConfigOps({ fetchValues: [], kv: {} });
    expect(ops[0]).toEqual(['config', '--local', '--add', 'remote.origin.fetch', LANE_DEFAULT_FETCH]);
  });
  it('keeps a custom positive refspec and does not add the default beside it', () => {
    const ops = laneDietConfigOps({ fetchValues: ['+refs/heads/main:refs/remotes/origin/main'], kv: {} });
    expect(ops.some((o) => o.includes(LANE_DEFAULT_FETCH))).toBe(false);
  });
  it('applyLaneDietConfig reads unset keys as unset (git exit 1) and applies only the missing ops', () => {
    const calls = [];
    const run = (args) => {
      calls.push(args);
      if (args[3] === 'remote.origin.fetch') return `${LANE_DEFAULT_FETCH}\n`;
      if (args[2] === '--get-all') { const e = new Error('exit 1'); e.status = 1; throw e; }
      return '';
    };
    expect(applyLaneDietConfig(run)).toHaveLength(3);
  });
  it('applyLaneDietConfig propagates a non-"unset" read failure instead of re-adding refspecs', () => {
    const writes = [];
    const run = (args) => {
      if (args.includes('--get-all')) { const e = new Error('timed out'); e.status = null; throw e; }
      writes.push(args);
      return '';
    };
    expect(() => applyLaneDietConfig(run)).toThrow(/timed out/);
    expect(writes).toEqual([]);
  });
});

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

describe('ops-ref reader inventory', () => {
  const EXPLICIT = /trackingRefspec\(|\+refs\/heads\/\$\{[^}]+\}:refs\/remotes\/|readFromTransportBranch|red-main-freeze-shared\.mjs/;
  it('every listed reader fetches its ops ref explicitly by name (or delegates to one that does)', () => {
    for (const r of OPS_REF_READERS) {
      const src = readFileSync(join(REPO, r.file), 'utf8');
      expect({ file: r.file, explicit: EXPLICIT.test(src) }).toEqual({ file: r.file, explicit: true });
    }
  });
  // Files that name an ops/* branch in code but never READ its tracking ref in a checkout.
  const NON_READERS = {
    'scripts/collect-review-requests.mjs': 'request DIRECTORY name inside the branch tree (CI job)',
    'scripts/operations/record-verdict.mjs': 'request file path inside the branch tree',
    'scripts/lib/red-main-quarantine.mjs': 'branch-name constant only (pure rules)',
    'scripts/lib/merge-delivery-policy.mjs': 'default branch-name policy value',
    'scripts/lib/daemon-rebuild/wrong-branch-heal.mjs': 'daemon clone CURRENT-branch name check, not a tracking ref',
    'scripts/lib/operation-io-fidelity.mjs': 'message text',
    'scripts/merge-ai-prs.mjs': 'message text',
    'scripts/operations/stage-pr-view.mjs': 'compares provenance against TRANSPORT_REF; the read is the injected stage-pr-view-io reader',
    'scripts/lane-git-diet.mjs': 'the cleanup itself (deletes stale tracking refs)',
    'scripts/lib/lane-git-diet.mjs': 'this inventory',
    'scripts/lane-pool.mjs': 'drops stale tracking refs after clone',
  };
  const OPS_IN_CODE = /['"`](?:refs\/remotes\/origin\/)?ops\/|origin\/ops\/|\b(?:TRANSPORT_BRANCH|LEDGER_TRANSPORT_BRANCH|PRECEDENT_TRANSPORT_BRANCH|QUARANTINE_BRANCH|HANDOFF_BRANCH|redMainFreezeBranch|TRANSPORT_REF)\b/;
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === 'node_modules' || n === '__tests__') return [];
    return statSync(p).isDirectory() ? walk(p) : (n.endsWith('.mjs') && !n.includes('.test.') ? [p] : []);
  });
  it('is complete: every script naming an ops/* ref in code is a listed reader or a known non-reader', () => {
    const listed = new Set([...OPS_REF_READERS.map((r) => r.file), ...Object.keys(NON_READERS)]);
    const unlisted = [];
    for (const abs of walk(join(REPO, 'scripts'))) {
      const code = readFileSync(abs, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      const rel = relative(REPO, abs);
      if (OPS_IN_CODE.test(code) && !listed.has(rel)) unlisted.push(rel);
    }
    expect(unlisted).toEqual([]);
  });
});

describe('real git: negative refspec + explicit reader fetch + cleanup CLI', () => {
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

  it('a diet lane ignores ops/* on a default fetch, yet an explicit reader fetch still updates origin/ops/x', () => {
    const scratch = join(root, 'diet');
    git(root, 'clone', '-q', up, scratch);
    applyLaneDietConfig((args) => git(scratch, ...args));
    git(scratch, 'update-ref', '-d', 'refs/remotes/origin/ops/review-requests');
    git(scratch, 'fetch', '-q', '--prune', 'origin');
    expect(refs(scratch).some((r) => r.includes('/ops/'))).toBe(false);
    git(scratch, 'fetch', '-q', 'origin', '+refs/heads/ops/review-requests:refs/remotes/origin/ops/review-requests');
    expect(git(scratch, 'rev-parse', 'origin/ops/review-requests')).toBe(git(up, 'rev-parse', 'ops/review-requests'));
    git(scratch, 'fetch', '-q', '--prune', 'origin'); // a later default --prune does not drop the reader's ref
    expect(refs(scratch)).toContain('refs/remotes/origin/ops/review-requests');
  });

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
});
