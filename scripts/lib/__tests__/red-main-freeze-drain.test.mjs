import { describe, it, expect, vi } from 'vitest';
import { evaluateDrainFreeze, prepareDrainFreeze, resolveDrainFreezeSettings, drainFreezeSignal } from '../red-main-freeze-shared.mjs';
import { decideRedMainHold } from '../red-main-hold.mjs';

const manual = { reason: 'operator\nstop', at: 'today\rnow' };
const clear = { frozen: false };
const priority = { repo: 'we', pr: 7, expiresAt: 100 };
const settings = (values = {}) => Object.fromEntries(Object.entries({ redMainFreezeReader: 'shared-first', redMainUnpublishedFreeze: 'refuse', redMainUnpublishedDequeue: 'on', redMainLocalAutoFreeze: 'fix-exempt', redMainManualFreezeFixPr: 'hold', ...values }).map(([k, value]) => [k, { value, source: 'default' }]));
const evaluate = (o = {}) => evaluateDrainFreeze({ local: null, shared: clear, settings: settings(), ...o });
const decision = (state, num = 7, holdOn = true) => decideRedMainHold({ num, signal: drainFreezeSignal({ state, priority, now: 1, holdOn }) });

describe('A1 shared reader and cascade', () => {
  it('holds shared manual and unreadable, clears only when both clear', () => {
    expect(decision(evaluate({ shared: { frozen: true, reason: 'shared' } })).hold).toBe(true);
    const state = evaluate({ shared: { error: 'fetch\nfailed' } });
    expect(state.reason).toContain('fetch failed');
    expect(decision(state).hold).toBe(true);
    expect(decision(evaluate()).hold).toBe(false);
    expect(decision(evaluate({ shared: { error: 'offline' }, settings: settings({ redMainFreezeReader: 'local-only' }) })).hold).toBe(false);
  });
  it.each([
    ['redMainFreezeReader', 'WE_DRAIN_RED_MAIN_FREEZE_READER', 'shared-first', 'local-only'],
    ['redMainUnpublishedFreeze', 'WE_DRAIN_RED_MAIN_UNPUBLISHED_FREEZE', 'refuse', 'warn'],
    ['redMainUnpublishedDequeue', 'WE_DRAIN_RED_MAIN_UNPUBLISHED_DEQUEUE', 'on', 'off'],
    ['redMainLocalAutoFreeze', 'WE_DRAIN_RED_MAIN_LOCAL_AUTO_FREEZE', 'fix-exempt', 'manual'],
    ['redMainManualFreezeFixPr', 'WE_DRAIN_RED_MAIN_MANUAL_FREEZE_FIX_PR', 'hold', 'exempt'],
  ])('resolves %s through every source', (key, envKey, builtIn, override) => {
    const resolve = (o) => resolveDrainFreezeSettings({ env: {}, tool: {}, platform: {}, ...o })[key];
    expect(resolve({})).toEqual({ value: builtIn, source: 'default' });
    expect(resolve({ platform: { [key]: override } })).toEqual({ value: override, source: 'platform' });
    expect(resolve({ tool: { [key]: override } })).toEqual({ value: override, source: 'settings' });
    expect(resolve({ env: { [envKey]: override }, tool: { [key]: builtIn } })).toEqual({ value: override, source: 'env' });
    expect(resolve({ env: { [envKey]: 'invalid' }, platform: { [key]: override } }).source).toBe('platform');
  });
});

function fixture(o = {}) {
  const log = []; const readShared = vi.fn(() => clear); const publish = vi.fn(async () => ({ ok: false }));
  const exec = vi.fn((bin, args, opts) => {
    expect(bin).toBe('gh'); expect(opts.timeout).toBeGreaterThan(0);
    const query = args[args.indexOf('-f') + 1];
    if (query.includes('mutation')) return JSON.stringify({ data: { dequeuePullRequest: { clientMutationId: null } } });
    return JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes: [7, 8].map(number => ({ pullRequest: { id: `PR_${number}`, number } })), pageInfo: { hasNextPage: false } } } } } });
  });
  return { local: manual, settings: settings(), repo: 'owner/local', branch: 'trunk', enqueues: false, readShared, publish, exec, stderr: s => log.push(s), log, ...o };
}

