/**
 * @file verdict-ledger-outbox.test.mjs - the ledger OUTBOX + PLUMBING flush (live 2026-10-21: 3+ same-host writers
 *   raced 9-second worktree pushes to `ops/review-requests`, the losers exhausted 5 short retries and referral holds
 *   and rulings never persisted, #5502 #5530 #5773 #5742 #5768).
 *
 * The append writes its rows to a host-local outbox first, then ONE writer at a time (a host-wide flusher lock)
 * pushes everything queued as ONE plumbing commit. These tests pin the invariants: every row lands exactly once,
 * a crash between push and delete never duplicates, an off-host (CI) writer's push is retried on the new tip,
 * nothing is ever forced, and a failure still surfaces.
 */
import { describe, it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  appendLedgerRows, ledgerGitPath, readLedgerFromGit, LedgerAppendExhaustedError, LEDGER_TRANSPORT_BRANCH,
} from '../verdict-ledger-io.mjs';
import {
  flushLedgerOutbox, listOutboxEntries, outboxLockRoot, OUTBOX_LOCK_PATH, resolveOutboxSettings, formatOutboxSettings,
  OUTBOX_ENV, OUTBOX_DIR_ENV, enqueueOutboxEntry, spawnBoardLedgerOutboxFlush, spawnLedgerOutboxBackstop,
  resetLedgerOutboxBackstopThrottle, classifyPushFailure, canonicalRemote,
} from '../verdict-ledger-outbox.mjs';
import { withGitErrorForTest } from '../git-transport-branch.mjs';
import { reserve, makeLockEntry } from '../../readiness/file-locks.mjs';
import { buildVerdictRecord, checkLedgerAppendRows } from '../verdict-ledger.mjs';
import { withBareOrigin, git, writeLocalIdentity } from '../../operations/__tests__/helpers/real-repo.mjs';

const REPO = 'web-everything/web-everything';
const IO_MODULE = join(dirname(fileURLToPath(import.meta.url)), '..', 'verdict-ledger-io.mjs');
const row = (pr) => buildVerdictRecord({ repo: REPO, pr, verdict: 'accepted', at: '2026-10-21T12:00:00.000Z', source: 'test' });
const noSleep = () => {};
const quiet = () => {};

const cloneOf = (ctx, name) => {
  const dir = join(ctx.tmp, name);
  git(['clone', '--quiet', ctx.origin, dir], { cwd: ctx.tmp });
  writeLocalIdentity(dir);
  return dir;
};
const originRows = (ctx) => ctx.showOnOrigin(LEDGER_TRANSPORT_BRANCH, ledgerGitPath(REPO)).trim().split('\n').filter(Boolean)
  .map((l) => JSON.parse(l).pr);
const originCommits = (ctx) => Number(git(['rev-list', '--count', LEDGER_TRANSPORT_BRANCH], { cwd: ctx.origin }).trim());
const realGit = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...opts });

describe('outbox settings: a cascade, logged with its source', () => {
  it('defaults on, with a time budget and a stale age, sources named', () => {
    const s = resolveOutboxSettings({ repo: {}, env: {} });
    expect(s.enabled).toBe(true);
    expect(s.flushBudgetMs).toBeGreaterThan(10_000);
    expect(s.staleMs).toBeGreaterThan(s.flushBudgetMs);
    expect(s.sources).toEqual({ enabled: 'standard', flushBudgetMs: 'standard', staleMs: 'standard' });
  });

  it('is OFF in CI (an ephemeral runner would lose its outbox) unless the env forces it', () => {
    expect(resolveOutboxSettings({ repo: {}, env: { GITHUB_ACTIONS: 'true' } })).toMatchObject({ enabled: false, sources: { enabled: 'ci' } });
    expect(resolveOutboxSettings({ repo: {}, env: { GITHUB_ACTIONS: 'true', [OUTBOX_ENV]: '1' } })).toMatchObject({ enabled: true, sources: { enabled: 'env' } });
  });

  it('repo overrides standard, env overrides repo, invalid layers are ignored and named', () => {
    const s = resolveOutboxSettings({ repo: { verdictLedger: { outbox: false, flushBudgetMs: 30_000, outboxStaleMs: 'x' } }, env: {} });
    expect(s).toMatchObject({ enabled: false, flushBudgetMs: 30_000, sources: { enabled: 'repo', flushBudgetMs: 'repo', staleMs: 'standard' } });
    expect(s.invalid).toEqual(['repo.verdictLedger.outboxStaleMs']);
    expect(formatOutboxSettings(s)).toMatch(/verdictLedger\.flushBudgetMs=30000 \(repo\)/);
  });
});

