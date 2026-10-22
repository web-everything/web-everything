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
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  appendLedgerRows, ledgerGitPath, readLedgerFromGit, LedgerAppendExhaustedError, LEDGER_TRANSPORT_BRANCH,
} from '../verdict-ledger-io.mjs';
import {
  flushLedgerOutbox, listOutboxEntries, outboxLockRoot, OUTBOX_LOCK_PATH, OUTBOX_DIR_ENV, enqueueOutboxEntry,
} from '../verdict-ledger-outbox.mjs';
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

  it('rows land in APPEND order: a later verdict never lands before an older queued one (round 7)', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      const older = buildVerdictRecord({ repo: REPO, pr: 77, verdict: 'accepted', at: '2026-10-21T12:00:00.000Z', source: 'test' });
      const newer = buildVerdictRecord({ repo: REPO, pr: 77, verdict: 'changes', at: '2026-10-21T12:05:00.000Z', source: 'test' });
      // The older verdict was queued by a lock loser; then a later append wins the lock.
      enqueueOutboxEntry(outboxDir, { path: ledgerGitPath(REPO), repo: REPO, message: 'm', ...checkLedgerAppendRows([older], REPO) }, { now: () => Date.now() - 1000 });
      appendLedgerRows({ board: ctx.clone, repo: REPO, records: [newer], outbox: true, outboxDir, log: quiet });
      const verdicts = ctx.showOnOrigin(LEDGER_TRANSPORT_BRANCH, ledgerGitPath(REPO)).trim().split('\n').map((l) => JSON.parse(l).verdict);
      expect(verdicts).toEqual(['accepted', 'changes']);
    });
  });

  it('an UNKNOWN push keeps the append\'s ORIGINAL order: it never lands after a newer queued verdict (round 8)', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      const older = buildVerdictRecord({ repo: REPO, pr: 78, verdict: 'accepted', at: '2026-10-21T12:00:00.000Z', source: 'test' });
      const newer = buildVerdictRecord({ repo: REPO, pr: 78, verdict: 'changes', at: '2026-10-21T12:05:00.000Z', source: 'test' });
      let first = true;
      const run = (args, opts) => {
        if (args[0] === 'push' && first) {
          first = false;
          // While the OLDER append's push hangs, a NEWER append queues (it lost the lock).
          enqueueOutboxEntry(outboxDir, { path: ledgerGitPath(REPO), repo: REPO, message: 'm', ...checkLedgerAppendRows([newer], REPO) }, { now: () => Date.now() + 1000 });
          throw Object.assign(new Error('Command failed'), { stderr: 'fatal: the remote end hung up unexpectedly\n', status: 128 });
        }
        return realGit(args, opts);
      };
      const r = appendLedgerRows({ board: ctx.clone, repo: REPO, records: [older], outbox: true, outboxDir, gitRun: run, log: quiet });
      expect(r).toMatchObject({ queued: true });
      flushLedgerOutbox({ board: ctx.clone, dir: outboxDir, log: quiet });
      const verdicts = ctx.showOnOrigin(LEDGER_TRANSPORT_BRANCH, ledgerGitPath(REPO)).trim().split('\n').map((l) => JSON.parse(l).verdict);
      expect(verdicts).toEqual(['accepted', 'changes']);
    });
  });

  it('an unreadable older entry blocks newer ones until it can be read; the order survives recovery (round 8)', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      const older = buildVerdictRecord({ repo: REPO, pr: 79, verdict: 'accepted', at: '2026-10-21T12:00:00.000Z', source: 'test' });
      const newer = buildVerdictRecord({ repo: REPO, pr: 79, verdict: 'changes', at: '2026-10-21T12:05:00.000Z', source: 'test' });
      const oldName = enqueueOutboxEntry(outboxDir, { path: ledgerGitPath(REPO), repo: REPO, message: 'm', ...checkLedgerAppendRows([older], REPO) }, { now: () => Date.now() - 1000 });
      const file = join(outboxDir, oldName);
      // Deterministically unreadable, root included: a DIRECTORY where the entry file should be (EISDIR).
      const bytes = readFileSync(file);
      rmSync(file);
      mkdirSync(file);
      try {
        const r = appendLedgerRows({ board: ctx.clone, repo: REPO, records: [newer], outbox: true, outboxDir, log: quiet });
        expect(r).toMatchObject({ queued: true }); // waited behind the unreadable older entry
      } finally { rmSync(file, { recursive: true, force: true }); writeFileSync(file, bytes); }
      flushLedgerOutbox({ board: ctx.clone, dir: outboxDir, log: quiet });
      const verdicts = ctx.showOnOrigin(LEDGER_TRANSPORT_BRANCH, ledgerGitPath(REPO)).trim().split('\n').map((l) => JSON.parse(l).verdict);
      expect(verdicts).toEqual(['accepted', 'changes']);
    });
  });

  it('a winner row held back behind an unreadable entry is NOT dropped after a partial batch (round 9)', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const outboxDir = join(ctx.tmp, 'outbox');
      const v = (verdict, min) => buildVerdictRecord({ repo: REPO, pr: 80, verdict, at: `2026-10-21T12:0${min}:00.000Z`, source: 'test' });
      const q = (rec, dt) => enqueueOutboxEntry(outboxDir, { path: ledgerGitPath(REPO), repo: REPO, message: 'm', ...checkLedgerAppendRows([rec], REPO) }, { now: () => Date.now() + dt });
      q(v('changes', 0), -3000);                       // A: flushable
      const bName = q(v('accepted', 1), -2000);        // B: unreadable at first
      const bFile = join(outboxDir, bName);
      // Deterministically unreadable, root included: a DIRECTORY where the entry file should be (EISDIR).
      const bBytes = readFileSync(bFile);
      rmSync(bFile);
      mkdirSync(bFile);
      const ats = () => ctx.showOnOrigin(LEDGER_TRANSPORT_BRANCH, ledgerGitPath(REPO)).trim().split('\n').map((l) => JSON.parse(l).at.slice(14, 16));
      let pushes = 0;
      let firstBatch = null;
      const run = (args, opts) => {
        const out = realGit(args, opts);
        if (args[0] === 'push' && ++pushes === 1) {
          firstBatch = ats();
          rmSync(bFile, { recursive: true }); writeFileSync(bFile, bBytes); // B recovers...
          q(v('accepted', 9), +5000);                                     // ...and a newer D queues
        }
        return out;
      };
      appendLedgerRows({ board: ctx.clone, repo: REPO, records: [v('changes', 5)], outbox: true, outboxDir, gitRun: run, log: quiet }); // C
      flushLedgerOutbox({ board: ctx.clone, dir: outboxDir, log: quiet });
      expect(firstBatch).toEqual(['00']); // only A passed the unreadable B
      expect(ats()).toEqual(['00', '01', '05', '09']); // A, B, C, D: append order, whatever became readable when
    });
  });

  it('a THROWING logger never turns a landed (reconciled) push into a failure, in either path (round 12)', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      // The push lands, then its acknowledgement is "lost"; reconciliation proves it landed; every log line throws.
      const lossy = (args, opts) => {
        const out = realGit(args, opts);
        if (args[0] === 'push') throw Object.assign(new Error('Command failed'), { stderr: 'fatal: the remote end hung up unexpectedly\n', status: 128 });
        return out;
      };
      const boom = () => { throw new Error('log sink failed'); };
      const a = appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(16)], outbox: true, outboxDir: join(ctx.tmp, 'ob'), gitRun: lossy, log: boom });
      expect(a).toMatchObject({ status: 'appended', queued: false });
      const d = appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(17)], outbox: false, run: lossy, log: boom, sleep: noSleep, onRetry: () => { throw new Error('observer broke'); } });
      expect(d).toMatchObject({ status: 'appended' });
      expect(originRows(ctx).sort((x, y) => x - y)).toEqual([16, 17]);
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

describe('audit 2026-10-21: failure paths decide an outcome on purpose', () => {
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

});
