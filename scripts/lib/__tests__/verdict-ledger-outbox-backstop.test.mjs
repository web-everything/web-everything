/**
 * @file verdict-ledger-outbox-backstop.test.mjs - the ledger OUTBOX + PLUMBING flush (live 2026-10-21: 3+ same-host writers
 *   raced 9-second worktree pushes to `ops/review-requests`, the losers exhausted 5 short retries and referral holds
 *   and rulings never persisted, #5502 #5530 #5773 #5742 #5768).
 *
 * The append writes its rows to a host-local outbox first, then ONE writer at a time (a host-wide flusher lock)
 * pushes everything queued as ONE plumbing commit. These tests pin the invariants: every row lands exactly once,
 * a crash between push and delete never duplicates, an off-host (CI) writer's push is retried on the new tip,
 * nothing is ever forced, and a failure still surfaces.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ledgerGitPath, LEDGER_TRANSPORT_BRANCH } from '../verdict-ledger-io.mjs';
import { OUTBOX_DIR_ENV, enqueueOutboxEntry } from '../verdict-ledger-outbox-spool.mjs';
import {
  spawnBoardLedgerOutboxFlush, spawnLedgerOutboxBackstop, resetLedgerOutboxBackstopThrottle,
  defaultOutboxRoot, flushBoardLedgerOutbox,
} from '../verdict-ledger-outbox-backstop.mjs';
import { buildVerdictRecord, checkLedgerAppendRows } from '../verdict-ledger.mjs';
import { withBareOrigin } from '../../operations/__tests__/helpers/real-repo.mjs';

const REPO = 'web-everything/web-everything';
const row = (pr) => buildVerdictRecord({ repo: REPO, pr, verdict: 'accepted', at: '2026-10-21T12:00:00.000Z', source: 'test' });

describe('real git: outbox + plumbing flush', () => {
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

  it('the backstop always scans its own workspace outbox root, from a primary-checkout layout too (round 7)', () => {
    expect(defaultOutboxRoot('/w/repo/scripts/lib/verdict-ledger-outbox.mjs')).toBe('/w/.operations/verdict-ledger-outbox');
    expect(defaultOutboxRoot('/w/.lanes/web-everything/lane-3/scripts/lib/verdict-ledger-outbox.mjs')).toBe('/w/.operations/verdict-ledger-outbox');
  });

  it('the board-level backstop helpers return {ok:false} even when their logger throws (round 13)', () => {
    const boom = () => { throw new Error('log sink failed'); };
    const nowhere = join(mkdtempSync(join(tmpdir(), 'nb-')), 'not-a-repo');
    expect(flushBoardLedgerOutbox({ board: nowhere, env: {}, log: boom })).toMatchObject({ ok: false });
    expect(spawnBoardLedgerOutboxFlush({ board: nowhere, env: {}, log: boom })).toMatchObject({ ok: false });
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