describe('withGitError keeps the push rejection, not only the last error line', () => {
  it('a rejected push names [rejected] and the remote: lines in its message', () => {
    const run = () => {
      const e = new Error('Command failed');
      e.stderr = 'To github.com:x/y.git\n ! [rejected]        HEAD -> ops/review-requests (fetch first)\n'
        + 'remote: something the remote said\nerror: failed to push some refs to \'github.com:x/y.git\'\n';
      e.status = 1;
      throw e;
    };
    let err;
    try { withGitErrorForTest(run)(['push', 'origin', 'x'], {}); } catch (e) { err = e; }
    expect(err.message).toMatch(/\[rejected\].*fetch first/);
    expect(err.message).toMatch(/remote: something the remote said/);
    expect(err.message).toMatch(/failed to push some refs/);
  });
});

describe('real git: outbox + plumbing flush', () => {
  it('a single append lands as ONE plumbing commit: no worktree, no local branch moved, never forced', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      const calls = [];
      const run = (args, opts) => { calls.push(args); return realGit(args, opts); };
      const before = originCommits(ctx);
      const r = appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(1), row(2)], outbox: true, outboxDir, gitRun: run, log: quiet });
      expect(r).toMatchObject({ status: 'appended', rows: 2, duplicates: 0, queued: false });
      expect(originRows(ctx)).toEqual([1, 2]);
      expect(originCommits(ctx)).toBe(before + 1);
      expect(calls.some((a) => a[0] === 'worktree')).toBe(false);
      expect(calls.some((a) => a[0] === 'checkout' || a[0] === 'update-ref' || a[0] === 'branch')).toBe(false);
      const pushes = calls.filter((a) => a[0] === 'push');
      expect(pushes).toHaveLength(1);
      expect(pushes[0].at(-1)).toMatch(/^[0-9a-f]{40}:refs\/heads\/ops\/review-requests$/);
      for (const a of pushes.flat()) expect(a).not.toMatch(/^(-f|--force.*|\+.*)$/);
      expect(git(['for-each-ref', 'refs/heads/'], { cwd: ctx.clone })).not.toMatch(/ops\/review-requests/);
      expect(listOutboxEntries(outboxDir)).toEqual([]);
      expect(existsSync(join(ctx.clone, '.operations', 'transport'))).toBe(false);
    });
  });

  it('CONCURRENT APPENDERS (6 processes, 2 boards) all land, each row exactly once', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const boards = [ctx.clone, cloneOf(ctx, 'board-b')];
      const outboxDir = join(ctx.tmp, 'outbox');
      const script = join(ctx.tmp, 'append-one.mjs');
      writeFileSync(script, `
        import { appendLedgerRows } from ${JSON.stringify(pathToFileURL(IO_MODULE).href)};
        import { buildVerdictRecord } from ${JSON.stringify(pathToFileURL(resolve(IO_MODULE, '..', 'verdict-ledger.mjs')).href)};
        const [board, pr, outboxDir] = process.argv.slice(2);
        const rec = buildVerdictRecord({ repo: ${JSON.stringify(REPO)}, pr: Number(pr), verdict: 'accepted', at: '2026-10-21T12:00:00.000Z', source: 'test' });
        const r = appendLedgerRows({ board, repo: ${JSON.stringify(REPO)}, records: [rec], outbox: true, outboxDir, log: () => {} });
        process.stdout.write(JSON.stringify(r));
      `);
      const runChild = (board, pr) => new Promise((done) => {
        const child = spawn(process.execPath, [script, board, String(pr), outboxDir], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = ''; let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => done({ code, out, err }));
      });
      const prs = [11, 12, 13, 14, 15, 16];
      const results = await Promise.all(prs.map((pr, i) => runChild(boards[i % 2], pr)));
      for (const r of results) expect(r.code, r.err).toBe(0);
      // Whatever a lock-loser queued, the flusher's post-release recheck pushed before it exited.
      expect(listOutboxEntries(outboxDir)).toEqual([]);
      expect(originRows(ctx).sort((a, b) => a - b)).toEqual(prs);
      const third = cloneOf(ctx, 'third');
      expect(readLedgerFromGit({ board: third, repo: REPO, log: quiet }).records.map((x) => x.pr).sort((a, b) => a - b)).toEqual(prs);
    });
  }, 60_000);

  it('CRASH AFTER PUSH, BEFORE DELETE: the next flush pushes nothing and the row stays single', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      // The crash: a queued entry is pushed, then cannot be removed (a process killed there leaves the same disk
      // state). The row IS recorded, so the flush reports it; the entry stays behind.
      enqueueOutboxEntry(outboxDir, { path: ledgerGitPath(REPO), repo: REPO, message: 'm', ...checkLedgerAppendRows([row(7)], REPO) });
      const crash = () => { throw new Error('simulated crash after push'); };
      const first = flushLedgerOutbox({ board: ctx.clone, dir: outboxDir, log: quiet, removeEntry: crash });
      expect(first).toMatchObject({ ok: true, flushed: 1, pushed: true });
      expect(originRows(ctx)).toEqual([7]);
      expect(listOutboxEntries(outboxDir)).toHaveLength(1);
      const commits = originCommits(ctx);
      const pushes = [];
      const run = (args, opts) => { if (args[0] === 'push') pushes.push(args); return realGit(args, opts); };
      const f = flushLedgerOutbox({ board: ctx.clone, dir: outboxDir, run, log: quiet });
      expect(f).toMatchObject({ ok: true, flushed: 1, pushed: false });
      expect(pushes).toEqual([]);
      expect(originRows(ctx)).toEqual([7]);
      expect(originCommits(ctx)).toBe(commits);
      expect(listOutboxEntries(outboxDir)).toEqual([]);
    });
  });

  it('CI COLLISION: an off-host writer lands first, the push is rejected, refetched and retried on the new tip', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const ci = cloneOf(ctx, 'ci-runner');
      const outboxDir = join(ctx.tmp, 'outbox');
      let rivalDone = false;
      let rejected = 0;
      const run = (args, opts) => {
        if (args[0] === 'push' && !rivalDone) {
          rivalDone = true;
          // The CI applier's own (direct, non-outbox) append lands between our fetch and our push.
          appendLedgerRows({ board: ci, repo: REPO, records: [row(100)], outbox: false, sleep: noSleep });
        }
        try { return realGit(args, opts); } catch (e) { if (args[0] === 'push') rejected += 1; throw e; }
      };
      const retries = [];
      const logs = [];
      const r = appendLedgerRows({
        board: ctx.clone, repo: REPO, records: [row(200)], outbox: true, outboxDir, gitRun: run, sleep: noSleep,
        onRetry: (x) => retries.push(x), log: (l) => logs.push(l),
      });
      expect(rejected).toBe(1);
      expect(retries).toHaveLength(1);
      expect(String(retries[0].error.message)).toMatch(/\[rejected\]/);
      expect(r).toMatchObject({ status: 'appended', rows: 1, attempts: 2 });
      expect(originRows(ctx).sort((a, b) => a - b)).toEqual([100, 200]);
    });
  });

  it('a held flusher lock QUEUES the rows (durable) and returns; the holder flushes them later', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      const lockRoot = outboxLockRoot(outboxDir);
      mkdirSync(lockRoot, { recursive: true });
      const now = Date.now();
      // A LIVE holder: this very process's pid, a different owner string, a fresh heartbeat.
      expect(reserve(lockRoot, OUTBOX_LOCK_PATH, 'someone-else', now, new Date(now).toISOString(), process.pid).ok).toBe(true);
      const pushes = [];
      const run = (args, opts) => { if (args[0] === 'push') pushes.push(args); return realGit(args, opts); };
      const r = appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(3)], outbox: true, outboxDir, gitRun: run, log: quiet });
      expect(r).toMatchObject({ status: 'appended', queued: true, rows: 1 });
      expect(pushes).toEqual([]);
      expect(listOutboxEntries(outboxDir)).toHaveLength(1);
      // The holder (here: released, then the backstop) flushes what was queued.
      execFileSync('rm', ['-rf', lockRoot]);
      expect(flushLedgerOutbox({ board: ctx.clone, dir: outboxDir, log: quiet })).toMatchObject({ ok: true, flushed: 1, pushed: true });
      expect(originRows(ctx)).toEqual([3]);
    });
  });

  it('a STALE outbox behind a held lock surfaces as a write miss and does not enqueue', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      const lockRoot = outboxLockRoot(outboxDir);
      mkdirSync(lockRoot, { recursive: true });
      const now = Date.now();
      expect(reserve(lockRoot, OUTBOX_LOCK_PATH, 'wedged', now, new Date(now).toISOString(), process.pid).ok).toBe(true);
      // An entry left by a writer 20 minutes ago that nobody has managed to flush.
      appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(4)], outbox: true, outboxDir, log: quiet, now: () => now - 20 * 60_000 });
      expect(listOutboxEntries(outboxDir)).toHaveLength(1);
      const logs = [];
      expect(() => appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(5)], outbox: true, outboxDir, log: (l) => logs.push(l), env: {} }))
        .toThrow(LedgerAppendExhaustedError);
      expect(logs.join('\n')).toMatch(/ledger-write-miss: verdict-ledger outbox .* oldest/);
      expect(listOutboxEntries(outboxDir)).toHaveLength(1);
    });
  });

  it('an unreachable transport, lock held from before the entry: withdrawn and thrown (thrown means not recorded)', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      git(['remote', 'set-url', 'origin', join(ctx.tmp, 'does-not-exist.git')], { cwd: ctx.clone });
      const outboxDir = join(ctx.tmp, 'outbox');
      expect(() => appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(1)], outbox: true, outboxDir, log: quiet, sleep: noSleep }))
        .toThrow(LedgerAppendExhaustedError);
      expect(listOutboxEntries(outboxDir)).toEqual([]);
    });
  });

  it('an UNKNOWN push outcome (no answer, not on the remote yet) is never withdrawn: the row stays queued, then lands once', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      let hang = true;
      const run = (args, opts) => {
        if (args[0] === 'push' && hang) { hang = false; const e = new Error('Command failed'); e.stderr = 'fatal: the remote end hung up unexpectedly\n'; e.status = 128; throw e; }
        return realGit(args, opts);
      };
      const logs = [];
      const r = appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(5)], outbox: true, outboxDir, gitRun: run, log: (l) => logs.push(l) });
      expect(r).toMatchObject({ status: 'appended', queued: true });
      expect(logs.join('\n')).toMatch(/push outcome UNKNOWN/);
      // Not withdrawn: the post-release re-check (the remote answers again) lands it, exactly once.
      expect(listOutboxEntries(outboxDir)).toEqual([]);
      expect(originRows(ctx)).toEqual([5]);
      expect(flushLedgerOutbox({ board: ctx.clone, dir: outboxDir, log: quiet })).toMatchObject({ ok: true, flushed: 0 });
      expect(originRows(ctx)).toEqual([5]);
    });
  });

  it('lock won at once: the rows ride the flush in memory and are NEVER written to the outbox', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      let seenDuringPush = null;
      const run = (args, opts) => { if (args[0] === 'push') seenDuringPush = listOutboxEntries(outboxDir).length; return realGit(args, opts); };
      const r = appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(8)], outbox: true, outboxDir, gitRun: run, log: quiet });
      expect(r).toMatchObject({ queued: false, rows: 1 });
      expect(seenDuringPush).toBe(0);
    });
  });

  it('a REFUSED push (remote rejected) with the lock won throws, and nothing was ever queued', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      const run = (args, opts) => {
        if (args[0] === 'push') { const e = new Error('Command failed'); e.stdout = `To o\n!\tx:refs/heads/ops/review-requests\t[remote rejected] (pre-receive hook declined)\nDone\n`; e.stderr = 'error: failed to push some refs\n'; e.status = 1; throw e; }
        return realGit(args, opts);
      };
      expect(() => appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(9)], outbox: true, outboxDir, gitRun: run, log: quiet }))
        .toThrow(LedgerAppendExhaustedError);
      expect(listOutboxEntries(outboxDir)).toEqual([]);
    });
  });

  it('the direct path: an earlier unanswered push keeps the failure INDETERMINATE even when later attempts fail to fetch', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      let n = 0;
      const run = (args, opts) => {
        if (args[0] === 'push') { const e = new Error('Command failed'); e.stderr = 'fatal: the remote end hung up unexpectedly\n'; e.status = 128; throw e; }
        if (args[0] === 'fetch' && ++n > 2) { const e = new Error('Command failed'); e.stderr = 'fatal: unable to access remote\n'; e.status = 128; throw e; }
        return realGit(args, opts);
      };
      let err;
      try { appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(10)], outbox: false, run, attempts: 2, sleep: noSleep }); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(LedgerAppendExhaustedError);
      expect(err.indeterminate).toBe(true);
      expect(err.message).toMatch(/outcome UNKNOWN/);
    });
  });

  it('a backstop flusher that fails to start later is logged, never an unhandled error', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ob-')), 'outbox');
    enqueueOutboxEntry(dir, { path: ledgerGitPath(REPO), repo: REPO, message: 'm', ...checkLedgerAppendRows([row(11)], REPO) });
    const handlers = {};
    const spawnFn = () => ({ pid: 1, on: (ev, fn) => { handlers[ev] = fn; }, unref() {} });
    const logs = [];
    const r = spawnBoardLedgerOutboxFlush({ board: '/nowhere', env: { [OUTBOX_DIR_ENV]: dir }, spawnFn, log: (l) => logs.push(l) });
    expect(r).toMatchObject({ spawned: true });
    expect(typeof handlers.error).toBe('function');
    handlers.error(new Error('spawn EAGAIN'));
    expect(logs.join('\n')).toMatch(/ledger-write-miss: .*failed to start \(spawn EAGAIN\)/);
  });

  it('only git\'s per-ref status line classifies a failed push; incidental text proves nothing (round 4)', () => {
    const REF = 'refs/heads/ops/review-requests';
    const err = (stdout, stderr = '') => Object.assign(new Error(`git push failed: ${stderr}`), { stdout, stderr });
    expect(classifyPushFailure(err(`To o\n!\tabc:${REF}\t[rejected] (fetch first)\nDone\n`), REF)).toBe('race');
    expect(classifyPushFailure(err(`To o\n!\tabc:${REF}\t[remote rejected] (pre-receive hook declined)\nDone\n`), REF)).toBe('refused');
    // Status-SHAPED prose on stderr, or a record for ANOTHER ref, proves nothing about ours.
    expect(classifyPushFailure(err('', 'remote: notice: ! [remote rejected] diagnostic -> another-ref (hook declined)\nfatal: the remote end hung up unexpectedly\n'), REF)).toBe('unknown');
    expect(classifyPushFailure(err(`!\tabc:refs/heads/other\t[rejected] (fetch first)\n`), REF)).toBe('unknown');
    expect(classifyPushFailure(err('', 'fatal: unable to access remote\n'), REF)).toBe('unknown');
    // One identity per remote, however it is spelled.
    expect(canonicalRemote('https://github.com/Web-Everything/web-everything.git')).toBe(canonicalRemote('git@github.com:web-everything/web-everything'));
    expect(canonicalRemote('ssh://git@github.com:22/web-everything/web-everything/')).toBe(canonicalRemote('https://github.com/web-everything/web-everything'));
  });

  it('an unanswered push whose noise mentions "cannot lock ref" is still UNKNOWN: kept queued, never thrown', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      let first = true;
      const run = (args, opts) => {
        if (args[0] === 'push' && first) { first = false; const e = new Error('Command failed'); e.stderr = 'remote: error: cannot lock ref x\nfatal: the remote end hung up unexpectedly\n'; e.status = 128; throw e; }
        if (args[0] === 'fetch' && !first) { const e = new Error('Command failed'); e.stderr = 'fatal: unable to access remote\n'; e.status = 128; throw e; }
        return realGit(args, opts);
      };
      const r = appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(12)], outbox: true, outboxDir, gitRun: run, log: quiet });
      expect(r).toMatchObject({ status: 'appended', queued: true });
      expect(listOutboxEntries(outboxDir)).toHaveLength(1);
    });
  });

  it('the plumbing push never follows tags', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const pushes = [];
      const run = (args, opts) => { if (args[0] === 'push') pushes.push(args); return realGit(args, opts); };
      appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(2)], outbox: true, outboxDir: join(ctx.tmp, 'ob'), gitRun: run, log: quiet });
      expect(pushes[0]).toContain('--no-follow-tags');
    });
  });

  it('a short or corrupt entry write throws BEFORE anything is queued (read-back check)', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ob-')), 'outbox');
    const bad = { path: ledgerGitPath(REPO), repo: REPO, message: 'm', lines: ['{"not":"an event"}'], ids: ['x'] };
    expect(() => enqueueOutboxEntry(dir, bad)).toThrow(/write check/);
    expect(listOutboxEntries(dir)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('the tick-side backstop never flushes inline: it starts one detached flusher only when entries are queued', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const env = { [OUTBOX_DIR_ENV]: join(ctx.tmp, 'ob') };
      const spawned = [];
      const spawnFn = (cmd, args, opts) => { spawned.push({ args, opts }); return { pid: 4242, unref() {} }; };
      expect(spawnBoardLedgerOutboxFlush({ board: ctx.clone, env, spawnFn })).toMatchObject({ ok: true, flushed: 0 });
      expect(spawned).toEqual([]);
      enqueueOutboxEntry(env[OUTBOX_DIR_ENV], { path: ledgerGitPath(REPO), repo: REPO, message: 'm', ...checkLedgerAppendRows([row(3)], REPO) });
      const r = spawnBoardLedgerOutboxFlush({ board: ctx.clone, env, spawnFn });
      expect(r).toMatchObject({ ok: true, spawned: true, pending: 1, pid: 4242 });
      expect(spawned[0].args.slice(1)).toEqual(['flush', `--board=${ctx.clone}`]);
      expect(spawned[0].opts.detached).toBe(true);
    });
  });

  it('a dead holder\'s lock is reclaimed at once (pid fast path), and its queued rows are pushed', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      const lockRoot = outboxLockRoot(outboxDir);
      mkdirSync(join(lockRoot), { recursive: true });
      const dead = spawn(process.execPath, ['-e', '0']);
      await new Promise((d) => dead.on('close', d));
      const now = Date.now();
      expect(reserve(lockRoot, OUTBOX_LOCK_PATH, 'dead-writer', now, new Date(now).toISOString(), dead.pid).ok).toBe(true);
      const r = appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(9)], outbox: true, outboxDir, log: quiet });
      expect(r).toMatchObject({ status: 'appended', queued: false, rows: 1 });
      expect(originRows(ctx)).toEqual([9]);
      expect(readdirSync(lockRoot)).toEqual([]);
      void makeLockEntry;
    });
  });

  it('the outbox lives under the host-shared workspace .operations, not inside the clone', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const r = appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(1)], outbox: true, log: quiet, env: {} });
      expect(r.outboxDir.startsWith(join(ctx.tmp, '.operations', 'verdict-ledger-outbox'))).toBe(true);
      expect(r.outboxDir.startsWith(ctx.clone)).toBe(false);
      const overridden = appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(2)], outbox: true, log: quiet, env: { [OUTBOX_DIR_ENV]: join(ctx.tmp, 'o2') } });
      expect(overridden.outboxDir).toBe(join(ctx.tmp, 'o2'));
      expect(originRows(ctx)).toEqual([1, 2]);
    });
  });
});

