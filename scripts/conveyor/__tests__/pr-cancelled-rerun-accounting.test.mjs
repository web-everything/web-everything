import { describe, expect, it, vi } from 'vitest';
import { sweepPrCancelledRerun, formatPrCancelledReport } from '../pr-cancelled-rerun.mjs';
import * as watcher from '../ci-red-recovery-watch.mjs';
const { main } = watcher;

const repo = 'web-everything/web-everything';
const sha = 'a'.repeat(40);
const date = '2026-10-26T12:00:00.000Z';
const key = (number = 42, head = sha) => `${repo}#${number}@${head}`;
const attempt = (runId = 123, extra = {}) => ({ runId, retriggeredAt: date, ...extra });
const run = (workflowName = 'CI', databaseId = 123, headSha = sha) => ({
  workflowName, databaseId, headSha, headBranch: 'lane/test', status: 'completed', conclusion: 'cancelled',
  createdAt: date, updatedAt: date,
});
const pr = (number = 42, headRefOid = sha, workflows = ['CI']) => ({
  number, headRefOid, headRefName: 'lane/test', baseRefName: 'main',
  statusCheckRollup: workflows.map(workflowName => ({ name: workflowName, workflowName,
    __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'CANCELLED', startedAt: date, completedAt: date })),
});
function fixture({ initial = {}, prs = [pr()], runs = [run()], checks = ['CI'] } = {}) {
  let record = structuredClone(initial);
  const options = {
    repo, apply: true, now: Date.parse(date), requiredChecks: checks, recordPath: 'fixture/pr-cancelled.json',
    readOpenPrs: vi.fn(() => prs), readRuns: vi.fn(() => runs), readJobs: vi.fn(() => []),
    readRecord: vi.fn(() => structuredClone(record)),
    writeRecord: vi.fn((_path, value) => { record = structuredClone(value); }),
    lock: (_path, fn) => ({ locked: true, value: fn() }), rerunFailed: vi.fn(() => ({ ok: true })), emitEvent: vi.fn(),
  };
  return { options, prs, runs, tick: () => sweepPrCancelledRerun(options), record: () => structuredClone(record) };
}

