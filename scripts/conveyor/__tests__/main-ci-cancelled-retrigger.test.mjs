import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sweepMainCancelledRetrigger, rerunMainCancelledRun, formatMainCancelledReport, main,
  mainRetriggerRecordPath, withMainRetriggerLock } from '../ci-red-recovery-watch.mjs';
import { DEFAULT_MAIN_WORKFLOW_NAME } from '../main-red-recovery.mjs';
import { budgetBlockedMessage, runGhSync, writeBudgetBlock } from '../../lib/gh-throttle.mjs';

const sha = 'a'.repeat(40);
const now = Date.parse('2026-10-26T12:00:00Z');
const run = (overrides = {}) => ({ databaseId: 123, headSha: sha, workflowName: DEFAULT_MAIN_WORKFLOW_NAME,
  createdAt: '2026-10-26T11:00:00Z', status: 'completed', conclusion: 'cancelled', ...overrides });

function fixture(runs = [run()], initial = {}) {
  let record = structuredClone(initial);
  const options = { apply: true, now, repo: 'web-everything/web-everything', recordPath: 'fixture/main-ci-retrigger.json',
    readMainRuns: vi.fn(() => runs), rerun: vi.fn(() => ({ ok: true })),
    readRecord: vi.fn(() => structuredClone(record)),
    writeRecord: vi.fn((path, value) => { record = structuredClone(value); }), emitEvent: vi.fn(), lock: (_path, fn) => ({ locked: true, value: fn() }) };
  return { options, record: () => record, tick: () => sweepMainCancelledRetrigger(options) };
}