describe('review-daemon tick: the outbox backstop', () => {
  it('the tick does no git and no discovery: it hands the repos to ONE throttled detached backstop', async () => {
    const { defaultFlushLedgerOutboxes } = await import('../../../skills-src/conveyor/review-daemon.mjs');
    const calls = [];
    const out = defaultFlushLedgerOutboxes({ repos: ['a/one', 'b/two'], spawnBackstop: (o) => { calls.push(o); return { ok: true, spawned: true, pid: 7 }; } });
    expect(calls).toEqual([{ repos: ['a/one', 'b/two'] }]);
    expect(out).toEqual([{ ok: true, spawned: true, pid: 7 }]);
  });

  it('the backstop spawns at most once per interval, detached, with an error listener', () => {
    resetLedgerOutboxBackstopThrottle();
    let t = 1_000_000;
    const spawned = [];
    const handlers = [];
    const spawnFn = (cmd, args, opts) => { spawned.push({ args, opts }); return { pid: 9, on: (ev, fn) => handlers.push([ev, fn]), unref() {} }; };
    const logs = [];
    const go = () => spawnLedgerOutboxBackstop({ repos: ['a/one'], intervalMs: 60_000, now: () => t, spawnFn, log: (l) => logs.push(l) });
    expect(go()).toMatchObject({ spawned: true, pid: 9 });
    t += 59_000;
    expect(go()).toMatchObject({ skipped: 'throttled' });
    t += 2_000;
    expect(go()).toMatchObject({ spawned: true });
    expect(spawned).toHaveLength(2);
    expect(spawned[0].args.slice(1)).toEqual(['flush-repos', '--repos=a/one']);
    expect(spawned[0].opts.detached).toBe(true);
    expect(handlers.map(([ev]) => ev)).toEqual(['error', 'error']);
    handlers[0][1](new Error('spawn EAGAIN'));
    expect(logs.join('\n')).toMatch(/ledger-write-miss: .*backstop failed to start \(spawn EAGAIN\)/);
  });

  it('every tick runs the backstop, logs what it flushed or failed, and survives a throw', async () => {
    const { buildCliDaemonEffects } = await import('../../../skills-src/conveyor/review-daemon.mjs');
    const deps = { reapSessions: () => null, runReview: () => ({}), runConvertAdvisories: () => null, runPrepReview: () => null };
    const lines = [];
    const log = { error: (l) => lines.push(l) };
    let calls = 0;
    await buildCliDaemonEffects({ owner: 't', log, ...deps, flushLedgerOutboxes: () => { calls += 1; return [{ ok: true, flushed: 2, dir: '/ob' }, { ok: false, flushed: 0, dir: '/ob2', error: 'boom' }]; } }).tickOnce();
    expect(calls).toBe(1);
    expect(lines.join('\n')).toMatch(/ledger outbox backstop flushed 2 entries \(\/ob\)/);
    expect(lines.join('\n')).toMatch(/ledger outbox backstop FAILED 0 entries \(\/ob2\): boom/);
    const r = await buildCliDaemonEffects({ owner: 't', log, ...deps, flushLedgerOutboxes: () => { throw new Error('disk gone'); } }).tickOnce();
    expect(r).toBeTruthy();
    expect(lines.join('\n')).toMatch(/ledger outbox backstop failed \(non-fatal\): disk gone/);
  });
});

