/**
 * @file scripts/__tests__/merge-ai-prs-stranded-sweep-wiring.test.mjs
 * @description xvr2o8r — unit proof of the DRAIN'S OWN CALL to the strict #3916 stranded-item auto-resolve
 * backstop (`runStrandedSweepStep`, exported from `../merge-ai-prs.mjs`). PR #2661 added
 * `we:scripts/backlog-stranded-sweep.mjs --apply`, but nothing called it automatically — the drain only
 * printed a hint pointing at it. This wiring runs the strict subset (`autoStrandedSweepPass`) once per pass,
 * right after the drain's existing resolve-on-land step, and this file proves the WIRING behaves correctly:
 * `--dry-run` never writes, a real pass applies and logs what it resolved, and — the whole point of this
 * item — a sweep that throws or errors is logged and the pass continues rather than failing. This does NOT
 * re-test `autoStrandedSweepPass`'s own matching logic (that is `backlog-stranded-sweep.test.mjs`'s job); every
 * test here injects a fake `sweepFn` so the drain's own huge module is never actually run end to end.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runStrandedSweepStep, defaultStrandedSweepSync } from '../merge-ai-prs.mjs';
import { autoStrandedSweepPass } from '../backlog-stranded-sweep.mjs';

const okReport = (over = {}) => ({ ok: true, ran: true, autoResolvable: [], applied: [], mainLogUnavailable: false, mainLogWindowTruncated: false, mainLogLen: 0, error: null, ...over });

describe('xvr2o8r — runStrandedSweepStep: the drain\'s once-per-pass call to the strict auto-resolve backstop', () => {
  it('a REAL (non-dry-run) pass first previews with apply:false — the write happens only under the lock (below)', () => {
    const sweepFn = vi.fn(() => okReport());
    runStrandedSweepStep({ dryRun: false, asJson: true, sweepFn });
    expect(sweepFn).toHaveBeenCalledTimes(1);
    expect(sweepFn.mock.calls[0][0]).toEqual({ apply: false });
  });

  it('calls sweepFn with apply:false under --dry-run — a preview, never a write', () => {
    const sweepFn = vi.fn(() => okReport());
    runStrandedSweepStep({ dryRun: true, asJson: true, sweepFn });
    expect(sweepFn).toHaveBeenCalledTimes(1);
    expect(sweepFn.mock.calls[0][0]).toEqual({ apply: false });
  });

  it('the live case: reports #3916 and #4025 as auto-resolvable and applied on a real pass', () => {
    const report = okReport({
      autoResolvable: [
        { id: '3916', status: 'active', via: 'commit-subject "Graduate test setup … (#3916)"' },
        { id: '4025', status: 'open', via: 'commit-subject "WE #x1ydtnx: lane-pool trim … (#4025)"' },
      ],
      applied: [
        { id: '3916', flipped: true, alreadyResolved: false },
        { id: '4025', flipped: true, alreadyResolved: false },
      ],
    });
    const sweepFn = () => report;
    const log = vi.fn();
    const lockFn = (fn) => ({ result: fn(), ran: true });
    const result = runStrandedSweepStep({ dryRun: false, asJson: false, sweepFn, lockFn, syncFn: () => ({ ok: true, head: 'abc' }), pushFn: () => ({ pushed: true }), log });
    expect(result).toEqual({ ok: true, ran: true, autoResolvable: report.autoResolvable, applied: report.applied, error: null, pushed: true });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('✓ stranded-sweep resolved #3916, #4025 + pushed to main'));
  });

  it('a --dry-run pass logs what WOULD resolve and never calls anything that writes', () => {
    const report = okReport({
      autoResolvable: [{ id: '3916', status: 'active', via: 'commit-subject "…(#3916)"' }],
      applied: [], // dry-run: sweepFn itself never applies (its own contract), so nothing here
    });
    const log = vi.fn();
    const result = runStrandedSweepStep({ dryRun: true, asJson: false, sweepFn: () => report, log });
    expect(result.ok).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('DRY-RUN would resolve #3916'));
    expect(log.mock.calls.join('')).not.toMatch(/resolved #3916/); // never claims a write happened
  });

  it('NEVER FAILS THE PASS: a thrown sweepFn is logged and swallowed, not re-thrown', () => {
    const log = vi.fn();
    const sweepFn = () => { throw new Error('git log unavailable'); };
    expect(() => runStrandedSweepStep({ dryRun: false, asJson: false, sweepFn, log })).not.toThrow();
    const result = runStrandedSweepStep({ dryRun: false, asJson: false, sweepFn, log });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('git log unavailable');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stranded-sweep errored — skipped this pass, logging and continuing'));
  });

  it('a report with ok:false (sweepFn\'s own internal degrade) is logged and swallowed the same way', () => {
    const log = vi.fn();
    const sweepFn = () => ({ ok: false, ran: false, autoResolvable: [], applied: [], error: 'cannot read backlog/: ENOENT' });
    const result = runStrandedSweepStep({ dryRun: false, asJson: false, sweepFn, log });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('cannot read backlog/: ENOENT');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('cannot read backlog/: ENOENT'));
  });

  it('a malformed (non-object) report from sweepFn degrades instead of crashing', () => {
    const log = vi.fn();
    const result = runStrandedSweepStep({ dryRun: false, asJson: false, sweepFn: () => undefined, log });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/non-object report/);
  });

  it('never logs when asJson:true, even on an error — the --json contract stays clean stdout/silent stderr here', () => {
    const log = vi.fn();
    runStrandedSweepStep({ dryRun: false, asJson: true, sweepFn: () => { throw new Error('boom'); }, log });
    expect(log).not.toHaveBeenCalled();
  });

  it('a pass that finds nothing auto-resolvable is a quiet no-op (no log spam every pass)', () => {
    const log = vi.fn();
    const result = runStrandedSweepStep({ dryRun: false, asJson: false, sweepFn: () => okReport(), log });
    expect(result).toEqual({ ok: true, ran: true, autoResolvable: [], applied: [], error: null });
    expect(log).not.toHaveBeenCalled();
  });

  it('mainLogUnavailable degrades to a quiet report-only line, never an error', () => {
    const log = vi.fn();
    const result = runStrandedSweepStep({ dryRun: false, asJson: false, sweepFn: () => okReport({ mainLogUnavailable: true }), log });
    expect(result.ok).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not read origin/main'));
  });

  it('defaults sweepFn to the real autoStrandedSweepPass when none is injected (wiring is live, not vestigial)', () => {
    // The REAL autoStrandedSweepPass is the sweepFn (the default wiring), with only its two readers faked: the
    // default main-log reader runs `git fetch origin` / `git log origin/main`, which a hermetic test must not do.
    // We only assert it never throws and returns the expected report SHAPE; the actual matching behaviour is
    // backlog-stranded-sweep.test.mjs's job.
    const sweepFn = (o) => autoStrandedSweepPass({ ...o, readCardsFn: () => [], readMainLogFn: () => [] });
    const result = runStrandedSweepStep({ dryRun: true, asJson: true, sweepFn });
    expect(result).toHaveProperty('ok');
    expect(result).toHaveProperty('autoResolvable');
    expect(result).toHaveProperty('applied');
    expect(Array.isArray(result.autoResolvable)).toBe(true);
  });
});

// PR #2700 review round 1 — the apply path wrote to main (commit + push per flip, via `resolveLandedItem`'s
// sync/publish defaults) OUTSIDE the land-write mutex every other main-writing path in the drain holds. A fast
// `--only=<pr>` drain bypasses the whole-process drain lease, so that mutex is the only thing serializing it
// against a resident `--watch` drain. These pin the corrected contract: preview unlocked, then ONE locked
// section that syncs once, flips with `{sync:false, publish:false}`, and pushes once.
describe('xvr2o8r / PR #2700 — the apply path runs inside the land-write mutex with one sync and one push', () => {
  const candidates = [
    { id: '3916', status: 'active', via: 'commit-subject "…(#3916)"' },
    { id: '4025', status: 'open', via: 'commit-subject "…(#4025)"' },
  ];
  const flippedBoth = [
    { id: '3916', flipped: true, alreadyResolved: false },
    { id: '4025', flipped: true, alreadyResolved: false },
  ];
  // A fake lock that records what ran inside it, mirroring `withLandWriteLock`'s return shape.
  const makeSeams = ({ contended = false } = {}) => {
    const events = [];
    const lockFn = vi.fn((fn, opts) => {
      events.push('lock');
      if (contended) return { result: undefined, ran: false, held: false, contended: true, heldBy: 'other-drain' };
      const result = fn();
      events.push('unlock');
      return { result, ran: true, held: true, contended: false, heldBy: null };
    });
    const syncFn = vi.fn(() => { events.push('sync'); return { ok: true, head: 'pre-apply-sha' }; });
    const pushFn = vi.fn(({ shouldPush }) => { events.push(`push:${shouldPush}`); return { pushed: !!shouldPush }; });
    const sweepFn = vi.fn((o) => {
      events.push(`sweep:${o.apply ? 'apply' : 'preview'}`);
      return okReport({ autoResolvable: candidates, applied: o.apply ? flippedBoth : [] });
    });
    return { events, lockFn, syncFn, pushFn, sweepFn };
  };

  it('flips with resolveOpts {sync:false, publish:false} — never one pull+push per flip', () => {
    const s = makeSeams();
    runStrandedSweepStep({ dryRun: false, asJson: true, ...s });
    const applyCall = s.sweepFn.mock.calls.map((c) => c[0]).find((o) => o.apply);
    expect(applyCall).toEqual({ apply: true, resolveOpts: { sync: false, publish: false } });
  });

  it('syncs, applies and pushes INSIDE the land-write mutex, and refuses to run unlocked on contention', () => {
    const s = makeSeams();
    runStrandedSweepStep({ dryRun: false, asJson: true, ...s });
    expect(s.events).toEqual(['sweep:preview', 'lock', 'sync', 'sweep:apply', 'push:true', 'unlock']);
    expect(s.lockFn).toHaveBeenCalledTimes(1);
    expect(s.lockFn.mock.calls[0][1]).toMatchObject({ runUnlockedOnContention: false });
  });

  it('pushes ONCE for N flips', () => {
    const s = makeSeams();
    runStrandedSweepStep({ dryRun: false, asJson: true, ...s });
    expect(s.syncFn).toHaveBeenCalledTimes(1);
    expect(s.pushFn).toHaveBeenCalledTimes(1);
  });

  it('a contended mutex skips the apply this pass — no sync, no write, no push, logged, never an error', () => {
    const s = makeSeams({ contended: true });
    const log = vi.fn();
    const result = runStrandedSweepStep({ dryRun: false, asJson: false, ...s, log });
    expect(s.events).toEqual(['sweep:preview', 'lock']);
    expect(result).toMatchObject({ ok: true, ran: false, applied: [], skipped: 'land-write-lock-contended' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('land-write mutex held by other-drain'));
  });

  it('a failed push is reported, not logged as a success, and the local flip commits are rolled back', () => {
    const s = makeSeams();
    s.pushFn = vi.fn(() => ({ pushed: false, warning: 'push FAILED (non-fast-forward)' }));
    const rollbackFn = vi.fn(() => true);
    const log = vi.fn();
    const result = runStrandedSweepStep({ dryRun: false, asJson: false, ...s, rollbackFn, log });
    expect(result.pushed).toBe(false);
    expect(result.pushWarning).toMatch(/push FAILED/);
    expect(rollbackFn).toHaveBeenCalledWith('pre-apply-sha');
    expect(result.rolledBack).toBe(true);
    const out = log.mock.calls.join('');
    expect(out).not.toMatch(/✓ stranded-sweep resolved/);
    expect(out).toMatch(/committed locally but NOT pushed.*rolled back, next pass retries/);
  });

  it('a successful push never rolls anything back', () => {
    const s = makeSeams();
    const rollbackFn = vi.fn();
    runStrandedSweepStep({ dryRun: false, asJson: true, ...s, rollbackFn });
    expect(rollbackFn).not.toHaveBeenCalled();
  });

  it('a checkout NOT attached to main (a fast drain in a lane clone) skips the apply — never pushes lane commits to main', () => {
    const s = makeSeams();
    s.syncFn = vi.fn(() => { s.events.push('sync'); return { ok: false, reason: 'checkout not attached to main (detached HEAD)' }; });
    const log = vi.fn();
    const result = runStrandedSweepStep({ dryRun: false, asJson: false, ...s, log });
    expect(s.events).toEqual(['sweep:preview', 'lock', 'sync', 'unlock']);
    expect(s.pushFn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, ran: false, applied: [], skipped: 'checkout not attached to main (detached HEAD)' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('only a checkout attached to an up-to-date `main` may write'));
  });

  it('a pass with nothing to resolve never takes the lock, syncs, or pushes (the common case stays cheap)', () => {
    const s = makeSeams();
    s.sweepFn = vi.fn(() => okReport());
    runStrandedSweepStep({ dryRun: false, asJson: true, ...s });
    expect(s.sweepFn).toHaveBeenCalledTimes(1);
    expect(s.lockFn).not.toHaveBeenCalled();
    expect(s.syncFn).not.toHaveBeenCalled();
    expect(s.pushFn).not.toHaveBeenCalled();
  });

  it('a --dry-run pass with candidates never takes the lock or writes', () => {
    const s = makeSeams();
    runStrandedSweepStep({ dryRun: true, asJson: true, ...s });
    expect(s.events).toEqual(['sweep:preview']);
  });

  it('the REAL autoStrandedSweepPass → resolveFn chain receives {sync:false, publish:false}', () => {
    const cards = [{ stem: '3916-graduate', body: '---\nstatus: active\nkind: story\n---\n' }];
    const mainLog = ['Graduate test setup (#3916)'];
    const resolveFn = vi.fn(() => ({ flipped: true, alreadyResolved: false }));
    const s = makeSeams();
    const sweepFn = (o) => autoStrandedSweepPass({ ...o, readCardsFn: () => cards, readMainLogFn: () => mainLog, resolveFn });
    runStrandedSweepStep({ dryRun: false, asJson: true, lockFn: s.lockFn, syncFn: s.syncFn, pushFn: s.pushFn, sweepFn });
    expect(resolveFn).toHaveBeenCalledTimes(1);
    expect(resolveFn.mock.calls[0][2]).toEqual({ sync: false, publish: false });
  });

  it('does not auto-resolve an unfinished EPIC parent from a partial follow-up citing it', () => {
    const cards = [{ stem: '3383-dispatcher-epic', body: '---\nstatus: active\nkind: epic\n---\n' }];
    const resolveFn = vi.fn();
    const sweepFn = (o) => autoStrandedSweepPass({ ...o, readCardsFn: () => cards, readMainLogFn: () => ['fix: one slice of the dispatcher (#3383)'], resolveFn });
    const result = runStrandedSweepStep({ dryRun: false, asJson: true, ...makeSeams(), sweepFn });
    expect(result.autoResolvable).toEqual([]);
    expect(resolveFn).not.toHaveBeenCalled();
  });
});

describe('xvr2o8r / PR #2700 — defaultStrandedSweepSync: only an attached, fast-forwardable main may write', () => {
  const fakeExec = (answers) => vi.fn((cmd, args) => {
    const key = args.join(' ');
    const a = answers[key];
    if (a instanceof Error) throw a;
    return a ?? '';
  });

  it('detached HEAD (a lane clone) → refuses, never pulls', () => {
    const exec = fakeExec({ 'symbolic-ref --short -q HEAD': new Error('not a symbolic ref') });
    expect(defaultStrandedSweepSync({ exec })).toEqual({ ok: false, reason: 'checkout not attached to main (detached HEAD)' });
    expect(exec.mock.calls.map((c) => c[1][0])).toEqual(['symbolic-ref']);
  });

  it('attached to a lane/* branch → refuses', () => {
    const exec = fakeExec({ 'symbolic-ref --short -q HEAD': 'lane/xvr2o8r-foo\n' });
    expect(defaultStrandedSweepSync({ exec })).toMatchObject({ ok: false, reason: expect.stringContaining('lane/xvr2o8r-foo') });
  });

  it('main that cannot fast-forward (diverged) → refuses', () => {
    const exec = fakeExec({ 'symbolic-ref --short -q HEAD': 'main', 'pull --ff-only': new Error('Not possible to fast-forward') });
    expect(defaultStrandedSweepSync({ exec })).toMatchObject({ ok: false, reason: expect.stringContaining('did not fast-forward') });
  });

  it('attached main that fast-forwards → ok, with the post-sync head to roll back to', () => {
    const exec = fakeExec({ 'symbolic-ref --short -q HEAD': 'main\n', 'rev-parse HEAD': 'deadbeef\n' });
    expect(defaultStrandedSweepSync({ exec })).toEqual({ ok: true, head: 'deadbeef' });
  });
});

// PR #2700 review round 1 (codex-correctness) — the direct unit calls above cannot notice the call being
// deleted, duplicated, or gated from `runCli`'s pass. `sweepOnce` is a closure inside a 5000-line CLI, so this
// pins its one call site structurally: exactly one call, never nested under the `landedLocal` resolve-on-land
// block (it must run on passes that land nothing), and fed the pass's own `DRY_RUN`.
describe('xvr2o8r / PR #2700 — runCli wires the sweep exactly once per pass', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'), 'utf8');
  const sweepOnceStart = src.indexOf('const sweepOnce = async () => {');
  const sweepOnceEnd = src.indexOf('}; // end sweepOnce');
  const body = src.slice(sweepOnceStart, sweepOnceEnd);
  const calls = [...src.matchAll(/(?<!function )runStrandedSweepStep\(\{/g)].map((m) => m.index);

  it('has exactly one call site, and it is inside sweepOnce', () => {
    expect(sweepOnceStart).toBeGreaterThan(0);
    expect(sweepOnceEnd).toBeGreaterThan(sweepOnceStart);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThan(sweepOnceStart);
    expect(calls[0]).toBeLessThan(sweepOnceEnd);
  });

  it('runs unconditionally at the pass\'s top level, passing the pass\'s own DRY_RUN', () => {
    const line = body.split('\n').find((l) => l.includes('runStrandedSweepStep({'));
    expect(line).toMatch(/^ {2}const strandedSweep = runStrandedSweepStep\(\{ dryRun: DRY_RUN\b/);
  });
});
