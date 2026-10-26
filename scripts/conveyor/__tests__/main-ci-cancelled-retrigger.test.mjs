import { describe, expect, it, vi } from 'vitest';
import { sweepMainCancelledRetrigger, rerunMainCancelledRun, formatMainCancelledReport, main } from '../ci-red-recovery-watch.mjs';
import { DEFAULT_MAIN_WORKFLOW_NAME } from '../main-red-recovery.mjs';

const sha = 'a'.repeat(40);
const now = Date.parse('2026-10-26T12:00:00Z');
const run = (overrides = {}) => ({ databaseId: 123, headSha: sha, workflowName: DEFAULT_MAIN_WORKFLOW_NAME,
  createdAt: '2026-10-26T11:00:00Z', status: 'completed', conclusion: 'cancelled', ...overrides });

function fixture(runs = [run()], initial = {}) {
  let record = structuredClone(initial);
  const options = { apply: true, now, repo: 'web-everything/web-everything', recordPath: 'fixture/main-ci-retrigger.json',
    readMainRuns: vi.fn(() => runs), rerun: vi.fn(() => ({ ok: true })),
    readRecord: vi.fn(() => structuredClone(record)),
    writeRecord: vi.fn((path, value) => { record = structuredClone(value); }), emitEvent: vi.fn() };
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
      sweepMainCancelled: pass('main-cancelled'), writeAll: vi.fn(), writeLine: vi.fn() } };
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
