// @repo-scanning-test scope=files — every script naming an ops/* ref is a listed by-name reader or a known non-reader.
/**
 * @file lane-git-diet.test.mjs — proof for the lane git diet: the config ops (pure + idempotent), the real-git
 *   semantics it relies on (negative refspec excludes ops/* from a default fetch, but an explicit full refspec
 *   still updates origin/ops/x), and the ops-ref reader inventory (complete, every reader fetches by name).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, mkdirSync, existsSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  LANE_DEFAULT_FETCH, LANE_OPS_NEGATIVE_FETCH, laneDietConfigOps, laneDietConfigState, applyLaneDietConfig, OPS_REF_READERS,
} from '../lane-git-diet.mjs';
import { LANE_CONFIG_LIST_ARGS, scrubGitRepoEnv } from '../lane-git-hardening.mjs';
import { DAEMON_CLONE_SEED } from '../daemon-clone-registry.mjs';
import { acquireWrite, releaseWrite, inspectCloneLock } from '../daemon-clone-lock.mjs';
import { LEASE_FILENAME } from '../lane-lease.mjs';
import { scopedScanFiles } from '../repo-scan-tests.mjs';

const REPO = join(import.meta.dirname, '..', '..', '..');
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
  it('reads all settings in one spawn and applies only the missing ops', () => {
    const calls = [];
    const run = (args) => {
      calls.push(args);
      if (args.includes('--list')) return `local\0remote.origin.fetch\n${LANE_DEFAULT_FETCH}\0`;
      return '';
    };
    expect(applyLaneDietConfig(run)).toHaveLength(3);
    expect(calls).toEqual([[...LANE_CONFIG_LIST_ARGS], ...laneDietConfigOps({ fetchValues: [LANE_DEFAULT_FETCH] })]);
  });
  it.each([1, null, 128])('propagates a listing failure (status %s) before any write', (status) => {
    const writes = [];
    const run = (args) => {
      if (args.includes('--list')) { const e = new Error('read failed'); e.status = status; throw e; }
      writes.push(args);
      return '';
    };
    expect(() => applyLaneDietConfig(run)).toThrow(/read failed/);
    expect(writes).toEqual([]);
  });
  it('reuses a scrub snapshot without spawning another config read', () => {
    const current = { fetchValues: [LANE_DEFAULT_FETCH, LANE_OPS_NEGATIVE_FETCH], kv: { 'fetch.unpackLimit': '1', 'transfer.unpackLimit': '1' } };
    expect(applyLaneDietConfig(() => { throw new Error('unexpected git spawn'); }, current)).toEqual([]);
  });
  it('parses only local origin settings, preserving duplicate values and embedded newlines', () => {
    const entry = (scope, key, value) => `${scope}\0${key}\n${value}\0`;
    const output = entry('global', 'remote.origin.fetch', LANE_OPS_NEGATIVE_FETCH)
      + entry('local', 'remote.Origin.fetch', '+refs/heads/other:refs/remotes/Origin/other')
      + entry('local', 'remote.origin.fetch', LANE_DEFAULT_FETCH)
      + entry('local', 'remote.origin.fetch', LANE_OPS_NEGATIVE_FETCH)
      + entry('worktree', 'remote.origin.fetch', '+refs/heads/work:refs/remotes/origin/work')
      + entry('command', 'remote.origin.fetch', '^refs/heads/private/*')
      + entry('local', 'alias.multiline', 'one\nremote.origin.fetch\nother')
      + entry('local', 'fetch.unpacklimit', '1') + entry('local', 'fetch.unpacklimit', '1')
      + entry('command', 'transfer.unpacklimit', '1');
    const current = laneDietConfigState(output);
    expect(current).toEqual({
      fetchValues: [LANE_DEFAULT_FETCH, LANE_OPS_NEGATIVE_FETCH],
      effectiveFetchValues: [LANE_OPS_NEGATIVE_FETCH, LANE_DEFAULT_FETCH, LANE_OPS_NEGATIVE_FETCH,
        '+refs/heads/work:refs/remotes/origin/work', '^refs/heads/private/*'],
      kv: { 'fetch.unpackLimit': '1\n1', 'transfer.unpackLimit': '' },
    });
    expect(laneDietConfigOps(current)).toEqual([
      ['config', '--local', '--replace-all', 'fetch.unpackLimit', '1'],
      ['config', '--local', '--replace-all', 'transfer.unpackLimit', '1'],
    ]);
  });
  it('includes every effective fetch mapping when preparing a reset proof', () => {
    const entry = (scope, value) => `${scope}\0remote.origin.fetch\n${value}\0`;
    const values = [LANE_DEFAULT_FETCH, LANE_OPS_NEGATIVE_FETCH,
      '+refs/heads/ops/review-requests:refs/remotes/origin/saved', '^refs/heads/saved',
      '+refs/heads/trunk:refs/remotes/origin/trunk'];
    const output = ['local', 'local', 'global', 'worktree', 'command'].map((scope, i) => entry(scope, values[i])).join('');
    expect(laneDietConfigState(output).fetchValues).toEqual(values.slice(0, 2));
    expect(laneDietConfigState(output).effectiveFetchValues).toEqual(values);
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
    'scripts/operations/coroner-pr-postmortem.mjs': 'reads the verdict ledger through the GitHub contents API, not a local tracking ref',
    'scripts/lib/red-main-quarantine.mjs': 'branch-name constant only (pure rules)',
    'scripts/lib/merge-delivery-policy.mjs': 'default branch-name policy value',
    'scripts/lib/daemon-rebuild/wrong-branch-heal.mjs': 'daemon clone CURRENT-branch name check, not a tracking ref',
    'scripts/lib/operation-io-fidelity.mjs': 'message text',
    'scripts/merge-ai-prs.mjs': 'message text',
    'scripts/operations/stage-pr-view.mjs': 'compares provenance against TRANSPORT_REF; the read is the injected stage-pr-view-io reader',
    'scripts/lib/lane-git-diet.mjs': 'this inventory',
    'scripts/lane-git-diet.mjs': 'the one-time cleanup (deletes stale tracking refs)',
    'scripts/lane-pool.mjs': 'drops stale tracking refs after clone',
    'scripts/lib/lane-pool-salvage-push.mjs': 'EXCLUDES ops/* from the salvage fetch and its reachability check (negative refspec / --exclude); never reads it',
    'scripts/conveyor/soak/breaks/lane-reset-symbolic-ops-proof.mjs': 'disposable real-git regression fixture, not a production reader',
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
    const files = scopedScanFiles(walk(join(REPO, 'scripts')).map((abs) => relative(REPO, abs)));
    for (const rel of files) {
      const code = readFileSync(join(REPO, rel), 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      if (OPS_IN_CODE.test(code) && !listed.has(rel)) unlisted.push(rel);
    }
    expect(unlisted).toEqual([]);
  });
});

describe('real git: negative refspec keeps ops/* out of a default fetch', () => {
  let root;
  let up;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'lane-git-diet-'));
    up = join(root, 'up');
    mkdirSync(up);
    git(up, 'init', '-q', '-b', 'main');
    writeFileSync(join(up, 'a.txt'), 'a');
    git(up, 'add', 'a.txt');
    git(up, 'commit', '-qm', 'a');
    git(up, 'update-ref', 'refs/heads/ops/review-requests', 'HEAD');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('a diet lane ignores ops/* on a default fetch, yet an explicit reader fetch still updates origin/ops/x', () => {
    const scratch = join(root, 'diet');
    git(root, 'clone', '-q', up, scratch);
    applyLaneDietConfig((args) => git(scratch, ...args));
    const reads = [];
    expect(applyLaneDietConfig((args) => { reads.push(args); return git(scratch, ...args); })).toEqual([]);
    expect(reads).toEqual([[...LANE_CONFIG_LIST_ARGS]]);
    git(scratch, 'update-ref', '-d', 'refs/remotes/origin/ops/review-requests');
    git(scratch, 'fetch', '-q', '--prune', 'origin');
    expect(refs(scratch).some((r) => r.includes('/ops/'))).toBe(false);
    git(scratch, 'fetch', '-q', 'origin', '+refs/heads/ops/review-requests:refs/remotes/origin/ops/review-requests');
    expect(git(scratch, 'rev-parse', 'origin/ops/review-requests')).toBe(git(up, 'rev-parse', 'ops/review-requests'));
    git(scratch, 'fetch', '-q', '--prune', 'origin'); // a later default --prune does not drop the reader's ref
    expect(refs(scratch)).toContain('refs/remotes/origin/ops/review-requests');
  });
});

describe('CLI daemon-clone mode (registered clones only)', () => {
  const CLI = join(REPO, 'scripts', 'lane-git-diet.mjs');
  const NAME = 'wev-fix-daemon';
  const NESTED_NAME = '.lanes/we-drain-daemon/code';
  // Keep the existing report's rows/projectedBytes vocabulary; daemon rows identify the clone instead of a lane.
  // A plan is an ordered list of git argv arrays, just like laneDietConfigOps above.
  const plan = [['repack', '-A', '-d', '-l', '--unpack-unreachable=never'], ['prune', '--expire=1.hour.ago']];

  const snapshot = (dir) => readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    const stat = statSync(path);
    const entry = { path: name, mode: stat.mode, mtimeMs: stat.mtimeMs };
    return stat.isDirectory()
      ? [entry, ...snapshot(path).map((child) => ({ ...child, path: join(name, child.path) }))]
      : [{ ...entry, bytes: readFileSync(path).toString('hex') }];
  });

  async function fixture(run, name = NAME) {
    const root = mkdtempSync(join(tmpdir(), 'lane-diet-daemon-'));
    const home = join(root, 'home');
    const workspace = join(home, 'workspace');
    const clone = join(workspace, name);
    const lockRoot = join(root, 'clone-locks');
    const traceFile = join(root, 'git.trace');
    const gitConfig = join(root, 'gitconfig');
    mkdirSync(clone, { recursive: true });
    mkdirSync(join(workspace, '.lanes'), { recursive: true });
    mkdirSync(join(root, 'tmp'));
    mkdirSync(join(root, 'overlays'));
    writeFileSync(gitConfig, '');
    const childEnv = {
      ...scrubGitRepoEnv(env), HOME: home, TMPDIR: join(root, 'tmp'),
      GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_SYSTEM: gitConfig, GIT_CONFIG_COUNT: '0',
      WE_DAEMON_CLONE_LOCK_ROOT: lockRoot, WE_DAEMON_OVERLAY_DIR: join(root, 'overlays'),
      LANE_POOL_ROOT: join(workspace, '.lanes'),
    };
    const localGit = (cwd, ...args) => execFileSync('git', args, {
      cwd, env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    }).trim();
    const cli = (selectedName, ...args) => spawnSync(process.execPath,
      [CLI, `--daemon-clone=${selectedName}`, `--scan-root=${workspace}`, '--json', ...args], {
        cwd: workspace, env: { ...childEnv, GIT_TRACE: traceFile },
        encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
      });
    const trace = () => existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '';
    // Observe the existing boundary seam via filesystem events; no test-side polling or real daemon state.
    const runPaused = async (stage, change) => {
      const signals = join(root, 'signals');
      mkdirSync(signals);
      let ready;
      const atBoundary = new Promise((resolve) => { ready = resolve; });
      const watcher = watch(signals, () => { if (existsSync(join(signals, 'ready'))) ready(); });
      let child;
      const done = new Promise((resolve) => {
        child = execFile(process.execPath,
          [CLI, `--daemon-clone=${name}`, `--scan-root=${workspace}`, '--json', '--apply'], {
            cwd: workspace, timeout: 10_000, maxBuffer: 1024 * 1024,
            env: { ...childEnv, GIT_TRACE: traceFile, VITEST: 'true',
              LANE_GIT_DIET_TEST_PAUSE_AT: stage, LANE_GIT_DIET_TEST_PAUSE_DIR: signals },
          }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }));
      });
      try {
        await Promise.race([atBoundary, done.then((result) => {
          throw new Error(`CLI exited before ${stage}: ${result.stderr} ${result.stdout}`);
        })]);
        await change(child);
        writeFileSync(join(signals, 'go'), '');
        return await done;
      } finally {
        watcher.close();
        if (child.exitCode === null) child.kill();
        await done;
      }
    };

    try {
      expect(DAEMON_CLONE_SEED).toContain(name);
      localGit(clone, 'init', '-q', '-b', 'main');
      writeFileSync(join(clone, 'keep.txt'), 'daemon working tree\n');
      localGit(clone, 'add', 'keep.txt');
      localGit(clone, 'commit', '-qm', 'fixture');
      // Preservation sentinels: daemon mode must not inherit lane-only ref deletion/config edits.
      localGit(clone, 'update-ref', 'refs/remotes/origin/ops/daemon-sentinel', 'HEAD');
      localGit(clone, 'config', 'remote.origin.fetch', LANE_DEFAULT_FETCH);
      localGit(clone, 'config', 'fetch.unpackLimit', '73');
      localGit(clone, 'config', 'transfer.unpackLimit', '91');
      await run({ root, workspace, clone, lockRoot, cli, trace, localGit, runPaused });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  it('refuses an unregistered name with exit 2 and a registration diagnostic before any git operation', async () => {
    await fixture(({ cli, trace }) => {
      const result = cli('unregistered-daemon', '--apply');
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/(?:unregistered|not registered|unknown daemon clone).*unregistered-daemon/i);
      expect(trace()).toBe('');
    });
  });

  it.each(['../wev-fix-daemon', 'wev-fix-daemon/child', 'wev-fix-daemon\\child', '/wev-fix-daemon'])
    ('refuses raw or traversing name %s before any git operation', async (name) => {
      await fixture(({ cli, trace }) => {
        const result = cli(name, '--apply');
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(/(?:unregistered|not registered|invalid.*(?:name|daemon)|registered.*name|unknown daemon clone)/i);
        expect(trace()).toBe('');
      });
    });

  it.each(['--lanes=1', '--pool=web-everything', '--pool-root=unused'])
    ('refuses --daemon-clone combined with %s before any git operation', async (flag) => {
      await fixture(({ cli, trace }) => {
        const result = cli(NAME, flag);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(/mutually exclusive|cannot.*(?:combine|with)|may not.*with/i);
        expect(trace()).toBe('');
      });
    });

  it('refuses apply without --lanes when the rebuild write lock is held, before any git operation', async () => {
    await fixture(async ({ clone, lockRoot, cli, trace }) => {
      const owner = 'lane-diet-test-rebuild';
      expect(await acquireWrite(clone, { lockRoot, owner, waitMs: 0 })).toMatchObject({ ok: true });
      try {
        const before = snapshot(clone);
        const result = cli(NAME, '--apply');
        expect(result.error).toBeUndefined(); // A timeout/wait loop is not an acceptable refusal.
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toMatch(/concurrent-mover|(?:rebuild|write|clone).*lock.*(?:held|busy|active)|lock.*(?:held|busy|active)/i);
        expect(trace()).toBe('');
        expect(snapshot(clone)).toEqual(before);
        expect(inspectCloneLock(clone, { lockRoot }).writer).toMatchObject({ owner });
      } finally { releaseWrite(clone, { lockRoot, owner }); }
    });
  });

  it.each([NAME, NESTED_NAME])('reports a dry-run JSON plan and bytes for registered clone %s without modifying it', async (name) => {
    await fixture(({ clone, cli, lockRoot }) => {
      const before = snapshot(clone);
      const beforeBytes = Number(execFileSync('du', ['-sk', join(clone, '.git', 'objects')], { encoding: 'utf8' }).split(/\s+/)[0]) * 1024;
      const result = cli(name);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.mode).toBe('dry-run');
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]).toMatchObject({ clone: name, mode: 'dry-run', beforeBytes, plan });
      expect(Number.isFinite(report.rows[0].projectedBytes)).toBe(true);
      expect(report.rows[0].projectedBytes).toBeGreaterThanOrEqual(0);
      expect(report.rows[0].skipped).toBeUndefined();
      expect(report.rows[0].error).toBeUndefined();
      expect(snapshot(clone)).toEqual(before);
      expect(inspectCloneLock(clone, { lockRoot }).writer).toBeNull();
    }, name);
  });

  it('refuses apply when another repository borrows the registered clone objects through alternates', async () => {
    await fixture(({ workspace, clone, cli, trace, localGit }) => {
      const borrower = join(workspace, 'borrower');
      mkdirSync(borrower);
      localGit(borrower, 'init', '-q', '-b', 'main');
      writeFileSync(join(borrower, '.git', 'objects', 'info', 'alternates'), `${join(clone, '.git', 'objects')}\n`);
      const before = snapshot(clone);
      const borrowerBefore = snapshot(borrower);
      const result = cli(NAME, '--apply');
      expect(result.error).toBeUndefined();
      expect([0, 1]).toContain(result.status); // Existing lane safety refusals are reported as skipped rows.
      const report = JSON.parse(result.stdout);
      expect(report.rows).toHaveLength(1);
      expect(report.rows[0]).toMatchObject({ clone: NAME, skipped: expect.stringMatching(/borrow/i) });
      expect(trace()).not.toMatch(/\b(?:repack|prune|update-ref)\b|\bconfig\b.*--(?:add|replace-all|unset|local\s+\S+\s+\S+)/);
      expect(snapshot(clone)).toEqual(before);
      expect(snapshot(borrower)).toEqual(borrowerBefore);
    });
  });

  const boundaries = [['before-gc', 'repack'], ['before-prune', 'prune']];
  const maintenanceCommands = (trace) => trace.split('\n').filter((line) => /built-in: git (?:repack|prune)\b/.test(line));
  const expectRefusedAt = (result, trace, command, reason) => {
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout).rows[0]).toMatchObject({ clone: NAME, skipped: expect.stringMatching(reason) });
    const commands = maintenanceCommands(trace);
    expect(commands.some((line) => line.includes(`git ${command}`))).toBe(false);
    expect(commands.filter((line) => line.includes('git repack'))).toHaveLength(command === 'prune' ? 1 : 0);
    expect(commands.some((line) => line.includes('git prune'))).toBe(false);
  };

  it.each(boundaries)('holds the rebuild write lock at %s through completion', async (stage) => {
    await fixture(async ({ clone, lockRoot, runPaused, trace }) => {
      const result = await runPaused(stage, async (child) => {
        expect(inspectCloneLock(clone, { lockRoot })).toMatchObject({ writerLive: true, writer: { pid: child.pid } });
        expect(await acquireWrite(clone, { lockRoot, owner: 'competing-rebuild', waitMs: 0 })).toMatchObject({ ok: false });
      });
      expect(result.status, result.stderr).toBe(0);
      expect(maintenanceCommands(trace())).toHaveLength(2);
      expect(inspectCloneLock(clone, { lockRoot }).writer).toBeNull();
    });
  });

  it.each(boundaries)('refuses after rebuild lock loss at %s without executing %s or releasing the replacement lock', async (stage, command) => {
    await fixture(async ({ clone, lockRoot, runPaused, trace }) => {
      const owner = 'replacement-rebuild';
      try {
        const result = await runPaused(stage, async () => {
          const writer = inspectCloneLock(clone, { lockRoot }).writer;
          expect(writer).not.toBeNull();
          releaseWrite(clone, { lockRoot, owner: writer.owner });
          expect(await acquireWrite(clone, { lockRoot, owner, waitMs: 0 })).toMatchObject({ ok: true });
        });
        expectRefusedAt(result, trace(), command, /write lock lost|expired/i);
        expect(inspectCloneLock(clone, { lockRoot }).writer).toMatchObject({ owner });
      } finally { releaseWrite(clone, { lockRoot, owner }); }
    });
  });

  const safetyChanges = [
    ['Git lock', /git lock present/, ({ clone }) => writeFileSync(join(clone, '.git', 'index.lock'), '')],
    ['GC pid', /git lock present/, ({ clone }) => writeFileSync(join(clone, '.git', 'gc.pid'), '123')],
    ['in-flight merge', /git lock present/, ({ clone, localGit }) => writeFileSync(join(clone, '.git', 'MERGE_HEAD'), localGit(clone, 'rev-parse', 'HEAD'))],
    ['recent objects hook', /recentObjectsHook/, ({ clone, localGit }) => localGit(clone, 'config', 'gc.recentObjectsHook', 'false')],
    ['repack filtering', /repack filtering/, ({ clone, localGit }) => localGit(clone, 'config', 'gc.repackFilter', 'blob:none')],
    ['per-ref reflog expiry', /per-ref reflog expiry/, ({ clone, localGit }) => localGit(clone, 'config', 'gc.refs/heads/*.reflogExpire', 'now')],
    ['config hook', /config-defined hooks/, ({ clone, localGit }) => localGit(clone, 'config', 'hook.diet.command', 'false')],
    ['unexpected lease', /lease/, ({ clone }) => writeFileSync(join(clone, '.git', LEASE_FILENAME), '{}')],
    ['new borrower', /objects borrowed/, ({ workspace, clone, localGit }) => {
      const borrower = join(workspace, 'late-borrower');
      mkdirSync(borrower);
      localGit(borrower, 'init', '-q', '-b', 'main');
      writeFileSync(join(borrower, '.git', 'objects', 'info', 'alternates'), `${join(clone, '.git', 'objects')}\n`);
    }],
  ];
  it.each(boundaries.flatMap(([stage, command]) => safetyChanges.map(([label, reason, change]) =>
    [label, stage, command, reason, change])))
    ('refuses changed %s at %s without executing %s', async (_label, stage, command, reason, change) => {
      await fixture(async (context) => {
        const result = await context.runPaused(stage, () => change(context));
        expectRefusedAt(result, context.trace(), command, reason);
        expect(inspectCloneLock(context.clone, { lockRoot: context.lockRoot }).writer).toBeNull();
      });
    });

  it('applies repack and prune while preserving every ref, reflog, config byte and working-tree file', async () => {
    await fixture(({ clone, cli, trace, localGit, lockRoot }) => {
      const beforeRefs = localGit(clone, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)');
      const beforeConfig = readFileSync(join(clone, '.git', 'config'));
      const beforeLogs = snapshot(join(clone, '.git', 'logs'));
      const beforeHead = readFileSync(join(clone, '.git', 'HEAD'));
      const beforeIndex = readFileSync(join(clone, '.git', 'index'));
      const beforeWorktree = readFileSync(join(clone, 'keep.txt'));
      const result = cli(NAME, '--apply');
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).rows[0]).toMatchObject({ clone: NAME, mode: 'apply', plan });
      expect(maintenanceCommands(trace())).toHaveLength(2);
      expect(trace()).not.toMatch(/built-in: git update-ref/);
      expect(localGit(clone, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)')).toBe(beforeRefs);
      expect(readFileSync(join(clone, '.git', 'config'))).toEqual(beforeConfig);
      expect(snapshot(join(clone, '.git', 'logs'))).toEqual(beforeLogs);
      expect(readFileSync(join(clone, '.git', 'HEAD'))).toEqual(beforeHead);
      expect(readFileSync(join(clone, '.git', 'index'))).toEqual(beforeIndex);
      expect(readFileSync(join(clone, 'keep.txt'))).toEqual(beforeWorktree);
      expect(inspectCloneLock(clone, { lockRoot }).writer).toBeNull();
    });
  });

});