describe('main cancelled CI retrigger', () => {
  it('reruns a cancelled newest run once, persists the attempt, and emits main-ci-retriggered', () => {
    const f = fixture();
    f.options.rerun.mockImplementation(() => {
      expect(f.record()[sha]).toEqual({ runId: 123, retriggeredAt: new Date(now).toISOString(), reserved: true });
      return { ok: true };
    });
    const result = f.tick();
    expect(f.options.readMainRuns).toHaveBeenCalledWith({ repo: f.options.repo, branch: 'main', workflowName: DEFAULT_MAIN_WORKFLOW_NAME });
    expect(f.options.rerun).toHaveBeenCalledOnce();
    expect(f.options.rerun).toHaveBeenCalledWith(123, { repo: f.options.repo });
    expect(f.options.readRecord).toHaveBeenCalledWith(f.options.recordPath);
    expect(f.options.writeRecord).toHaveBeenCalledTimes(2);
    expect(f.options.writeRecord).toHaveBeenNthCalledWith(1, f.options.recordPath,
      { [sha]: { runId: 123, retriggeredAt: new Date(now).toISOString(), reserved: true } });
    expect(f.options.writeRecord).toHaveBeenNthCalledWith(2, f.options.recordPath,
      { [sha]: { runId: 123, retriggeredAt: new Date(now).toISOString() } });
    expect(f.options.emitEvent).toHaveBeenCalledOnce();
    expect(f.options.emitEvent).toHaveBeenCalledWith({ kind: 'main-ci-retriggered', detail: { sha, runId: 123 } });
    expect(result.applied).toEqual([{ action: 'main-ci-retriggered', sha, runId: 123, ok: true }]);
    expect(formatMainCancelledReport(result)).toContain(`main-ci-retriggered ${sha}`);
  });

  it.each(['queued', 'in_progress', 'waiting', 'pending'])('refuses when any run for that head is %s', status => {
    const f = fixture([run(), run({ databaseId: 122, status, createdAt: '2026-10-26T10:00:00Z', conclusion: null })]);
    expect(f.tick().refusals).toEqual([{ reason: 'in-progress', sha, runId: 123 }]);
    expect(f.options.rerun).not.toHaveBeenCalled();
    expect(f.options.emitEvent).not.toHaveBeenCalled();
    expect(f.options.readRecord).not.toHaveBeenCalled();
  });

  it('marks a second cancellation stuck once and emits nothing on the third tick', () => {
    const runs = [run()];
    const f = fixture(runs);
    f.tick();
    runs[0] = run({ databaseId: 124, createdAt: '2026-10-26T12:00:00Z' });
    const second = f.tick();
    expect(second.applied).toEqual([{ action: 'main-ci-stuck', sha, runId: 124, ok: true }]);
    expect(f.record()[sha]).toEqual({ runId: 123, retriggeredAt: new Date(now).toISOString(), stuck: true });
    expect(f.options.emitEvent).toHaveBeenNthCalledWith(2, { kind: 'main-ci-stuck', detail: { sha, runId: 124 } });
    expect(f.tick()).toEqual({ dispatch: [], refusals: [], applied: [] });
    expect(f.options.emitEvent).toHaveBeenCalledTimes(2);
    expect(f.options.rerun).toHaveBeenCalledOnce();
    expect(f.options.writeRecord).toHaveBeenCalledTimes(3);
  });

  it.each(['failure', 'success'])('leaves a %s conclusion to the other passes', conclusion => {
    const f = fixture([run({ conclusion })]);
    expect(f.tick()).toEqual({ dispatch: [], refusals: [], applied: [] });
    expect(f.options.rerun).not.toHaveBeenCalled();
    expect(f.options.emitEvent).not.toHaveBeenCalled();
  });

  it('treats skipped like cancelled for both the retry and stuck signal', () => {
    const runs = [run({ conclusion: 'skipped' })];
    const f = fixture(runs);
    f.tick();
    runs[0] = run({ conclusion: 'skipped', updatedAt: '2026-10-26T12:01:00Z' });
    f.tick();
    f.tick();
    expect(f.options.rerun).toHaveBeenCalledOnce();
    expect(f.options.emitEvent.mock.calls.map(([e]) => e.kind)).toEqual(['main-ci-retriggered', 'main-ci-stuck']);
  });

  it.each(['cancelled', 'skipped'])('repeated original-attempt %s evidence leaves stuck unset until the rerun completes', conclusion => {
    const runs = [run({ conclusion, updatedAt: '2026-10-26T11:01:00Z' })];
    const f = fixture(runs);
    f.tick();
    expect(f.tick()).toEqual({ dispatch: [], refusals: [], applied: [] });
    expect(f.tick()).toEqual({ dispatch: [], refusals: [], applied: [] });
    expect(f.record()[sha]).toEqual({ runId: 123, retriggeredAt: new Date(now).toISOString() });
    expect(f.options.rerun).toHaveBeenCalledOnce();
    expect(f.options.writeRecord).toHaveBeenCalledTimes(2);
    expect(f.options.emitEvent.mock.calls.map(([event]) => event.kind)).toEqual(['main-ci-retriggered']);

    // A rerun keeps the original run ID and createdAt. Its later completion must
    // still produce the real stuck signal after the stale sweeps above.
    runs[0] = run({ conclusion, updatedAt: '2026-10-26T12:01:00Z' });
    expect(f.tick().applied).toEqual([{ action: 'main-ci-stuck', sha, runId: 123, ok: true }]);
    expect(f.record()[sha].stuck).toBe(true);
    expect(f.options.emitEvent.mock.calls.map(([event]) => event.kind)).toEqual(['main-ci-retriggered', 'main-ci-stuck']);
    expect(f.tick()).toEqual({ dispatch: [], refusals: [], applied: [] });
    expect(f.options.emitEvent).toHaveBeenCalledTimes(2);
    expect(f.options.rerun).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'invalid', '2026-10-26T12:00:00Z'])('does not infer a completed rerun from missing, invalid, or unchanged completion evidence (%s)', updatedAt => {
    // Existing records have only runId and retriggeredAt; their absence of
    // attempt metadata must not turn the original cancellation into stuck.
    const f = fixture([run({ updatedAt })], { [sha]: { runId: '123', retriggeredAt: new Date(now).toISOString() } });
    expect(f.tick()).toEqual({ dispatch: [], refusals: [], applied: [] });
    expect(f.record()[sha].stuck).toBeUndefined();
    expect(f.options.rerun).not.toHaveBeenCalled();
    expect(f.options.writeRecord).not.toHaveBeenCalled();
    expect(f.options.emitEvent).not.toHaveBeenCalled();
  });

  it('removes the reservation after a confirmed rerun rejection and retries next tick', () => {
    const f = fixture();
    f.options.rerun.mockReturnValueOnce({ ok: false, error: 'rerun denied' });
    expect(f.tick().applied[0]).toMatchObject({ ok: false, error: expect.stringContaining('rerun denied') });
    expect(f.record()).toEqual({});
    expect(f.options.writeRecord).toHaveBeenCalledTimes(2);
    expect(f.options.emitEvent).not.toHaveBeenCalled();
    expect(f.tick().applied[0].ok).toBe(true);
    expect(f.options.rerun).toHaveBeenCalledTimes(2);
  });

  it.each(['thrown', 'returned-uncertain', 'missing'])('retains a durable reservation after an uncertain %s outcome and does not resubmit', mode => {
    const f = fixture();
    f.options.rerun.mockImplementationOnce(() => {
      if (mode === 'thrown') throw Error('acknowledgement lost');
      if (mode === 'returned-uncertain') return { ok: false, uncertain: true, error: 'acknowledgement lost' };
      return undefined;
    });
    expect(f.tick().applied[0]).toMatchObject({ ok: false, error: expect.stringContaining('reservation retained') });
    expect(f.record()[sha].reserved).toBe(true);
    expect(f.tick().refusals[0]).toMatchObject({ reason: 'rerun-outcome-unknown', error: expect.stringContaining('inspect main CI') });
    expect(f.options.rerun).toHaveBeenCalledOnce();
    expect(f.options.emitEvent).not.toHaveBeenCalled();
    const restarted = fixture([run()], f.record());
    expect(restarted.tick().refusals[0].reason).toBe('rerun-outcome-unknown');
    expect(restarted.options.rerun).not.toHaveBeenCalled();
  });

  it('retains the reservation when rollback of a confirmed rejection fails', () => {
    const f = fixture();
    const persist = f.options.writeRecord.getMockImplementation();
    f.options.writeRecord.mockImplementationOnce(persist).mockImplementationOnce(() => { throw Error('disk unavailable'); });
    f.options.rerun.mockReturnValueOnce({ ok: false, error: 'rerun denied' });
    expect(f.tick().applied[0].error).toContain('reservation rollback failed');
    expect(f.record()[sha].reserved).toBe(true);
    expect(f.tick().refusals[0].reason).toBe('rerun-outcome-unknown');
    expect(f.options.rerun).toHaveBeenCalledOnce();
    expect(f.options.emitEvent).not.toHaveBeenCalled();
  });

  it.each([false, true])('dry run only reports a dispatch (previous attempt: %s)', attempted => {
    const f = fixture([run({ updatedAt: '2026-10-26T12:01:00Z' })], attempted ? { [sha]: { runId: 123, retriggeredAt: new Date(now).toISOString() } } : {});
    f.options.apply = false;
    const result = f.tick();
    expect(result.dispatch).toEqual([{ action: attempted ? 'main-ci-stuck' : 'main-ci-retriggered', sha, runId: 123 }]);
    expect(result.applied).toEqual([]);
    expect(f.options.rerun).not.toHaveBeenCalled();
    expect(f.options.writeRecord).not.toHaveBeenCalled();
    expect(f.options.emitEvent).not.toHaveBeenCalled();
  });

  it('selects the newest createdAt regardless of input order, other heads, or other workflows', () => {
    const f = fixture([run({ headSha: 'b'.repeat(40), createdAt: '2026-10-26T10:00:00Z', status: 'queued' }),
      run({ workflowName: 'other', createdAt: '2026-10-26T13:00:00Z', conclusion: 'success' }), run()]);
    f.options.defaultBranch = 'trunk';
    f.tick();
    expect(f.options.rerun).toHaveBeenCalledOnce();
    expect(f.options.rerun).toHaveBeenCalledWith(123, { repo: f.options.repo });
    expect(f.options.readMainRuns.mock.calls[0][0].branch).toBe('trunk');
  });

  it('does not revive an older cancelled head after a newer successful head', () => {
    const f = fixture([run(), run({ headSha: 'b'.repeat(40), createdAt: '2026-10-26T13:00:00Z', conclusion: 'success' })]);
    f.tick();
    expect(f.options.rerun).not.toHaveBeenCalled();
    expect(f.options.emitEvent).not.toHaveBeenCalled();
  });

  it('keeps only the most recent 20 attempt records', () => {
    const initial = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [String(i),
      { runId: i + 1, retriggeredAt: new Date(now - (i + 1) * 1000).toISOString() }]));
    const f = fixture([run()], initial);
    f.tick();
    expect(Object.keys(f.record())).toHaveLength(20);
    expect(f.record()[sha]).toBeDefined();
    expect(f.record()['18']).toBeDefined();
    expect(f.record()['19']).toBeUndefined();
  });

  it.each([{ initial: null }, { initial: [] }, { initial: { [sha]: {} } }])('refuses malformed persisted state %# without rerunning', ({ initial }) => {
    const f = fixture([run()], initial);
    expect(f.tick().refusals[0].reason).toBe('record-unreadable');
    expect(f.options.rerun).not.toHaveBeenCalled();
    expect(f.options.emitEvent).not.toHaveBeenCalled();
  });

  it.each(['runs', 'record'])('refuses unreadable %s evidence', kind => {
    const f = fixture();
    f.options[kind === 'runs' ? 'readMainRuns' : 'readRecord'].mockImplementation(() => { throw Error('unreadable'); });
    expect(f.tick().refusals[0].reason).toBe(kind === 'runs' ? 'main-runs-unreadable' : 'record-unreadable');
    expect(f.options.rerun).not.toHaveBeenCalled();
    expect(f.options.emitEvent).not.toHaveBeenCalled();
  });

  it('refuses incomplete run evidence instead of selecting an older cancellation', () => {
    const f = fixture([run(), run({ createdAt: null })]);
    expect(f.tick().refusals[0].reason).toBe('main-runs-unreadable');
    expect(f.options.rerun).not.toHaveBeenCalled();
  });

  it('does nothing for empty history', () => {
    const f = fixture([]);
    expect(f.tick()).toEqual({ dispatch: [], refusals: [], applied: [] });
    expect(f.options.readRecord).not.toHaveBeenCalled();
    expect(f.options.rerun).not.toHaveBeenCalled();
    expect(f.options.emitEvent).not.toHaveBeenCalled();
  });

  it('refuses a missing run ID', () => {
    const f = fixture([run({ databaseId: null })]);
    expect(f.tick().refusals[0].reason).toBe('invalid-run-id');
    expect(f.options.rerun).not.toHaveBeenCalled();
  });

  it('does not submit a rerun when its durable reservation cannot be written', () => {
    const f = fixture();
    f.options.writeRecord.mockImplementation(() => { throw Error('disk unavailable'); });
    expect(f.tick().applied[0]).toMatchObject({ ok: false, error: expect.stringContaining('disk unavailable') });
    expect(f.options.emitEvent).not.toHaveBeenCalled();
    expect(f.record()).toEqual({});
    expect(f.tick().applied[0].ok).toBe(false);
    expect(f.options.rerun).not.toHaveBeenCalled();
  });

  it('a successful rerun followed by persistence failure cannot cause another rerun', () => {
    const f = fixture();
    const persist = f.options.writeRecord.getMockImplementation();
    f.options.writeRecord.mockImplementationOnce(persist).mockImplementationOnce(() => { throw Error('disk unavailable'); });
    expect(f.tick().applied[0]).toMatchObject({ ok: false, error: expect.stringContaining('disk unavailable') });
    expect(f.record()[sha]).toEqual({ runId: 123, retriggeredAt: new Date(now).toISOString(), reserved: true });
    expect(f.tick().refusals[0].reason).toBe('rerun-outcome-unknown');
    expect(f.options.rerun).toHaveBeenCalledOnce();
    expect(f.options.emitEvent).not.toHaveBeenCalled();
    const restarted = fixture([run()], f.record());
    restarted.tick();
    expect(restarted.options.rerun).not.toHaveBeenCalled();
  });

  it.each(['throws', 'rejects'])('ignores best-effort event delivery that %s', async mode => {
    const f = fixture();
    f.options.emitEvent.mockImplementation(() => {
      if (mode === 'throws') throw Error('event unavailable');
      return Promise.reject(Error('event unavailable'));
    });
    expect(f.tick().applied[0].ok).toBe(true);
    await Promise.resolve();
    expect(f.record()[sha]).toBeDefined();
  });
});