describe('A2 unpublished manual containment', () => {
  it('warns, retries once, re-reads, holds every PR including fix and names the refusal', async () => {
    const f = fixture(); const s = await prepareDrainFreeze(f);
    expect(f.publish).toHaveBeenCalledTimes(1); expect(f.readShared).toHaveBeenCalledTimes(2);
    expect(f.publish.mock.calls[0][0].setExitCode).toBeTypeOf('function');
    expect(f.log.join('')).toContain("CI's merge-gate cannot see it");
    expect(f.log.join('')).toContain('operator stop');
    expect(s.reason).toContain('unpublished manual freeze');
    expect(decision(s, 7).hold).toBe(true); expect(decision(s, 8).hold).toBe(true);
    expect(f.exec).not.toHaveBeenCalled();
  });
  it('dequeues each local queued PR and holds every enqueue candidate', async () => {
    const f = fixture({ enqueues: true }); const s = await prepareDrainFreeze(f);
    expect(decision(s, 7).hold).toBe(true); expect(decision(s, 8).hold).toBe(true);
    expect(f.exec).toHaveBeenCalledTimes(3);
    const calls = JSON.stringify(f.exec.mock.calls);
    expect(calls).toContain('mergeQueue'); expect(calls).toContain('trunk'); expect(calls).toContain('owner'); expect(calls).toContain('local');
    expect(calls).toContain('PR_7'); expect(calls).toContain('PR_8'); expect(calls).toContain('dequeuePullRequest');
  });
  it('successful retry restores normal manual hold without dequeue', async () => {
    const f = fixture({ enqueues: true, readShared: vi.fn().mockReturnValueOnce(clear).mockReturnValue({ frozen: true }) });
    const s = await prepareDrainFreeze(f);
    expect(s.unpublished).toBe(false); expect(s.reason).not.toContain('unpublished'); expect(decision(s).hold).toBe(true); expect(f.exec).not.toHaveBeenCalled();
  });
  it.each([{ redMainUnpublishedFreeze: 'warn' }, { redMainUnpublishedDequeue: 'off' }])('respects %j', async values => {
    const f = fixture({ enqueues: true, settings: settings(values) }); const s = await prepareDrainFreeze(f);
    expect(f.publish).toHaveBeenCalledTimes(1); expect(f.exec).not.toHaveBeenCalled(); expect(decision(s).hold).toBe(true);
    if (values.redMainUnpublishedFreeze) expect(s.reason).not.toContain('unpublished');
  });
  it('reports API failure without throwing and retains the hold', async () => {
    const f = fixture({ enqueues: true, exec: () => { throw new Error('API down'); } });
    expect(decision(await prepareDrainFreeze(f)).hold).toBe(true); expect(f.log.join('')).toContain('API down');
  });
  it('dry run reports entries but never publishes or mutates the queue', async () => {
    const f = fixture({ enqueues: true, dryRun: true }); await prepareDrainFreeze(f);
    expect(f.publish).not.toHaveBeenCalled(); expect(f.exec).toHaveBeenCalledTimes(1); expect(f.log.join('')).toContain('would dequeue #7');
  });
  it('unreadable also retries; automatic and local-only never publish', async () => {
    const f = fixture({ readShared: vi.fn(() => ({ error: 'offline' })) }); await prepareDrainFreeze(f); expect(f.publish).toHaveBeenCalledTimes(1);
    for (const override of [{ local: { kind: 'auto' } }, { settings: settings({ redMainFreezeReader: 'local-only' }) }]) {
      const f = fixture(override); await prepareDrainFreeze(f); expect(f.publish).not.toHaveBeenCalled();
    }
  });
});