describe('audit 2026-10-21: failure paths decide an outcome on purpose', () => {
  const entryFor = (pr, extra = {}) => {
    const { lines, ids } = checkLedgerAppendRows([row(pr)], REPO);
    return { path: ledgerGitPath(REPO), repo: REPO, message: 'm', lines, ids, ...extra };
  };

  it('a push that REPORTS failure but landed (dropped ack) is reconciled and counted as landed, not withdrawn', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      const run = (args, opts) => {
        const out = realGit(args, opts);
        if (args[0] === 'push') { const e = new Error('Command failed'); e.stderr = 'fatal: the remote end hung up unexpectedly\n'; e.status = 128; throw e; }
        return out;
      };
      const r = appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(21)], outbox: true, outboxDir, gitRun: run, log: quiet });
      expect(r).toMatchObject({ status: 'appended', queued: false, rows: 1 });
      expect(originRows(ctx)).toEqual([21]);
      expect(listOutboxEntries(outboxDir)).toEqual([]);
    });
  });

  it('a corrupt entry (integrity sum) is set aside loudly and never pushed', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      const name = enqueueOutboxEntry(outboxDir, entryFor(31));
      const file = join(outboxDir, name);
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      parsed.ids = ['sha256:' + '0'.repeat(64)];
      writeFileSync(file, JSON.stringify(parsed));
      const logs = [];
      const f = flushLedgerOutbox({ board: ctx.clone, dir: outboxDir, log: (l) => logs.push(l) });
      expect(f.flushed).toBe(0);
      expect(listOutboxEntries(outboxDir)).toEqual([]);
      expect(readdirSync(outboxDir)).toContain(`.corrupt-${name}`);
      expect(logs.join('\n')).toMatch(/ledger-write-miss: .* is corrupt/);
      expect(git(['ls-tree', '-r', '--name-only', LEDGER_TRANSPORT_BRANCH], { cwd: ctx.origin })).not.toMatch(/verdict-ledger/);
    });
  });

  it('an entry recorded for ANOTHER remote is never pushed by this board\'s flusher', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      enqueueOutboxEntry(outboxDir, entryFor(41, { originKey: 'not-this-remote' }));
      const logs = [];
      const f = flushLedgerOutbox({ board: ctx.clone, dir: outboxDir, log: (l) => logs.push(l) });
      expect(f).toMatchObject({ ok: true, flushed: 0 });
      expect(listOutboxEntries(outboxDir)).toHaveLength(1);
      expect(logs.join('\n')).toMatch(/another remote/);
    });
  });

  it('the backstop reports a stale backlog even when another process holds the lock', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      const now = Date.now();
      enqueueOutboxEntry(outboxDir, entryFor(51), { now: () => now - 30 * 60_000 });
      const lockRoot = outboxLockRoot(outboxDir);
      mkdirSync(lockRoot, { recursive: true });
      expect(reserve(lockRoot, OUTBOX_LOCK_PATH, 'other', now, new Date(now).toISOString(), process.pid).ok).toBe(true);
      const logs = [];
      const f = flushLedgerOutbox({ board: ctx.clone, dir: outboxDir, log: (l) => logs.push(l) });
      expect(f).toMatchObject({ held: true });
      expect(logs.join('\n')).toMatch(/ledger-write-miss: verdict-ledger outbox .* oldest 30m old/);
    });
  });

  it('one overall deadline: a flush stops between batches when its budget is spent, leaving the rest queued', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      enqueueOutboxEntry(outboxDir, entryFor(61));
      let t = 0;
      let pushes = 0;
      const run = (args, opts) => {
        if (args[0] === 'push') { pushes += 1; enqueueOutboxEntry(outboxDir, entryFor(62 + pushes)); t += 10_000; }
        return realGit(args, opts);
      };
      const f = flushLedgerOutbox({ board: ctx.clone, dir: outboxDir, run, log: quiet, now: () => t, budgetMs: 15_000 });
      expect(f.ok).toBe(true);
      expect(pushes).toBe(2);
      expect(listOutboxEntries(outboxDir).length).toBeGreaterThan(0);
    });
  });
});