describe('main cancelled CI rerun IO', () => {
  it('posts a bounded whole-run rerun through the injected throttle executor', () => {
    const exec = vi.fn();
    expect(rerunMainCancelledRun(123, { repo: 'owner/repo', exec })).toEqual({ ok: true });
    expect(exec).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith('gh', ['api', '-X', 'POST', 'repos/owner/repo/actions/runs/123/rerun'],
      expect.objectContaining({ maxBuffer: expect.any(Number), timeout: expect.any(Number), killSignal: 'SIGKILL' }));
  });

  it('returns the real rerun error', () => {
    const exec = () => { throw Error('permission denied'); };
    expect(rerunMainCancelledRun(123, { exec })).toEqual({ ok: false, uncertain: true, error: expect.stringContaining('permission denied') });
  });

  it.each(['HTTP 403', 'HTTP 422'])('recognizes an explicit %s API rejection as safe to retry', error => {
    const exec = () => { throw Error(error); };
    expect(rerunMainCancelledRun(123, { exec })).toEqual({ ok: false, uncertain: false, error });
  });

  it.each(['HTTP 408', 'HTTP 500', 'request timed out'])('treats %s as an uncertain remote outcome', error => {
    const exec = () => { throw Error(error); };
    expect(rerunMainCancelledRun(123, { exec })).toEqual({ ok: false, uncertain: true, error });
  });
});

