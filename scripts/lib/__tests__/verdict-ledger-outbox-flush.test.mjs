import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ledgerGitPath, LEDGER_TRANSPORT_BRANCH } from '../verdict-ledger-io.mjs';
import {
  flushLedgerOutbox, listOutboxEntries, outboxLockRoot, OUTBOX_LOCK_PATH, enqueueOutboxEntry,
} from '../verdict-ledger-outbox.mjs';
import { reserve } from '../../readiness/file-locks.mjs';
import { buildVerdictRecord, checkLedgerAppendRows } from '../verdict-ledger.mjs';
import { withBareOrigin, git } from '../../operations/__tests__/helpers/real-repo.mjs';

const REPO = 'web-everything/web-everything';
const row = (pr) => buildVerdictRecord({ repo: REPO, pr, verdict: 'accepted', at: '2026-10-21T12:00:00.000Z', source: 'test' });
const quiet = () => {};
const originRows = (ctx) => ctx.showOnOrigin(LEDGER_TRANSPORT_BRANCH, ledgerGitPath(REPO)).trim().split('\n').filter(Boolean)
  .map((l) => JSON.parse(l).pr);
const originCommits = (ctx) => Number(git(['rev-list', '--count', LEDGER_TRANSPORT_BRANCH], { cwd: ctx.origin }).trim());
const realGit = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...opts });

describe('flusher (flushLedgerOutbox)', () => {
  const entryFor = (pr, extra = {}) => {
    const { lines, ids } = checkLedgerAppendRows([row(pr)], REPO);
    return { path: ledgerGitPath(REPO), repo: REPO, message: 'm', lines, ids, ...extra };
  };

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