describe('PR cancelled durable accounting regressions', () => {

  it.each([true, false].flatMap(apply => [
    `https://github.com/${repo}/actions/runs/123oops`,
    `https://github.com/${repo}/actions/runs/123/job/1oops`,
    `https://github.com/${repo}/actions/runs/123/extra`,
    `https://github.com/${repo}/actions/runs/123/job/1/extra`,
    `https://github.com/${repo}/actions/runs/123//`,
    `http://github.com/${repo}/actions/runs/123`,
    `https://example.com/${repo}/actions/runs/123`,
    `https://github.com.example.com/${repo}/actions/runs/123`,
    `https://github.com:444/${repo}/actions/runs/123`,
    'https://github.com/other/web-everything/actions/runs/123',
    'https://github.com/web-everything/other/actions/runs/123',
    `https://github.com/prefix/${repo}/actions/runs/123`,
    `https://github.com/${repo}/actions/runs/123?job=1`,
    `https://github.com/${repo}/actions/runs/123#job`,
    `/${repo}/actions/runs/123`,
    'not a URL',
  ].map(detailsUrl => ({ apply, detailsUrl }))))(
    'refuses unresolvable check URLs without consuming an attempt (apply: $apply, URL: $detailsUrl)',
    ({ apply, detailsUrl }) => {
      const head = pr();
      head.statusCheckRollup[0].detailsUrl = detailsUrl;
      const f = fixture({ prs: [head] });
      f.options.apply = apply;
      expect(f.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [
        expect.objectContaining({ reason: 'attribution-contradiction', error: expect.stringContaining('retry next tick') }),
      ] });
      expect(f.options.readJobs).not.toHaveBeenCalled();
      expect(f.options.writeRecord).not.toHaveBeenCalled();
      expect(f.options.rerunFailed).not.toHaveBeenCalled();
      expect(f.options.emitEvent).not.toHaveBeenCalled();
      expect(f.record()).toEqual({});
    },
  );

  it.each([
    `https://github.com/${repo}/actions/runs/123`,
    `https://github.com/${repo}/actions/runs/123/`,
    `https://github.com/${repo}/actions/runs/123/job/1`,
    `https://github.com/${repo}/actions/runs/123/job/1/`,
    `https://github.com/${repo.toUpperCase()}/actions/runs/123`,
  ])('resolves an exact same-repository run or job URL without workflowName: %s', detailsUrl => {
    const head = pr();
    delete head.statusCheckRollup[0].workflowName;
    head.statusCheckRollup[0].detailsUrl = detailsUrl;
    const f = fixture({ prs: [head] });
    f.options.repo = repo.toUpperCase();
    expect(f.tick()).toMatchObject({
      dispatch: [expect.objectContaining({ runId: 123 })],
      applied: [expect.objectContaining({ runId: 123, ok: true })], refusals: [],
    });
    expect(f.options.rerunFailed).toHaveBeenCalledTimes(1);
    expect(f.options.rerunFailed).toHaveBeenCalledWith(123, { repo: repo.toUpperCase() });
  });

  it.each([true, false].flatMap(apply => [undefined, 'https://github.com/web-everything/web-everything/actions/runs/unknown'].flatMap(detailsUrl =>
    ['older', 'tied', 'newer'].map(age => ({ apply, detailsUrl, age })))))(
    'refuses ambiguous cancellation attribution without a resolvable run ID (apply: $apply, URL: $detailsUrl, second run: $age)',
    ({ apply, detailsUrl, age }) => {
      const head = pr();
      if (detailsUrl !== undefined) head.statusCheckRollup[0].detailsUrl = detailsUrl;
      const second = { ...run('CI', 124), createdAt: age === 'older' ? '2026-10-26T11:00:00Z'
        : age === 'newer' ? '2026-10-26T13:00:00Z' : date };
      const f = fixture({ prs: [head], runs: [second, run()] });
      f.options.apply = apply;
      expect(f.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [
        expect.objectContaining({ reason: 'attribution-contradiction', error: expect.stringContaining('retry next tick') }),
      ] });
      expect(f.options.readJobs).not.toHaveBeenCalled();
      expect(f.options.writeRecord).not.toHaveBeenCalled();
      expect(f.options.rerunFailed).not.toHaveBeenCalled();
      expect(f.options.emitEvent).not.toHaveBeenCalled();
      expect(f.record()).toEqual({});
    },
  );

  it.each([true, false].flatMap(apply => [false, true].flatMap(tied =>
    [false, true].map(omitWorkflow => ({ apply, tied, omitWorkflow })))))(
    'refuses a newer cancelled same-workflow run without submitting either run (apply: $apply, tied: $tied, omit workflow: $omitWorkflow)', ({ apply, tied, omitWorkflow }) => {
      const head = pr();
      head.statusCheckRollup[0].detailsUrl = 'https://github.com/web-everything/web-everything/actions/runs/123/job/1';
      if (omitWorkflow) delete head.statusCheckRollup[0].workflowName;
      const f = fixture({ prs: [head], runs: [run(), { ...run('CI', 124),
        createdAt: tied ? date : '2026-10-26T12:01:00Z' }] });
      f.options.apply = apply;
      expect(f.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [
        expect.objectContaining({ reason: 'later-run-exists' }),
      ] });
      expect(f.options.readJobs).not.toHaveBeenCalled();
      expect(f.options.writeRecord).not.toHaveBeenCalled();
      expect(f.options.rerunFailed).not.toHaveBeenCalled();
      expect(f.record()).toEqual({});
    },
  );

  it.each([true, false].flatMap(apply => ['missing', 'different-workflow'].map(evidence => ({ apply, evidence }))))(
    'refuses contradictory check attribution ($evidence, apply: $apply)', ({ apply, evidence }) => {
      const head = pr();
      head.statusCheckRollup[0].detailsUrl = 'https://github.com/web-everything/web-everything/actions/runs/999/job/1';
      const f = fixture({ prs: [head], runs: evidence === 'missing' ? [run()] : [run(), run('Other', 999)] });
      f.options.apply = apply;
      expect(f.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [
        expect.objectContaining({ reason: 'attribution-contradiction' }),
      ] });
      expect(f.options.readJobs).not.toHaveBeenCalled();
      expect(f.options.writeRecord).not.toHaveBeenCalled();
      expect(f.options.rerunFailed).not.toHaveBeenCalled();
      expect(f.record()).toEqual({});
    },
  );

  it('includes the PR base branch in the shared discovery snapshot for the cancelled pass', () => {
    const readOpenPrs = vi.fn(() => []);
    watcher.sweepCiRedRecovery({ repo, readOpenPrs, exhaustedRetrySettings: { enabled: false }, readPriority: () => null });
    expect(readOpenPrs).toHaveBeenCalledWith({ repo, extraFields: expect.arrayContaining(['baseRefName']) });
  });

  it('reruns a URL-attributed cancelled check without workflowName', () => {
    const head = pr();
    delete head.statusCheckRollup[0].workflowName;
    head.statusCheckRollup[0].detailsUrl = 'https://github.com/web-everything/web-everything/actions/runs/123/job/1';
    const f = fixture({ prs: [head] });
    expect(f.tick()).toMatchObject({
      dispatch: [expect.objectContaining({ runId: 123 })],
      applied: [expect.objectContaining({ runId: 123, ok: true })], refusals: [],
    });
    expect(f.options.rerunFailed).toHaveBeenCalledOnce();
    expect(f.options.rerunFailed).toHaveBeenCalledWith(123, { repo });
    expect(f.record()[key()].workflows).toEqual({ CI: attempt(123) });
  });

  it('refuses a missing URL-attributed run even without workflowName', () => {
    const head = pr();
    delete head.statusCheckRollup[0].workflowName;
    head.statusCheckRollup[0].detailsUrl = 'https://github.com/web-everything/web-everything/actions/runs/999/job/1';
    const f = fixture({ prs: [head] });
    expect(f.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [
      expect.objectContaining({ reason: 'attribution-contradiction' }),
    ] });
    expect(f.options.readJobs).not.toHaveBeenCalled();
    expect(f.options.writeRecord).not.toHaveBeenCalled();
    expect(f.options.rerunFailed).not.toHaveBeenCalled();
    expect(f.record()).toEqual({});
  });

  it('reruns exactly the attributed newest workflow run', () => {
    const head = pr();
    head.statusCheckRollup[0].detailsUrl = 'https://github.com/web-everything/web-everything/actions/runs/124/job/1';
    const f = fixture({ prs: [head], runs: [run(), { ...run('CI', 124), createdAt: '2026-10-26T12:01:00Z' }] });
    expect(f.tick().dispatch.map(d => d.runId)).toEqual([124]);
    expect(f.options.rerunFailed).toHaveBeenCalledOnce();
    expect(f.options.rerunFailed).toHaveBeenCalledWith(124, { repo });
  });

  it('reads each PR base branch live instead of applying the main required set', () => {
    const first = { ...pr(), baseRefName: 'release/1.0' };
    const second = { ...pr(43, 'b'.repeat(40), ['CD']), baseRefName: 'stack/topic' };
    const f = fixture({ prs: [first, second], runs: [run(), run('CD', 124, 'b'.repeat(40))] });
    delete f.options.requiredChecks;
    const readRequiredChecks = vi.fn(({ branch }) => ({ source: 'live', checks: branch === 'release/1.0' ? ['CI'] : ['CD'] }));
    f.options.readRequiredChecks = args => watcher.readLiveRequiredChecks({ ...args, readRequiredChecks });
    expect(f.tick().dispatch.map(d => d.runId)).toEqual([123, 124]);
    expect(readRequiredChecks.mock.calls.map(([args]) => args)).toEqual([
      { repo, branch: 'release/1.0', ttlMs: 0 }, { repo, branch: 'stack/topic', ttlMs: 0 },
    ]);
  });

  it.each([undefined, null, '', 'topic;command', 'topic name', 'topic\nmain', 42])(
    'refuses missing or unsafe PR base %j before reading required settings', baseRefName => {
      const f = fixture({ prs: [{ ...pr(), baseRefName }] });
      f.options.readRequiredChecks = vi.fn(() => ['CI']);
      expect(f.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [
        expect.objectContaining({ reason: 'required-set-unreadable', error: expect.stringContaining('retry next tick') }),
      ] });
      expect(f.options.readRequiredChecks).not.toHaveBeenCalled();
      expect(f.options.readRuns).not.toHaveBeenCalled();
      expect(f.options.writeRecord).not.toHaveBeenCalled();
      expect(f.options.rerunFailed).not.toHaveBeenCalled();
    },
  );

  it.each(['fallback', 'declared', 'stale-cache', 'cache', 'unavailable', 'mystery', undefined])(
    'refuses required-check provenance %s without reserving any workflow', source => {
      const f = fixture();
      delete f.options.requiredChecks;
      const readRequiredChecks = vi.fn(() => ({ checks: ['CI'], source }));
      f.options.readRequiredChecks = args => watcher.readLiveRequiredChecks({ ...args, readRequiredChecks });
      expect(f.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [{ reason: 'required-set-unreadable' }] });
      expect(readRequiredChecks).toHaveBeenCalledWith({ repo, branch: 'main', ttlMs: 0 });
      expect(f.options.readRuns).not.toHaveBeenCalled();
      expect(f.options.writeRecord).not.toHaveBeenCalled();
      expect(f.options.rerunFailed).not.toHaveBeenCalled();
    },
  );

  it('accepts only a live required set and forces a fresh shared-helper read', () => {
    const readRequiredChecks = vi.fn(() => ({ checks: ['CI', 'CD'], source: 'live' }));
    expect(watcher.readLiveRequiredChecks({ repo, branch: 'release', readRequiredChecks })).toEqual(['CI', 'CD']);
    expect(readRequiredChecks).toHaveBeenCalledWith({ repo, branch: 'release', ttlMs: 0 });
  });

  it.each([null, {}, { source: 'live', checks: [] }, { source: 'live', checks: ['CI', null] }])(
    'rejects incomplete live required evidence %j', result => {
      expect(watcher.readLiveRequiredChecks({ repo, readRequiredChecks: () => result })).toBeNull();
    },
  );

  it('returns unknown when the live required read throws', () => {
    expect(watcher.readLiveRequiredChecks({ repo, readRequiredChecks: () => { throw Error('offline'); } })).toBeNull();
  });

  it.each([
    ...['failure', 'timed_out', 'startup_failure', 'action_required', 'error'].map(conclusion =>
      ({ status: 'completed', conclusion, reason: 'real-failure-in-run' })),
    ...['mystery', 'stale', null, '', 1].map(conclusion =>
      ({ status: 'completed', conclusion, reason: 'run-history-contradicts-rollup' })),
    { status: 'mystery', conclusion: 'success', reason: 'run-history-contradicts-rollup' },
    { status: null, conclusion: 'success', reason: 'run-history-contradicts-rollup' },
  ].flatMap(evidence => ['CI', 'CD', 'Unrequired'].flatMap(workflowName =>
    [true, false].map(apply => ({ ...evidence, workflowName, apply }))))) (
    'refuses the whole head for historical $workflowName $status/$conclusion (apply: $apply)',
    ({ status, conclusion, reason, workflowName, apply }) => {
      const f = fixture({ prs: [pr(42, sha, ['CI', 'CD'])], checks: ['CI', 'CD'], runs: [
        run(), run('CD', 124),
        { ...run(workflowName, 120), status, conclusion, createdAt: '2026-10-26T10:00:00Z' },
        { ...run(workflowName, 121), conclusion: 'success', createdAt: '2026-10-26T11:00:00Z' },
      ] });
      f.options.apply = apply;
      expect(f.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [{ reason }] });
      expect(f.options.readJobs).not.toHaveBeenCalled();
      expect(f.options.writeRecord).not.toHaveBeenCalled();
      expect(f.options.rerunFailed).not.toHaveBeenCalled();
      expect(f.options.emitEvent).not.toHaveBeenCalled();
      expect(f.record()).toEqual({});
    },
  );

  it.each(['cancelled', 'success', 'skipped', 'neutral'])(
    'allows harmless historical %s runs superseded by same-workflow success', conclusion => {
      const f = fixture({ runs: [run(),
        { ...run('Other', 120), conclusion, createdAt: '2026-10-26T10:00:00Z' },
        { ...run('Other', 121), conclusion: 'success', createdAt: '2026-10-26T11:00:00Z' },
      ] });
      expect(f.tick().dispatch.map(d => d.runId)).toEqual([123]);
    },
  );

  it.each(['null', 'empty', 'throws'])('refuses an unreadable live required set (%s) without reservation', mode => {
    const f = fixture();
    delete f.options.requiredChecks;
    f.options.readRequiredChecks = vi.fn(() => {
      if (mode === 'throws') throw Error('required checks unavailable');
      return mode === 'null' ? null : [];
    });
    const result = f.tick();
    expect(result).toMatchObject({ dispatch: [], applied: [], refusals: [
      expect.objectContaining({ reason: 'required-set-unreadable', error: expect.stringContaining('retry next tick') }),
    ] });
    expect(f.options.readRequiredChecks).toHaveBeenCalledWith({ repo, branch: 'main' });
    expect(f.record()).toEqual({});
    expect(f.options.readRuns).not.toHaveBeenCalled();
    expect(f.options.readJobs).not.toHaveBeenCalled();
    expect(f.options.rerunFailed).not.toHaveBeenCalled();
    expect(f.options.writeRecord).not.toHaveBeenCalled();
    expect(f.options.emitEvent).not.toHaveBeenCalled();
  });

  it('uses the live required set when no explicit set is injected', () => {
    const f = fixture();
    delete f.options.requiredChecks;
    f.options.readRequiredChecks = vi.fn(() => ['CI']);
    expect(f.tick().dispatch.map(d => d.runId)).toEqual([123]);
    expect(f.options.readRequiredChecks).toHaveBeenCalledWith({ repo, branch: 'main' });
  });

  it('honours an explicit required set without consulting the live reader', () => {
    const f = fixture();
    f.options.readRequiredChecks = vi.fn(() => { throw Error('must not read'); });
    expect(f.tick().dispatch.map(d => d.runId)).toEqual([123]);
    expect(f.options.readRequiredChecks).not.toHaveBeenCalled();
  });

  it.each([undefined, ['CI']])('does not reuse main-red fallback checks in the cancelled CLI pass (explicit: %j)', async requiredChecks => {
    const pass = () => vi.fn(() => ({ dispatch: [], applied: [], refusals: [] }));
    const sweepPrCancelled = pass();
    await main(['sweep', '--json'], {
      sweepOptions: { exhaustedRetrySettings: {}, ...(requiredChecks ? { requiredChecks } : {}) },
      sweepMainRed: vi.fn(() => ({ dispatch: [], applied: [], refusals: [], requiredChecks: ['fallback'] })),
      sweepExhausted: pass(), sweepHung: pass(), sweepMissingRun: pass(), sweepMainCancelled: pass(),
      sweepPrCancelled, writeAll: vi.fn(), writeLine: vi.fn(),
    });
    expect(sweepPrCancelled).toHaveBeenCalledOnce();
    expect(sweepPrCancelled.mock.calls[0][0].requiredChecks).toBeUndefined();
    expect(sweepPrCancelled.mock.calls[0][0].readRequiredChecks).toBe(watcher.readLiveRequiredChecks);
  });

  it('never reruns an unchanged head under eviction pressure from more than 500 other attempts', () => {
    const f = fixture({ prs: [pr(), pr(43, 'b'.repeat(40))], runs: [run(), run('CI', 200, 'b'.repeat(40))] });
    f.tick();
    for (let i = 0; i < 505; i++) {
      const nextSha = (i + 10).toString(16).padStart(40, '0');
      f.prs[1] = pr(43, nextSha);
      f.runs[1] = run('CI', 201 + i, nextSha);
      const result = f.tick();
      if (i < 498) expect(result.dispatch.map(d => d.pr)).toEqual([43]);
      else {
        expect(result.dispatch).toEqual([]);
        expect(result.refusals).toContainEqual(expect.objectContaining({ reason: 'record-full' }));
      }
      expect(f.record()[key()]).toBeDefined();
      expect(Object.keys(f.record()).length).toBeLessThanOrEqual(500);
    }
    expect(f.options.rerunFailed.mock.calls.filter(([id]) => id === 123)).toHaveLength(1);
    expect(f.options.rerunFailed).toHaveBeenCalledTimes(500);
    expect(f.tick().dispatch).toEqual([]);
    const restarted = fixture({ initial: f.record(), prs: f.prs, runs: f.runs });
    expect(restarted.tick().dispatch).toEqual([]);
    expect(restarted.options.rerunFailed).not.toHaveBeenCalled();
  });

  it.each([500, 501])('fails closed under %i protected records instead of evicting heads absent from the snapshot', count => {
    const initial = Object.fromEntries(Array.from({ length: count }, (_, i) => [key(100 + i), attempt(500 + i)]));
    const f = fixture({ initial });
    const result = f.tick();
    expect(result.refusals).toContainEqual(expect.objectContaining({ reason: 'record-full', error: expect.stringContaining('archive/trim the record file') }));
    expect(result.dispatch).toEqual([]);
    expect(f.record()).toEqual(initial);
    expect(f.options.writeRecord).not.toHaveBeenCalled();
    expect(f.options.rerunFailed).not.toHaveBeenCalled();
  });

  it('preserves a consumed head when an open PR advances at capacity and restores it after restart', () => {
    const initial = Object.fromEntries(Array.from({ length: 499 }, (_, i) => [key(100 + i), attempt(500 + i)]));
    const f = fixture({ initial });
    expect(f.tick().dispatch.map(d => d.runId)).toEqual([123]);
    const consumed = f.record();
    f.prs[0] = pr(42, 'b'.repeat(40));
    f.runs[0] = run('CI', 124, 'b'.repeat(40));
    const advanced = f.tick();
    expect(advanced.dispatch).toEqual([]);
    expect(advanced.refusals).toContainEqual(expect.objectContaining({ reason: 'record-full' }));
    expect(formatPrCancelledReport(advanced)).toContain('archive/trim the record file');
    expect(f.record()).toEqual(consumed);
    const restored = fixture({ initial: f.record() });
    expect(restored.tick().refusals).toContainEqual(expect.objectContaining({ reason: 'already-rerun' }));
    expect(restored.options.rerunFailed).not.toHaveBeenCalled();
    expect(restored.options.writeRecord).not.toHaveBeenCalled();
  });

  it.each([
    ['CLOSED', false], ['CLOSED', true], ['MERGED', false], ['MERGED', true],
  ])('never evicts %s PR heads (reserved: %s), even with an observed different head', (state, reserved) => {
    const initial = Object.fromEntries(Array.from({ length: 499 }, (_, i) =>
      [key(100 + i), { ...attempt(500 + i), reserved }]));
    const closedPrs = Array.from({ length: 499 }, (_, i) =>
      ({ ...pr(100 + i, 'b'.repeat(40)), state }));
    const f = fixture({ initial, prs: [pr(42), ...closedPrs] });
    expect(f.tick().dispatch.map(d => d.runId)).toEqual([123]);
    expect(f.record()).toMatchObject(initial);
    expect(Object.keys(f.record())).toHaveLength(500);

    const restored = fixture({ initial: f.record(), prs: [pr(100)], runs: [run('CI', 500)] });
    expect(restored.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [
      expect.objectContaining({ reason: reserved ? 'rerun-outcome-unknown' : 'already-rerun' }),
    ] });
    expect(restored.options.writeRecord).not.toHaveBeenCalled();
    expect(restored.options.rerunFailed).not.toHaveBeenCalled();

    const full = fixture({ initial: f.record(), prs: [pr(43), ...closedPrs] });
    const result = full.tick();
    expect(result).toMatchObject({ dispatch: [], applied: [], refusals: [
      expect.objectContaining({ reason: 'record-full' }),
    ] });
    expect(formatPrCancelledReport(result)).toContain('archive/trim the record file');
    expect(full.record()).toEqual(f.record());
    expect(full.options.writeRecord).not.toHaveBeenCalled();
    expect(full.options.rerunFailed).not.toHaveBeenCalled();
  });

  it.each([
    ['STALE', { status: 'COMPLETED', conclusion: 'STALE' }],
    ['unknown conclusion', { status: 'COMPLETED', conclusion: 'MYSTERY' }],
    ['completed null conclusion', { status: 'COMPLETED', conclusion: null }],
    ['missing conclusion', { status: 'COMPLETED' }],
    ['nonstring conclusion', { status: 'COMPLETED', conclusion: 1 }],
    ['missing status', { conclusion: 'SUCCESS' }],
    ['nonstring status', { status: 1, conclusion: 'SUCCESS' }],
    ['unknown status', { status: 'MYSTERY', conclusion: 'SUCCESS' }],
  ])('refuses unreadable required evidence (%s) mixed with cancellation without reservation', (_name, row) => {
    const head = pr();
    head.statusCheckRollup.push({ name: 'test', __typename: 'CheckRun', ...row });
    const f = fixture({ prs: [head], checks: ['CI', 'test'] });
    expect(f.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [
      expect.objectContaining({ reason: 'required-evidence-unreadable' }),
    ] });
    expect(f.record()).toEqual({});
    expect(f.options.readRuns).not.toHaveBeenCalled();
    expect(f.options.rerunFailed).not.toHaveBeenCalled();
    expect(f.options.writeRecord).not.toHaveBeenCalled();
    expect(f.options.emitEvent).not.toHaveBeenCalled();
  });

  it.each(['SUCCESS', 'SKIPPED', 'NEUTRAL'])(
    'accepts completed required %s evidence mixed with cancellation', conclusion => {
      const head = pr();
      head.statusCheckRollup.push({ name: 'test', __typename: 'CheckRun', status: 'COMPLETED', conclusion });
      const f = fixture({ prs: [head], checks: ['CI', 'test'] });
      expect(f.tick().dispatch.map(d => d.runId)).toEqual([123]);
      expect(f.options.rerunFailed).toHaveBeenCalledOnce();
    },
  );

  // Replaces acceptance of pending evidence followed by a run-history-only refusal.
  it.each(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING'].flatMap(status =>
    [false, true].map(laterRun => ({ status, laterRun }))))(
    'refuses pending required $status evidence without reservation (later run listed: $laterRun)', ({ status, laterRun }) => {
      const head = pr();
      head.statusCheckRollup.push({ name: 'test', __typename: 'CheckRun', status, conclusion: null });
      const pendingRun = { ...run('CI', 124), status: 'in_progress', conclusion: null };
      const f = fixture({ prs: [head], checks: ['CI', 'test'], runs: laterRun ? [run(), pendingRun] : [run()] });
      expect(f.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [
        expect.objectContaining({ reason: 'required-pending' }),
      ] });
      expect(f.record()).toEqual({});
      expect(f.options.readRuns).not.toHaveBeenCalled();
      expect(f.options.readJobs).not.toHaveBeenCalled();
      expect(f.options.rerunFailed).not.toHaveBeenCalled();
      expect(f.options.writeRecord).not.toHaveBeenCalled();
      expect(f.options.emitEvent).not.toHaveBeenCalled();
    },
  );

  it.each(['failure', 'timed_out', 'error', 'startup_failure', 'action_required', 'stale'])(
    'refuses a cancelled run containing a real %s job without reservation', conclusion => {
      const f = fixture();
      f.options.readJobs.mockReturnValue([
        { status: 'completed', conclusion: 'cancelled' },
        { status: 'completed', conclusion },
      ]);
      expect(f.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [{ reason: 'real-failure-in-run' }] });
      expect(f.record()).toEqual({});
      expect(f.options.rerunFailed).not.toHaveBeenCalled();
      expect(f.options.writeRecord).not.toHaveBeenCalled();
      expect(f.options.emitEvent).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['null entry', [null]], ['string entry', ['cancelled']], ['array entry', [[]]],
    ['missing status', [{ conclusion: 'cancelled' }]],
    ['nonstring status', [{ status: 1, conclusion: 'cancelled' }]],
    ['missing conclusion', [{ status: 'completed' }]],
    ['nonstring conclusion', [{ status: 'completed', conclusion: 1 }]],
    ['completed null conclusion', [{ status: 'completed', conclusion: null }]],
    ['pending missing conclusion', [{ status: 'queued' }]],
    ['queued null conclusion', [{ status: 'queued', conclusion: null }]],
    ['in progress', [{ status: 'in_progress', conclusion: null }]],
    ['in progress with acceptable conclusion', [{ status: 'in_progress', conclusion: 'success' }]],
    ['unknown status', [{ status: 'mystery', conclusion: 'cancelled' }]],
    ['unknown conclusion', [{ status: 'completed', conclusion: 'mystery' }]],
    ['empty conclusion', [{ status: 'completed', conclusion: '' }]],
    ['nonarray', {}], ['null response', null], ['throws', undefined],
  ])('refuses unreadable job evidence (%s) without reservation', (_name, jobs) => {
    const f = fixture();
    f.options.readJobs.mockImplementation(() => {
      if (jobs === undefined) throw Error('job read failed');
      return Array.isArray(jobs) ? [{ status: 'completed', conclusion: 'cancelled' }, ...jobs] : jobs;
    });
    expect(f.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [{ reason: 'jobs-unreadable' }] });
    expect(f.record()).toEqual({});
    expect(f.options.rerunFailed).not.toHaveBeenCalled();
    expect(f.options.writeRecord).not.toHaveBeenCalled();
    expect(f.options.emitEvent).not.toHaveBeenCalled();
  });

  it.each(['success', 'skipped', 'neutral', 'cancelled'])(
    'accepts only completed whitelisted %s job evidence', conclusion => {
    const f = fixture();
    f.options.readJobs.mockReturnValue([{ status: 'completed', conclusion }]);
    expect(f.tick().dispatch.map(d => d.runId)).toEqual([123]);
    expect(f.options.rerunFailed).toHaveBeenCalledOnce();
  });

  it.each([
    ['real failure', [{ status: 'completed', conclusion: 'failure' }], 'real-failure-in-run'],
    ['unknown conclusion', [{ status: 'completed', conclusion: 'mystery' }], 'jobs-unreadable'],
    ['pending job', [{ status: 'queued', conclusion: null }], 'jobs-unreadable'],
    ['unreadable jobs', null, 'jobs-unreadable'],
    ['job read throws', undefined, 'jobs-unreadable'],
  ].flatMap(([name, jobs, reason]) => [true, false].map(apply => ({ name, jobs, reason, apply }))))(
    'preflights the whole head before any dispatch when CD has $name (apply: $apply)', ({ jobs, reason, apply }) => {
      const f = fixture({ prs: [pr(42, sha, ['CI', 'CD'])], runs: [run(), run('CD', 124)], checks: ['CI', 'CD'] });
      f.options.apply = apply;
      f.options.readJobs.mockImplementation(id => {
        expect(f.options.writeRecord).not.toHaveBeenCalled();
        expect(f.options.rerunFailed).not.toHaveBeenCalled();
        if (id === 123) return [{ status: 'completed', conclusion: 'cancelled' }];
        if (jobs === undefined) throw Error('CD jobs unavailable');
        return jobs;
      });
      expect(f.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [{ reason }] });
      expect(f.options.readJobs.mock.calls.map(([id]) => id)).toEqual([123, 124]);
      expect(f.record()).toEqual({});
      expect(f.options.writeRecord).not.toHaveBeenCalled();
      expect(f.options.rerunFailed).not.toHaveBeenCalled();
      expect(f.options.emitEvent).not.toHaveBeenCalled();
    },
  );

  it('reserves and reruns both cancelled workflows once, deduplicates their checks, and remembers both after restart', () => {
    const f = fixture({ prs: [pr(42, sha, ['CI', 'CD', 'CD'])], runs: [run(), run('CD', 124)], checks: ['CI', 'CD'] });
    f.options.rerunFailed.mockImplementation(id => {
      expect(f.options.readJobs.mock.calls.map(([runId]) => runId)).toEqual([123, 124]);
      const workflow = id === 123 ? 'CI' : 'CD';
      expect(f.record()[key()].workflows[workflow]).toMatchObject({ runId: id, reserved: true });
      return { ok: true };
    });
    expect(f.tick().dispatch.map(d => d.runId)).toEqual([123, 124]);
    expect(f.record()[key()].workflows).toEqual({ CI: attempt(), CD: attempt(124) });
    expect(f.options.emitEvent).toHaveBeenCalledTimes(2);
    expect(f.tick().dispatch).toEqual([]);
    expect(f.options.rerunFailed).toHaveBeenCalledTimes(2);
    const restarted = fixture({ initial: f.record(), prs: f.prs, runs: f.runs, checks: ['CI', 'CD'] });
    expect(restarted.tick().dispatch).toEqual([]);
    expect(restarted.options.rerunFailed).not.toHaveBeenCalled();
  });

  it('refuses the whole head when its workflows exceed the tick budget, then recovers with sufficient budget', () => {
    const f = fixture({ prs: [pr(42, sha, ['CI', 'CD'])], runs: [run(), run('CD', 124)], checks: ['CI', 'CD'] });
    f.options.maxPerTick = 1;
    expect(f.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [
      expect.objectContaining({ reason: 'tick-cap', error: expect.stringContaining('retry next tick') }),
    ] });
    expect(f.record()).toEqual({});
    expect(f.options.writeRecord).not.toHaveBeenCalled();
    expect(f.options.rerunFailed).not.toHaveBeenCalled();
    f.options.maxPerTick = 2;
    expect(f.tick().dispatch.map(d => d.runId)).toEqual([123, 124]);
    expect(f.tick().dispatch).toEqual([]);
    expect(f.options.rerunFailed).toHaveBeenCalledTimes(2);
  });

  it('keeps one uncertain workflow reserved while independently recovering the other workflow', () => {
    const f = fixture({ prs: [pr(42, sha, ['CI', 'CD'])], runs: [run(), run('CD', 124)], checks: ['CI', 'CD'] });
    f.options.rerunFailed.mockReturnValueOnce({ ok: false, uncertain: true, error: 'acknowledgement lost' });
    const result = f.tick();
    expect(result.applied.map(a => [a.runId, a.ok])).toEqual([[123, false], [124, true]]);
    expect(f.record()[key()].workflows.CI.reserved).toBe(true);
    expect(f.record()[key()].workflows.CD.reserved).toBeUndefined();
    const lines = formatPrCancelledReport(result).split('\n');
    expect(lines[0]).toMatch(/^✗.*123/);
    expect(lines[1]).toMatch(/^✓.*124/);
    expect(f.tick().refusals.map(r => r.reason)).toContain('rerun-outcome-unknown');
    expect(f.options.rerunFailed).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('refuses the whole head when a legacy workflow was already attempted (reserved: %s)', reserved => {
    const initial = { [key()]: attempt(123, { reserved }) };
    const f = fixture({ initial, prs: [pr(42, sha, ['CD', 'CI'])],
      runs: [run(), run('CD', 124)], checks: ['CI', 'CD'] });
    expect(f.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [
      expect.objectContaining({ reason: reserved ? 'rerun-outcome-unknown' : 'already-rerun' }),
    ] });
    expect(f.record()).toEqual(initial);
    expect(f.options.writeRecord).not.toHaveBeenCalled();
    expect(f.options.rerunFailed).not.toHaveBeenCalled();
  });

  it('fails closed when a legacy attempt cannot be attributed to observed workflow history', () => {
    const f = fixture({ initial: { [key()]: attempt(999) } });
    expect(f.tick().refusals).toContainEqual(expect.objectContaining({ reason: 'record-workflow-unknown' }));
    expect(f.options.rerunFailed).not.toHaveBeenCalled();
    expect(f.options.writeRecord).not.toHaveBeenCalled();
  });

  it.each([true, false, undefined].flatMap(reserved => [42, 43].map(number => ({ reserved, number }))))(
    'refuses the whole record when PR $number top-level run is absent from workflows (reserved: $reserved)',
    ({ reserved, number }) => {
      const initial = { [key(number)]: { ...attempt(123, { reserved }), workflows: { CD: attempt(124) } } };
      const f = fixture({ initial });
      expect(f.tick()).toEqual({ dispatch: [], applied: [], refusals: [
        { reason: 'record-unreadable', error: expect.stringContaining('restore the attempt record or inspect PR CI') },
      ] });
      expect(f.record()).toEqual(initial);
      expect(f.options.readOpenPrs).not.toHaveBeenCalled();
      expect(f.options.readRuns).not.toHaveBeenCalled();
      expect(f.options.readJobs).not.toHaveBeenCalled();
      expect(f.options.rerunFailed).not.toHaveBeenCalled();
      expect(f.options.writeRecord).not.toHaveBeenCalled();
      expect(f.options.emitEvent).not.toHaveBeenCalled();
    },
  );

  it('matches top-level and workflow run IDs across numeric and string representations', () => {
    const f = fixture({ initial: { [key()]: { ...attempt(), workflows: { CI: attempt('123') } } } });
    expect(f.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [
      expect.objectContaining({ reason: 'already-rerun' }),
    ] });
    expect(f.options.rerunFailed).not.toHaveBeenCalled();
    expect(f.options.writeRecord).not.toHaveBeenCalled();
  });

  it('fails closed when a workflows key exists with an undefined value', () => {
    const f = fixture({ initial: { [key()]: { ...attempt(), workflows: undefined } } });
    expect(f.tick()).toMatchObject({ dispatch: [], applied: [], refusals: [
      expect.objectContaining({ reason: 'record-unreadable' }),
    ] });
    expect(f.options.rerunFailed).not.toHaveBeenCalled();
    expect(f.options.writeRecord).not.toHaveBeenCalled();
  });

  it('fails closed on malformed persisted per-workflow accounting', () => {
    const f = fixture({ initial: { [key()]: { ...attempt(), workflows: { CI: {} } } } });
    expect(f.tick().refusals).toContainEqual(expect.objectContaining({ reason: 'record-unreadable' }));
    expect(f.options.rerunFailed).not.toHaveBeenCalled();
    expect(f.options.writeRecord).not.toHaveBeenCalled();
  });
});