describe('main cancelled CLI pass', () => {
  function cli() {
    const order = [];
    const pass = name => vi.fn(() => { order.push(name); return { dispatch: [], refusals: [], applied: [] }; });
    return { order, deps: { sweepOptions: { exhaustedRetrySettings: {} }, sweepMainRed: pass('main-red'),
      sweepExhausted: pass('exhausted-retry'), sweepHung: pass('hung'), sweepMissingRun: pass('missing-run'),
      sweepMainCancelled: pass('main-cancelled'), sweepPrCancelled: vi.fn(() => ({ dispatch: [], refusals: [], applied: [] })),
      writeAll: vi.fn(), writeLine: vi.fn() } };
  }

  it('runs after missing-run and includes the result in JSON', async () => {
    const { order, deps } = cli();
    await main(['sweep', '--apply', '--json', '--repo=web-everything/web-everything'], deps);
    expect(order).toEqual(['main-red', 'exhausted-retry', 'hung', 'missing-run', 'main-cancelled']);
    expect(deps.sweepMainCancelled.mock.calls[0][0]).toMatchObject({ apply: true, repo: 'web-everything/web-everything' });
    expect(JSON.parse(deps.writeAll.mock.calls[0][1]).mainCancelledRetrigger).toEqual({ dispatch: [], refusals: [], applied: [] });
  });

  it('uses the real pass safely with an injected empty run history', async () => {
    const { deps } = cli();
    delete deps.sweepMainCancelled;
    deps.sweepOptions.readMainRuns = vi.fn(() => []);
    await main(['sweep', '--json'], deps);
    expect(deps.sweepOptions.readMainRuns).toHaveBeenCalledOnce();
    expect(JSON.parse(deps.writeAll.mock.calls[0][1]).mainCancelledRetrigger).toEqual({ dispatch: [], refusals: [], applied: [] });
  });

  it('prints the action and sha in the text report', async () => {
    const { deps } = cli();
    deps.sweepMainCancelled.mockReturnValue({ dispatch: [{ action: 'main-ci-retriggered', sha, runId: 123 }], refusals: [], applied: [] });
    await main(['sweep'], deps);
    expect(deps.writeLine.mock.calls.some(([, line]) => line.includes(`main-ci-retriggered ${sha}`))).toBe(true);
  });

  it('isolates a main-cancelled exception under its own pass name', async () => {
    const { deps } = cli();
    deps.sweepMainCancelled.mockImplementation(() => { throw Error('cancelled read failed'); });
    const previousExitCode = process.exitCode;
    try {
      await main(['sweep', '--json'], deps);
      expect(process.exitCode).toBe(1);
      expect(deps.writeLine.mock.calls.some(([, line]) => line.includes('main-cancelled: cancelled read failed'))).toBe(true);
      expect(JSON.parse(deps.writeAll.mock.calls[0][1]).mainCancelledRetrigger.error).toContain('cancelled read failed');
    } finally { process.exitCode = previousExitCode; }
  });
});