describe('A3 local marker kinds', () => {
  it.each([{ kind: 'auto' }, { reason: 'decide --apply' }])('exempts only the published fix for %j', local => {
    const s = evaluate({ local }); expect(decision(s).hold).toBe(false); expect(decision(s, 8).hold).toBe(true);
    expect(s.unpublished).toBe(false); expect(decision(s, 7, false).hold).toBe(true);
    expect(decision(evaluate({ local, settings: settings({ redMainLocalAutoFreeze: 'manual' }) })).hold).toBe(true);
    expect(decideRedMainHold({ num: 7, signal: drainFreezeSignal({ state: s, now: 1 }) }).hold).toBe(true);
  });
  it('kind-less other reasons hold the fix too', () => expect(decision(evaluate({ local: manual })).hold).toBe(true));
});

it('reads once normally, reuses an injected read, and logs sources once per pass', async () => {
  const f = fixture({ local: null }); const first = await prepareDrainFreeze(f);
  expect(f.readShared).toHaveBeenCalledTimes(1);
  expect(f.log.filter(l => l.includes('setting'))).toHaveLength(5);
  expect(f.log.join('')).toContain('setting shared-first via default');
  await prepareDrainFreeze({ ...f, shared: first.shared, logSettings: false });
  expect(f.readShared).toHaveBeenCalledTimes(1);
  expect(f.log.filter(l => l.includes('setting'))).toHaveLength(5);
  await prepareDrainFreeze(f);
  expect(f.readShared).toHaveBeenCalledTimes(2);
});

it('continues dequeuing after an individual mutation failure', async () => {
  const f = fixture({ enqueues: true }); const exec = f.exec;
  f.exec = vi.fn((bin, args, opts) => {
    if (args.some(a => a.includes('mutation') && a.includes('PR_7'))) return JSON.stringify({ errors: [{ message: 'denied' }] });
    return exec(bin, args, opts);
  });
  await prepareDrainFreeze(f);
  expect(f.exec).toHaveBeenCalledTimes(3);
  expect(f.log.join('')).toContain('DEQUEUE FAILED');
  expect(f.log.join('')).toContain('dequeued #8');
});

it('reads all pages before dequeuing and uses the repository default branch', async () => {
  const f = fixture({ enqueues: true, branch: undefined }); let page = 0;
  f.exec = vi.fn((bin, args) => {
    const query = args.at(-1);
    if (query.includes('defaultBranchRef')) return JSON.stringify({ data: { repository: { defaultBranchRef: { name: 'release' } } } });
    if (query.includes('mutation')) return JSON.stringify({ data: { dequeuePullRequest: { clientMutationId: null } } });
    page++;
    expect(query).toContain('branch:"release"');
    if (page === 2) expect(query).toContain('after:"next"');
    return JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes: [{ pullRequest: { id: `PR_${page}`, number: page } }], pageInfo: { hasNextPage: page === 1, endCursor: 'next' } } } } } });
  });
  await prepareDrainFreeze(f); expect(f.exec).toHaveBeenCalledTimes(5);
});

describe('A5 manual fix exemption', () => {
  it.each(['hold', 'exempt'])('%s respects containment and hold OFF', value => {
    const opts = { settings: settings({ redMainManualFreezeFixPr: value }) };
    for (const local of [null, manual]) {
      const state = evaluate({ ...opts, local, shared: { frozen: true } });
      expect(decision(state).hold).toBe(value === 'hold');
      expect(decision(state, 8).hold).toBe(true);
      expect(decision(state, 7, false).hold).toBe(true);
    }
    expect(decision(evaluate({ ...opts, shared: { error: 'offline' } })).hold).toBe(true);
    expect(decision(evaluate({ ...opts, local: manual })).hold).toBe(true);
  });
});
