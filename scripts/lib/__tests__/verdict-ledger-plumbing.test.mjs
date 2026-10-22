/**
 * @file verdict-ledger-plumbing.test.mjs - the ledger OUTBOX + PLUMBING flush (live 2026-10-21: 3+ same-host writers
 *   raced 9-second worktree pushes to `ops/review-requests`, the losers exhausted 5 short retries and referral holds
 *   and rulings never persisted, #5502 #5530 #5773 #5742 #5768).
 *
 * The append writes its rows to a host-local outbox first, then ONE writer at a time (a host-wide flusher lock)
 * pushes everything queued as ONE plumbing commit. These tests pin the invariants: every row lands exactly once,
 * a crash between push and delete never duplicates, an off-host (CI) writer's push is retried on the new tip,
 * nothing is ever forced, and a failure still surfaces.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { appendLedgerRows, LedgerAppendExhaustedError, LEDGER_TRANSPORT_BRANCH } from '../verdict-ledger-io.mjs';
import { listOutboxEntries } from '../verdict-ledger-outbox-spool.mjs';
import { buildVerdictRecord } from '../verdict-ledger.mjs';
import { withBareOrigin, git } from '../../operations/__tests__/helpers/real-repo.mjs';

const REPO = 'web-everything/web-everything';
const row = (pr) => buildVerdictRecord({ repo: REPO, pr, verdict: 'accepted', at: '2026-10-21T12:00:00.000Z', source: 'test' });
const noSleep = () => {};
const quiet = () => {};
const realGit = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...opts });

describe('real git: outbox + plumbing flush', () => {
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

  it('the direct path never starts a git call or sleeps past its budget (round 6)', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const timeouts = [];
      const slept = [];
      const run = (args, opts) => {
        timeouts.push(opts?.timeout);
        if (args[0] === 'push') throw Object.assign(new Error('Command failed'), { stdout: `!\tx:refs/heads/ops/review-requests\t[rejected] (fetch first)\n`, status: 1 });
        return realGit(args, opts);
      };
      const t0 = Date.now();
      expect(() => appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(13)], outbox: false, run, attempts: 50, settings: { verdictLedger: { flushBudgetMs: 1500 } }, sleep: (ms) => { slept.push(ms); const until = Date.now() + ms; while (Date.now() < until) { /* spin */ } } }))
        .toThrow(LedgerAppendExhaustedError);
      expect(Date.now() - t0).toBeLessThan(1500 + 2_000);
      for (const t of timeouts) expect(t).toBeLessThanOrEqual(1500);
      for (const ms of slept) expect(ms).toBeLessThanOrEqual(1500);
    });
  });

  it('a throwing onRetry observer never erases an UNKNOWN push outcome (round 9)', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const run = (args, opts) => {
        if (args[0] === 'push') throw Object.assign(new Error('Command failed'), { stderr: 'fatal: the remote end hung up unexpectedly\n', status: 128 });
        if (args[0] === 'merge-base') throw Object.assign(new Error('not ancestor'), { status: 1 });
        return realGit(args, opts);
      };
      let err;
      try {
        appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(14)], outbox: false, run, attempts: 2, sleep: noSleep, log: quiet, onRetry: () => { throw new Error('observer broke'); } });
      } catch (e) { err = e; }
      expect(err).toBeInstanceOf(LedgerAppendExhaustedError);
      expect(err.indeterminate).toBe(true);
    });
  });

  it('a pushurl pointing elsewhere (or several push URLs) is refused BEFORE publication (round 11)', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      git(['config', 'remote.origin.pushurl', join(ctx.tmp, 'elsewhere.git')], { cwd: ctx.clone });
      const pushes = [];
      const run = (args, opts) => { if (args[0] === 'push') pushes.push(args); return realGit(args, opts); };
      expect(() => appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(15)], outbox: false, outboxDir: join(ctx.tmp, 'ob'), gitRun: run, log: quiet }))
        .toThrow(/exactly ONE push destination/);
      expect(pushes).toEqual([]);
      expect(listOutboxEntries(join(ctx.tmp, 'ob'))).toEqual([]);
    });
  });

  it('the plumbing push never follows tags', async () => {
    await withBareOrigin(async (ctx) => {
      ctx.seedOriginBranch(LEDGER_TRANSPORT_BRANCH, { 'README.md': 'transport\n' });
      const pushes = [];
      const run = (args, opts) => { if (args[0] === 'push') pushes.push(args); return realGit(args, opts); };
      appendLedgerRows({ board: ctx.clone, repo: REPO, records: [row(2)], outbox: false, outboxDir: join(ctx.tmp, 'ob'), gitRun: run, log: quiet });
      expect(pushes[0]).toContain('--no-follow-tags');
    });
  });
});