describe('main cancelled CI retrigger: local throttle rejection', () => {
  const throttled = () => Object.assign(Error('gh-throttle: throttled before submission'),
    { status: 1, stdout: '', stderr: 'gh-throttle: throttled', ghThrottled: { class: 'write', waitedMs: 0 } });

  it('classifies a rejection raised before gh ran as safe to retry', () => {
    const exec = () => { throw throttled(); };
    expect(rerunMainCancelledRun(123, { exec })).toEqual({ ok: false, uncertain: false, error: expect.stringContaining('throttled') });
  });

  it('keeps a throttle-marked error that carries an HTTP 5xx body uncertain only when gh actually ran', () => {
    const exec = () => { throw Error('HTTP 502 from gateway'); };
    expect(rerunMainCancelledRun(123, { exec }).uncertain).toBe(true);
  });

  it('releases the reservation after a local throttle rejection so the next sweep reruns', () => {
    const f = fixture();
    const exec = vi.fn().mockImplementationOnce(() => { throw throttled(); });
    f.options.rerun = (runId, opts) => rerunMainCancelledRun(runId, { ...opts, exec });
    expect(f.tick().applied[0]).toMatchObject({ ok: false });
    expect(f.record()).toEqual({});
    expect(f.tick().applied[0].ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('treats a throttle error thrown by an injected rerunner as a confirmed non-submission too', () => {
    const f = fixture();
    f.options.rerun.mockImplementationOnce(() => { throw throttled(); });
    expect(f.tick().applied[0].ok).toBe(false);
    expect(f.record()).toEqual({});
    expect(f.tick().applied[0].ok).toBe(true);
  });
});

describe('main cancelled CI retrigger: local budget refusal', () => {
  const block = { resource: 'core', until: '2026-10-26T12:01:00.000Z' };
  const budgetError = shape => shape === 'structured'
    ? Object.assign(Error('budget blocked'), { budgetBlocked: block })
    : Object.assign(Error('Command failed'), {
      stderr: shape === 'buffer' ? Buffer.from(budgetBlockedMessage(block)) : budgetBlockedMessage(block),
    });

  it.each(['structured', 'string', 'buffer'])('classifies a %s budget refusal as confirmed non-submission', shape => {
    expect(rerunMainCancelledRun(123, { exec: () => { throw budgetError(shape); } }))
      .toMatchObject({ ok: false, uncertain: false });
  });

  it.each(['structured', 'string', 'buffer'])('rolls back a %s refusal thrown by an injected rerunner', shape => {
    const f = fixture();
    f.options.rerun.mockImplementationOnce(() => { throw budgetError(shape); });
    expect(f.tick().applied[0].ok).toBe(false);
    expect(f.record()).toEqual({});
    expect(f.options.emitEvent).not.toHaveBeenCalled();
    expect(f.tick().applied[0].ok).toBe(true);
    expect(f.options.rerun).toHaveBeenCalledTimes(2);
  });

  it.each(['API rate limit exceeded', 'call not sent', 'gh-throttle: GitHub core API rate limit exceeded'])
    ('keeps incomplete non-submission evidence uncertain (%s)', stderr => {
      const exec = () => { throw Object.assign(Error('Command failed'), { stderr }); };
      expect(rerunMainCancelledRun(123, { exec }).uncertain).toBe(true);
    });

  it('retries after a real shared core-budget block activates between the history read and rerun POST', () => {
    const root = mkdtempSync(join(tmpdir(), 'main-retrigger-budget-'));
    try {
      const f = fixture();
      let clock = now;
      const reset = now + 60_000;
      const submitted = vi.fn(() => '');
      f.options.readMainRuns.mockImplementationOnce(() => {
        writeBudgetBlock(root, 'app', 'core', { untilMs: reset, nowMs: clock });
        return [run()];
      });
      f.options.rerun = (runId, opts) => rerunMainCancelledRun(runId, { ...opts,
        exec: (_bin, args, execOpts) => runGhSync(args, { ...execOpts, env: { GH_TOKEN: 'ghs_test_budget' },
          throttle: { lockRoot: root, env: {}, now: () => clock, exec: submitted, sleep: () => {}, cap: 4 } }),
      });
      const refused = f.tick();
      expect(refused.applied[0]).toMatchObject({ ok: false, error: expect.stringContaining('call not sent') });
      expect(submitted).not.toHaveBeenCalled();
      expect(f.record()).toEqual({});
      expect(f.options.emitEvent).not.toHaveBeenCalled();
      clock = reset + 1;
      f.options.now = clock;
      expect(f.tick().applied[0].ok).toBe(true);
      expect(submitted).toHaveBeenCalledOnce();
      expect(submitted.mock.calls[0][0]).toEqual(['api', '-X', 'POST', 'repos/web-everything/web-everything/actions/runs/123/rerun']);
      expect(f.record()[sha].reserved).toBeUndefined();
      expect(f.options.emitEvent).toHaveBeenCalledOnce();
      f.tick();
      expect(submitted).toHaveBeenCalledOnce();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('main cancelled CI retrigger: concurrent watchers', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'main-retrigger-'));

  it('gives each repository its own default record file, keeping the legacy name for WE', () => {
    expect(mainRetriggerRecordPath('web-everything/web-everything', '/h')).toBe(join('/h', 'main-ci-retrigger.json'));
    expect(mainRetriggerRecordPath(null, '/h')).toBe(join('/h', 'main-ci-retrigger.json'));
    const other = mainRetriggerRecordPath('web-everything/frontierui', '/h');
    expect(other).not.toBe(join('/h', 'main-ci-retrigger.json'));
    expect(other).toMatch(/main-ci-retrigger[^/]*\.json$/);
  });

  it('serializes the read-modify-write: a second holder is refused while the first runs, then released', () => {
    const root = dir();
    try {
      const path = join(root, 'record.json');
      let inner;
      expect(withMainRetriggerLock(path, () => { inner = withMainRetriggerLock(path, () => 'nested', { waitMs: 0 }); return 'outer'; })).toEqual({ locked: true, value: 'outer' });
      expect(inner).toEqual({ locked: false });
      expect(existsSync(`${path}.lock`)).toBe(false);
      expect(withMainRetriggerLock(path, () => 'again', { waitMs: 0 })).toEqual({ locked: true, value: 'again' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('releases the lock when the critical section throws', () => {
    const root = dir();
    try {
      const path = join(root, 'record.json');
      expect(() => withMainRetriggerLock(path, () => { throw Error('boom'); }, { waitMs: 0 })).toThrow('boom');
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('steals a stale lock left by a crashed holder', () => {
    const root = dir();
    try {
      const path = join(root, 'record.json');
      mkdirSync(root, { recursive: true });
      writeFileSync(`${path}.lock`, '999999');
      const old = new Date(Date.now() - 3_600_000);
      utimesSync(`${path}.lock`, old, old);
      expect(withMainRetriggerLock(path, () => 'ok', { waitMs: 0, staleMs: 60_000 })).toEqual({ locked: true, value: 'ok' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses to act (no rerun) while another watcher holds the record', () => {
    const f = fixture();
    f.options.lock = () => ({ locked: false });
    const result = f.tick();
    expect(result.refusals[0]).toMatchObject({ reason: 'record-locked' });
    expect(f.options.rerun).not.toHaveBeenCalled();
    expect(f.options.writeRecord).not.toHaveBeenCalled();
  });

  it('re-reads the record inside the lock so a concurrent head attempt is not lost', () => {
    const shaB = 'b'.repeat(40);
    let record = {};
    const common = { apply: true, now, recordPath: 'fixture/r.json', rerun: vi.fn(() => ({ ok: true })), emitEvent: vi.fn(),
      readRecord: vi.fn(() => structuredClone(record)), writeRecord: vi.fn((p, v) => { record = structuredClone(v); }) };
    const withLock = fn => ({ locked: true, value: fn() });
    const sweepOptionsLock = (_path, fn) => withLock(fn);
    // Watcher A starts; before its critical section runs, watcher B records head B.
    const a = { ...common, repo: 'web-everything/web-everything', readMainRuns: () => [run()],
      lock: (path, fn) => { record = { [shaB]: { runId: 456, retriggeredAt: new Date(now).toISOString() } }; return sweepOptionsLock(path, fn); } };
    sweepMainCancelledRetrigger(a);
    expect(Object.keys(record).sort()).toEqual([sha, shaB].sort());
  });
});

describe('main cancelled CI retrigger: lock hardening', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'main-retrigger-'));
  const inTemp = body => { const root = dir(); try { body(join(root, 'record.json')); } finally { rmSync(root, { recursive: true, force: true }); } };

  it('does not delete a lock that a newer holder owns after this holder was treated as stale', () => {
    inTemp(path => {
      withMainRetriggerLock(path, () => { writeFileSync(`${path}.lock`, 'newer-holder-token'); }, { waitMs: 0 });
      expect(readFileSync(`${path}.lock`, 'utf8')).toBe('newer-holder-token');
    });
  });

  it('aborts the record write when the lock was lost, so an expired holder cannot clobber the record', () => {
    inTemp(path => {
      const f = fixture();
      f.options.recordPath = path;
      f.options.lock = withMainRetriggerLock;
      f.options.rerun.mockImplementation(() => { writeFileSync(`${path}.lock`, 'newer-holder-token'); return { ok: true }; });
      const result = f.tick();
      expect(result.applied[0]).toMatchObject({ ok: false, error: expect.stringContaining('lock lost') });
      expect(f.record()[sha]).toMatchObject({ reserved: true });
    });
  });

  it.each([
    ['a directory', p => mkdirSync(p)],
    ['a dangling symlink', p => symlinkSync(join(p, 'missing'), p)],
  ])('reclaims %s left at the lock path without spinning', (_name, make) => {
    inTemp(path => {
      make(`${path}.lock`);
      const started = Date.now();
      expect(withMainRetriggerLock(path, () => 'ok', { waitMs: 200, staleMs: -1 })).toEqual({ locked: true, value: 'ok' });
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });

  it('gives up at the deadline when an unreclaimable live-looking lock stays', () => {
    inTemp(path => {
      writeFileSync(`${path}.lock`, 'live');
      const started = Date.now();
      expect(withMainRetriggerLock(path, () => 'no', { waitMs: 150, staleMs: 3_600_000 })).toEqual({ locked: false });
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });

  it('treats a lock stamped far in the future as stale clock skew', () => {
    inTemp(path => {
      writeFileSync(`${path}.lock`, 'skewed');
      const future = new Date(Date.now() + 3_600_000);
      utimesSync(`${path}.lock`, future, future);
      expect(withMainRetriggerLock(path, () => 'ok', { waitMs: 0, staleMs: 60_000 })).toEqual({ locked: true, value: 'ok' });
    });
  });

  it('encodes repository slugs so distinct repositories never share a record file', () => {
    expect(mainRetriggerRecordPath('a/b-c', '/h')).not.toBe(mainRetriggerRecordPath('a-b/c', '/h'));
  });

  it.each([
    ['matching provenance', 'web-everything/frontierui', 'web-everything/frontierui', true],
    ['foreign provenance', 'web-everything/frontierui', 'web-everything/web-everything', false],
    ['missing provenance outside WE', 'web-everything/frontierui', undefined, false],
    ['missing provenance in WE', 'web-everything/web-everything', undefined, true],
    ['matching provenance in WE', 'web-everything/web-everything', 'web-everything/web-everything', true],
    ['default WE repository', null, undefined, true],
    ['WE alias', 'we', undefined, true],
  ])('seeds the pre-split shared record only for its repository: %s', (_name, repo, provenance, inherited) => {
    inTemp(path => {
      writeFileSync(join(dirname(path), 'main-ci-retrigger.json'), JSON.stringify({ [sha]: {
        repo: provenance, runId: 123, retriggeredAt: new Date(now).toISOString(),
      } }));
      const repoPath = mainRetriggerRecordPath(repo, dirname(path));
      const rerun = vi.fn(() => ({ ok: true }));
      const result = sweepMainCancelledRetrigger({ apply: true, now, repo, recordPath: repoPath, rerun,
        readMainRuns: () => [run({ updatedAt: '2026-10-26T12:30:00Z' })], emitEvent: vi.fn() });
      expect(result.applied).toEqual([{ action: inherited ? 'main-ci-stuck' : 'main-ci-retriggered', sha, runId: 123, ok: true }]);
      expect(rerun).toHaveBeenCalledTimes(inherited ? 0 : 1);
    });
  });

  it('does not consume another repository\'s retry for a shared SHA', () => {
    inTemp(path => {
      const rerun = vi.fn(() => ({ ok: true }));
      const repos = [['web-everything/web-everything', 123], ['example/mirror', 456]];
      for (let tick = 0; tick < 3; tick++) {
        for (const [repo, runId] of repos) {
          const result = sweepMainCancelledRetrigger({ apply: true, now, repo, rerun,
            recordPath: mainRetriggerRecordPath(repo, dirname(path)), emitEvent: vi.fn(),
            readMainRuns: () => [run({ databaseId: runId,
              ...(tick > 0 ? { updatedAt: '2026-10-26T12:30:00Z' } : {}),
            })],
          });
          expect(result.refusals).toEqual([]);
          expect(result.applied.map(entry => entry.action)).toEqual(
            tick === 0 ? ['main-ci-retriggered'] : tick === 1 ? ['main-ci-stuck'] : []);
        }
      }
      expect(rerun.mock.calls).toEqual(repos.map(([repo, runId]) => [runId, { repo }]));
      for (const [repo, runId] of repos) {
        const record = JSON.parse(readFileSync(mainRetriggerRecordPath(repo, dirname(path)), 'utf8'));
        expect(record[sha]).toMatchObject({ runId, stuck: true });
      }
    });
  });

  it('does not count a throttle deferral payload as a submitted rerun', () => {
    const exec = () => JSON.stringify({ outcome: 'deferred-low-budget' });
    expect(rerunMainCancelledRun(123, { exec })).toEqual({ ok: false, uncertain: false, error: expect.stringContaining('deferred') });
  });
});
