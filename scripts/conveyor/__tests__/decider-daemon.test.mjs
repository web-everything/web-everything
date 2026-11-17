// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Node's ESM namespace is immutable; spy on the mutable built-in default export.
import childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';
import { planReconcile } from '../reconcile-core.mjs';
import { DECIDE_VERSION } from '../decide.mjs';
import { admit, createDecider, diffReport, foldProjection, formatReport, main } from '../decider-daemon.mjs';
import { pollEvents, resolvePrEventsConfig } from '../../lib/pr-events.mjs';
import { resolveDispatchSetting } from '../../lib/dispatch-throttle.mjs';

// Capture import-time activity before beforeEach clears call histories.
const importActivity = {
  configurationReads: resolvePrEventsConfig.mock.calls.length,
  feedPolls: pollEvents.mock.calls.length,
};

vi.mock('../reconcile-core.mjs', () => ({ planReconcile: vi.fn() }));
vi.mock('../../lib/dispatch-throttle.mjs', async importOriginal => ({
  ...await importOriginal(), resolveDispatchSetting: vi.fn(key => ({ fixDispatchMaxConcurrent: 2, heavyAdmissionCap: 3 })[key]),
}));
vi.mock('../../lib/pr-events.mjs', async importOriginal => ({
  ...await importOriginal(),
  resolvePrEventsConfig: vi.fn(() => ({ enabled: false, flag: false, url: null, token: null, missing: ['url', 'token'] })),
  pollEvents: vi.fn(() => { throw new Error('unconfigured feed must not be polled'); }),
}));

const NOW = Date.parse('2026-11-15T12:00:00Z');
const HEAD = 'a'.repeat(40);
const REPO = 'owner/web-everything';
const KEY = `${REPO}#5454`;
const IDENTITY = { id: 'shadow-fixture', pid: 5454 };
const CAPS = { fix: 2, ciHealReserve: 1, heavy: 3 };
const LIVE = { fix: 0, ciHeal: 0, heavy: 0 };
const event = (extra = {}) => ({
  seq: 1, at: new Date(NOW).toISOString(), repo: REPO, prs: [5454],
  type: 'pull_request', action: 'opened', sha: HEAD, ...extra,
});
const pr = (extra = {}) => ({
  number: 5454, state: 'OPEN', headRefName: 'lane/5454', headRefOid: HEAD,
  labels: [{ name: 'review:pending' }], comments: [], mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }], ...extra,
});
const plan = (kinds = ['review'], refusals = []) => ({
  dispatch: kinds.map(kind => ({ kind, prNumber: 5454, headRefOid: HEAD })), refusals, notes: [],
});

/** A strict IO whitelist catches any attempted mutation without providing a working fallback. */
function rig({ now = () => NOW, overrides = {}, initialState } = {}) {
  const records = [];
  const allowed = {
    hydrate: vi.fn(async () => pr()), readAgents: vi.fn(async () => []),
    appendShadow: vi.fn(async record => { records.push(structuredClone(record)); }),
    readLive: vi.fn(async () => ({ ...LIVE })), hostGate: vi.fn(async () => ({ allow: true, reason: 'fixture' })),
    ...overrides,
  };
  const io = new Proxy(allowed, {
    get(target, key) {
      if (!(key in target)) throw new Error(`forbidden IO: ${String(key)}`);
      return target[key];
    },
  });
  const decider = createDecider({ io, now, initialState, process: IDENTITY, repoSlug: REPO, caps: CAPS });
  return { ...decider, io: allowed, records, decisions: () => records.filter(record => record.kind === 'decision') };
}

beforeEach(() => { vi.clearAllMocks(); planReconcile.mockReset().mockReturnValue(plan()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('foldProjection: pure event-log projection (A2)', () => {
  it('opens and synchronizes heads, deduplicates labels, and removes labels', () => {
    const original = {};
    const result = foldProjection(original, [event(),
      event({ seq: 2, action: 'labeled', label: 'review:pending' }),
      event({ seq: 3, action: 'labeled', label: 'review:pending' }),
      event({ seq: 4, action: 'labeled', label: 'checking' }),
      event({ seq: 5, action: 'unlabeled', label: 'checking' }),
      event({ seq: 6, action: 'synchronize', sha: 'b'.repeat(40) }),
    ]);
    expect(original).toEqual({});
    expect(result.state[KEY]).toMatchObject({ repo: REPO, number: 5454, head: 'b'.repeat(40), seq: 6, dirty: true });
    expect(result.state[KEY].labels).toEqual(['review:pending']);
    expect(result.dirty).toEqual([KEY]);
    expect(result.cursor).toBe(6);
  });
  it('ready_for_review clears draft and closed records the closed state', () => {
    const state = { [KEY]: { repo: REPO, number: 5454, head: HEAD, labels: [], draft: true, state: 'OPEN', seq: 1, lastEventAt: NOW, dirty: false } };
    const ready = foldProjection(state, [event({ seq: 2, action: 'ready_for_review' })]);
    expect(ready.state[KEY]).toMatchObject({ draft: false, dirty: true });
    const closed = foldProjection(ready.state, [event({ seq: 3, action: 'closed' })]);
    expect(String(closed.state[KEY].state).toLowerCase()).toBe('closed');
    expect(state[KEY].draft).toBe(true);
  });
  it.each(['check_suite', 'check_run', 'pull_request_review', 'issue_comment'])('%s dirties every referenced PR', type => {
    const result = foldProjection({}, [event({ type, action: type.startsWith('check_') ? 'completed' : 'submitted', prs: [5454, 5455] })]);
    expect(result.dirty).toEqual(expect.arrayContaining([KEY, `${REPO}#5455`]));
    expect(result.state[KEY].dirty).toBe(true);
  });
  it('runtime events remain available for comparison without dirtying or changing the head', () => {
    const runtime = { class: 'runtime', type: 'worker-started', repo: REPO, number: 5454, head: 'other', action: 'fix', seq: 9 };
    const state = { [KEY]: { repo: REPO, number: 5454, head: HEAD, labels: [], seq: 1, dirty: false } };
    const result = foldProjection(state, [runtime]);
    expect(result.dirty).toEqual([]);
    expect(result.state[KEY]).toEqual(state[KEY]);
    expect(result.runtime).toEqual([runtime]);
    expect(result.cursor).toBe(9);
  });
  it('unknown and malformed events are skipped without guessing a PR or throwing', () => {
    const result = foldProjection({}, [null, undefined, 7, {}, event({ type: 'unknown' }),
      event({ repo: null }), event({ prs: '5454' }), event({ prs: [null, 'bad', -1] })]);
    expect(result.state).toEqual({});
    expect(result.dirty).toEqual([]);
    expect(result.runtime).toEqual([]);
  });
  it('events without seq receive a monotonically advancing counter', () => {
    const result = foldProjection({}, [event({ seq: 10 }), event({ seq: undefined, action: 'synchronize' })]);
    expect(result.state[KEY].seq).toBe(11);
    expect(result.cursor).toBe(11);
  });
});

// Admission requests use the same action envelope returned by decide, retaining identity.
const request = (kind, number = 5454) => ({ repo: REPO, number, head: HEAD, action: { kind, key: `${REPO}#${number}@${HEAD}:${kind}` } });
const admission = (requests, extra = {}) => admit(requests, { caps: CAPS, live: LIVE, hostGate: { allow: true }, ...extra });
function expectDeferred(result, pending) {
  expect(result.deferred.map(entry => entry.request)).toEqual(pending);
  expect(result.deferred.every(entry => typeof entry.reason === 'string' && entry.reason.length > 0)).toBe(true);
}

describe('admit: caps, reserve, slots and host load (A2)', () => {
  it('fix cap counts existing workers and admits only the free fix slot', () => {
    const requests = [request('fix'), request('fix', 5455)];
    const result = admission(requests, { live: { ...LIVE, fix: 1 } });
    expect(result.admitted).toEqual([requests[0]]);
    expectDeferred(result, [requests[1]]);
  });
  it('ci-heal uses one reserved slot when fixes have filled their cap', () => {
    const requests = [request('fix'), request('ci-heal', 5455), request('ci-heal', 5456)];
    const result = admission(requests, { caps: { ...CAPS, heavy: 10 }, live: { ...LIVE, fix: 2 } });
    expect(result.admitted).toEqual([requests[1]]);
    expectDeferred(result, [requests[0], requests[2]]);
  });
  it('an existing ci-heal exhausts the reserve when fixes are at cap', () => {
    const requests = [request('ci-heal')];
    const result = admission(requests, { live: { ...LIVE, fix: 2, ciHeal: 1 } });
    expect(result.admitted).toEqual([]);
    expectDeferred(result, requests);
  });
  it('review remains eligible when the fix cap is full', () => {
    const requests = [request('review')];
    expect(admission(requests, { live: { ...LIVE, fix: 2 } }).admitted).toEqual(requests);
  });
  it('heavy slots bound the whole batch, including reviews and the ci-heal reserve', () => {
    const requests = [request('review'), request('ci-heal', 5455), request('fix', 5456)];
    const result = admission(requests, { live: { ...LIVE, heavy: 2 } });
    expect(result.admitted).toHaveLength(1);
    expect(result.deferred).toHaveLength(2);
    expect(new Set([...result.admitted, ...result.deferred.map(entry => entry.request)])).toEqual(new Set(requests));
    expect(result.deferred.every(entry => Boolean(entry.reason))).toBe(true);
  });
  it('a denied host gate defers every request with the operator-visible gate reason', () => {
    const requests = [request('review'), request('fix', 5455), request('ci-heal', 5456)];
    const result = admission(requests, { hostGate: { allow: false, reason: 'host-pressure: wait for capacity' } });
    expect(result.admitted).toEqual([]);
    expect(result.deferred).toEqual(requests.map(request => ({ request, reason: 'host-pressure: wait for capacity' })));
  });
  it('omitted caps resolve the shared settings rather than bypassing them', () => {
    const requests = [request('fix'), request('fix', 5455), request('fix', 5456)];
    const result = admit(requests, { live: LIVE, hostGate: { allow: true } });
    expect(resolveDispatchSetting.mock.calls.map(([key]) => key)).toEqual(expect.arrayContaining(['fixDispatchMaxConcurrent', 'heavyAdmissionCap']));
    expect(result.admitted).toHaveLength(2);
    expectDeferred(result, [requests[2]]);
  });
});

describe('createDecider: serialized shadow lifecycle', () => {
  it.each([{ state: 'CLOSED' }, { draft: true }])('restart preserves refusing projected fields %j', fields => {
    const initialState = { [KEY]: { repo: REPO, number: 5454, head: HEAD, seq: 1,
      lastEventAt: NOW - 3_600_000, dirty: false, ...fields } };
    const r = rig({ initialState });
    return r.tick().then(() => {
      expect(r.decisions()).toHaveLength(1);
      expect(r.decisions()[0].action).toBeNull();
      expect(planReconcile).not.toHaveBeenCalled();
      expect(initialState[KEY].dirty).toBe(false);
    });
  });
  it('a slow hydration still exceeds the freshness bound', async () => {
    let clock = NOW;
    const r = rig({ now: () => clock, overrides: { hydrate: async () => { clock += 300_001; return pr(); } } });
    r.ingest([event()]);
    await r.tick();
    expect(r.decisions()[0]).toMatchObject({ action: null, reasons: ['projection-stale'] });
    expect(planReconcile).not.toHaveBeenCalled();
  });
  it('a full tick uses only the five read/journal IO methods and never fetches, executes or dispatches (A6)', async () => {
    const forbidden = vi.fn(() => { throw new Error('unexpected shadow mutation or network'); });
    vi.stubGlobal('fetch', forbidden);
    for (const name of ['execFileSync', 'execSync', 'spawn', 'execFile', 'exec', 'spawnSync']) vi.spyOn(childProcess, name).mockImplementation(forbidden);
    const r = rig();
    r.ingest([event()]);
    await r.tick();
    expect(r.io.hydrate).toHaveBeenCalledWith(REPO, 5454);
    for (const name of ['readAgents', 'readLive', 'hostGate', 'appendShadow']) expect(r.io[name]).toHaveBeenCalled();
    expect(forbidden).not.toHaveBeenCalled();
    expect(r.decisions()).toHaveLength(1);
    expect(r.records.filter(record => record.kind === 'admission')).toHaveLength(1);
    expect(r.records.every(record => record.shadow === true)).toBe(true);
  });
  it('decision records carry version, process identity, event sequence and measured lag (A5/A7, edge 7)', async () => {
    const r = rig({ now: () => NOW + 250 });
    r.ingest([event({ seq: 17 })]);
    await r.tick();
    expect(r.decisions()).toEqual([expect.objectContaining({
      shadow: true, kind: 'decision', version: DECIDE_VERSION, process: { ...IDENTITY, role: 'decider' },
      repo: REPO, number: 5454, head: HEAD, seq: 17, decidedAt: NOW + 250, lagMs: 250,
      action: { kind: 'review', key: `${KEY}@${HEAD}:review` }, considered: ['review'],
      reasons: expect.any(Array), recheckAt: null, eventAt: expect.anything(),
    })]);
  });
  it('an in-flight re-mark is decided twice sequentially, even with overlapping ticks (A3)', async () => {
    const order = [];
    let release;
    let entered;
    const held = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    let active = 0;
    let peak = 0;
    let count = 0;
    const r = rig({ overrides: { hydrate: vi.fn(async () => {
      const call = ++count;
      peak = Math.max(peak, ++active);
      order.push(`start-${call}`);
      if (call === 1) {
        r.ingest([event({ seq: 2, action: 'synchronize' })]);
        entered();
        await held;
      }
      order.push(`end-${call}`);
      active--;
      return pr();
    }) } });
    r.ingest([event()]);
    const first = r.tick();
    await started;
    const overlapping = r.tick();
    release();
    await Promise.all([first, overlapping]);
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    expect(peak).toBe(1);
    expect(planReconcile).toHaveBeenCalledTimes(2);
    expect(r.decisions()).toHaveLength(2);
    expect(r.decisions().at(-1).seq).toBe(2);
  });
  it.each([30_000, 300_001, 3_600_000])('a timer-driven retry rehydrates at its %ims deadline (A4)', async delay => {
    let clock = NOW;
    const deadline = NOW + delay;
    planReconcile.mockReturnValueOnce(plan([], [{ prNumber: 5454, kind: 'fix-join-wait', deadline }])).mockReturnValue(plan());
    const r = rig({ now: () => clock });
    r.ingest([event()]);
    await r.tick();
    expect(r.decisions()[0].recheckAt).toBe(deadline);
    clock = deadline - 1;
    await r.tick();
    expect(r.io.hydrate).toHaveBeenCalledTimes(1);
    clock = deadline;
    await r.tick();
    expect(r.io.hydrate).toHaveBeenCalledTimes(2);
    expect(r.decisions().at(-1).action?.kind).toBe('review');
    expect(r.decisions().at(-1).lagMs).toBe(delay);
  });
  it('rehydrates an old replayed event without losing its original event lag', async () => {
    const r = rig({ now: () => NOW + 3_600_000 });
    r.ingest([event()]);
    await r.tick();
    expect(r.decisions()[0]).toMatchObject({ action: { kind: 'review' }, lagMs: 3_600_000 });
  });
  it('processes a fresh event before an existing retry deadline', async () => {
    let clock = NOW;
    const deadline = NOW + 30_000;
    const nextHead = 'b'.repeat(40);
    planReconcile.mockReturnValueOnce(plan([], [{ prNumber: 5454, kind: 'fix-join-wait', deadline }]))
      .mockReturnValue(plan());
    const r = rig({ now: () => clock });
    r.io.hydrate.mockResolvedValueOnce(pr()).mockResolvedValue(pr({ headRefOid: nextHead }));
    r.ingest([event()]);
    await r.tick();
    expect(r.decisions()[0].recheckAt).toBe(deadline);

    clock = NOW + 1000;
    r.ingest([event({ seq: 2, action: 'synchronize', sha: nextHead, at: new Date(clock).toISOString() })]);
    await r.tick();
    expect(clock).toBeLessThan(deadline);
    expect(r.io.hydrate).toHaveBeenCalledTimes(2);
    expect(planReconcile).toHaveBeenCalledTimes(2);
    expect(r.decisions()).toHaveLength(2);
    expect(r.decisions()[1]).toMatchObject({ head: nextHead, seq: 2, decidedAt: clock,
      action: { kind: 'review', key: `${KEY}@${nextHead}:review` }, recheckAt: null });

    // The fresh decision replaces the previous head's timer.
    clock = deadline;
    await r.tick();
    expect(r.io.hydrate).toHaveBeenCalledTimes(2);
  });
  it('processes an expired recheck only once per tick', async () => {
    let clock = NOW;
    const deadline = NOW - 1;
    planReconcile.mockReturnValue(plan([], [{ prNumber: 5454, kind: 'fix-join-wait', deadline }]));
    const r = rig({ now: () => {
      // Bound the probe so a spinning implementation fails instead of hanging.
      if (clock > NOW + 1000) throw new Error('tick exceeded advancing-clock budget');
      clock += 10;
      return clock;
    } });
    r.ingest([event()]);
    await expect(r.tick()).resolves.toEqual({ admitted: [], deferred: [] });
    expect(r.io.hydrate).toHaveBeenCalledTimes(1);
    expect(r.decisions()).toHaveLength(1);
    expect(r.decisions()[0].recheckAt).toBe(deadline);
    expect(r.records.filter(record => record.kind === 'admission')).toHaveLength(1);

    // The expired timer remains eligible on the next tick without another event.
    await r.tick();
    expect(r.io.hydrate).toHaveBeenCalledTimes(2);
    expect(r.decisions()).toHaveLength(2);
    expect(r.records.filter(record => record.kind === 'admission')).toHaveLength(2);
  });
  it('an unknown constellation repo fails closed when the strict planner-repo resolver is used', async () => {
    const records = [];
    const io = { hydrate: vi.fn(async () => pr()), readAgents: vi.fn(async () => []), readLive: vi.fn(async () => ({ ...LIVE })),
      hostGate: vi.fn(async () => ({ allow: true, reason: 'fixture' })), appendShadow: vi.fn(async r => { records.push(r); }) };
    const decider = createDecider({ io, now: () => NOW, process: IDENTITY, repoSlug: REPO, caps: CAPS, plannerRepoFor: () => null });
    decider.ingest([event()]);
    await decider.tick();
    const d = records.find(r => r.kind === 'decision');
    expect(d.action).toBeNull();
    expect(d.reasons).toContain('snapshot-missing');
  });
  it('a decision turns the planner eligibility journal off so a decision writes nothing', async () => {
    const r = rig();
    r.ingest([event()]);
    await r.tick();
    const arg = planReconcile.mock.calls[0][0];
    expect(arg.shadowDeps.mode).toBe('off');
    expect(() => arg.shadowDeps.appendLine('x')).not.toThrow();
  });
  it('fix admission counts occupied ci-heal slots against the combined repair capacity', () => {
    const mk = kind => ({ action: { kind, key: `k-${kind}` } });
    const result = admission([mk('fix'), mk('fix')], { live: { fix: 0, ciHeal: 3, heavy: 0 } });
    expect(result.admitted).toHaveLength(0);
    expect(result.deferred.every(d => d.reason.startsWith('fix-cap'))).toBe(true);
  });
  it('a clean PR without a timer is not hydrated again on the next tick', async () => {
    const r = rig();
    r.ingest([event()]);
    await r.tick();
    await r.tick();
    expect(r.io.hydrate).toHaveBeenCalledTimes(1);
    expect(planReconcile).toHaveBeenCalledTimes(1);
  });
  it.each(['null', 'throw', 'stale-head', 'truncated'])('%s hydration fails closed with a journaled retry', async mode => {
    const r = rig({ overrides: { hydrate: vi.fn(async () => {
      if (mode === 'throw') throw new Error('read failed');
      if (mode === 'null') return null;
      return pr(mode === 'stale-head' ? { headRefOid: 'old' } : { truncated: true });
    }) } });
    r.ingest([event()]);
    await r.tick();
    expect(r.decisions()).toHaveLength(1);
    const record = r.decisions()[0];
    expect(record.action).toBeNull();
    expect(record.recheckAt).toBe(NOW + 60_000);
    expect(record.reasons.length).toBeGreaterThan(0);
    expect(record.shadow).toBe(true);
    expect(planReconcile).not.toHaveBeenCalled();
  });
  it('a stale hydration fails closed with a journaled retry and original event lag', async () => {
    let clock = NOW;
    const r = rig({ now: () => clock, overrides: { hydrate: async () => {
      clock += 300_001;
      return pr();
    } } });
    r.ingest([event()]);
    await r.tick();
    expect(r.decisions()[0]).toMatchObject({ action: null, reasons: expect.arrayContaining(['projection-stale']),
      recheckAt: NOW + 360_001, eventAt: NOW, lagMs: 300_001 });
    expect(planReconcile).not.toHaveBeenCalled();
  });
  it('source contains no runtime-event writer, GitHub mutation command, or merge dispatch', () => {
    for (const name of ['decide.mjs', 'decider-daemon.mjs']) {
      const source = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/\bappendRuntimeEvent\b|gh\s+pr\s+(?:edit|comment|merge)\b|--(?:add|remove)-label/);
      expect(source).not.toMatch(/dispatch\w*\s*\([^)]*['"]merge['"]|(?:kind|action)\s*:\s*['"]merge['"]/);
    }
  });
});

const decision = (number, kind, lagMs, extra = {}) => ({
  shadow: true, kind: 'decision', version: DECIDE_VERSION, process: { ...IDENTITY, role: 'decider' },
  repo: REPO, number, head: HEAD, seq: number, decidedAt: NOW, eventAt: NOW - lagMs, lagMs,
  action: kind ? { kind, key: `${REPO}#${number}@${HEAD}:${kind}` } : null,
  considered: kind ? [kind] : [], reasons: [], recheckAt: null, ...extra,
});
const actual = (number, action, extra = {}) => ({ class: 'runtime', type: 'action-requested', repo: REPO, number, head: HEAD, action, ...extra });

describe('diffReport and formatReport: cut-over evidence (A6/A7)', () => {
  it('classifies all four differences, retains both-idle decisions, and reports exact counts and p50 lag', () => {
    const report = diffReport({ now: NOW,
      decisions: [decision(1, 'fix', 10), decision(2, 'fix', 20), decision(3, 'review', 30), decision(4, null, 40), decision(5, null, 50)],
      actual: [actual(1, 'fix'), actual(2, 'review', { type: 'worker-started' }), actual(4, 'ci-heal')],
    });
    expect(report.counts).toEqual({ conflicting: 0, agree: 1, disagreeKind: 1, wouldDoOnly: 1, actualOnly: 1 });
    expect(report.rows).toHaveLength(5);
    expect(report.rows.map(row => row.number).sort()).toEqual([1, 2, 3, 4, 5]);
    for (const classification of ['agree', 'disagree-kind', 'would-do-only', 'actual-only']) expect(JSON.stringify(report.rows)).toContain(classification);
    expect(report.lag).toEqual({ p50Ms: 30, n: 5 });
    expect(report.generatedFrom).toBeTruthy();
  });
  it('keeps every decision per head and flags conflicts and deduplicates requested/started runtime facts', () => {
    const report = diffReport({ now: NOW,
      decisions: [decision(1, 'review', 10, { seq: 1, decidedAt: NOW - 1 }), decision(1, 'fix', 30, { seq: 2 })],
      actual: [actual(1, 'fix'), actual(1, 'fix', { type: 'worker-started' }), actual(1, 'fix', { type: 'worker-finished' })],
    });
    expect(report.counts).toEqual({ conflicting: 2, agree: 1, disagreeKind: 1, wouldDoOnly: 0, actualOnly: 0 });
    expect(report.rows).toHaveLength(2);
    expect(report.rows.every(row => row.conflicting)).toBe(true);
    expect(report.lag).toEqual({ p50Ms: 10, n: 2 });
  });
  it('scopes comparisons by repo and head rather than PR number alone', () => {
    const report = diffReport({ now: NOW, decisions: [decision(1, 'fix', 10)],
      actual: [actual(1, 'fix', { head: 'old' }), actual(1, 'fix', { repo: 'owner/other' })] });
    expect(report.counts).toEqual({ conflicting: 0, agree: 0, disagreeKind: 0, wouldDoOnly: 1, actualOnly: 2 });
  });
  it('ignores webhooks and worker-finished events as evidence of a live action', () => {
    const report = diffReport({ now: NOW, decisions: [decision(1, 'fix', 10)], actual: [event({ prs: [1] }), actual(1, 'fix', { type: 'worker-finished' })] });
    expect(report.counts).toEqual({ conflicting: 0, agree: 0, disagreeKind: 0, wouldDoOnly: 1, actualOnly: 0 });
  });
  it('empty evidence reports zero comparisons and an explicit absent median', () => {
    const report = diffReport({ decisions: [], actual: [], now: NOW });
    expect(report.counts).toEqual({ conflicting: 0, agree: 0, disagreeKind: 0, wouldDoOnly: 0, actualOnly: 0 });
    expect(report.rows).toEqual([]);
    expect(report.lag).toEqual({ p50Ms: null, n: 0 });
  });
  it('formatReport produces deterministic markdown table text without mutating its report', () => {
    const report = diffReport({ now: NOW, decisions: [decision(5454, 'fix', 25)], actual: [actual(5454, 'fix')] });
    const before = structuredClone(report);
    const text = formatReport(report);
    expect(typeof text).toBe('string');
    expect(text).toBe(formatReport(structuredClone(report)));
    expect(text).toContain(REPO);
    expect(text).toContain('5454');
    expect(text).toContain('agree');
    expect(text).toMatch(/^\|.*\|$/m);
    expect(text).toMatch(/^\|[\s:|-]+\|$/m);
    expect(report).toEqual(before);
  });
  it.each([
    ['plain pipe', 'left|right', String.raw`left\|right`],
    ['backslash', String.raw`left\right`, String.raw`left\\right`],
    ['backslash before pipe', String.raw`left\|right`, String.raw`left\\\|right`],
    ['two backslashes before pipe', String.raw`left\\|right`, String.raw`left\\\\\|right`],
    ['trailing backslash', 'right\\', String.raw`right\\`],
    ['controls before pipe', 'left\\\u001b\n|right\u007f\u009f', String.raw`left\\\|right`],
  ])('formatReport escapes %s in every table column', (_name, input, escaped) => {
    const report = {
      rows: [{ repo: input, number: input, head: input, wanted: input, actual: [input], classification: input }],
      lag: { p50Ms: null, n: 0 },
    };
    const before = structuredClone(report);
    expect(formatReport(report).split('\n')[2]).toBe(`| ${Array(6).fill(escaped).join(' | ')} |`);
    expect(report).toEqual(before);
  });
});

describe('main: shadow-only entry point', () => {
  it('importing the daemon performs no feed polling or configuration reads', () => {
    expect(importActivity).toEqual({ configurationReads: 0, feedPolls: 0 });
  });
  it('an unconfigured event feed exits non-zero with a clear configuration message', async () => {
    const writes = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(text => { writes.push(String(text)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation(text => { writes.push(String(text)); return true; });
    vi.spyOn(console, 'error').mockImplementation((...args) => { writes.push(args.join(' ')); });
    vi.spyOn(console, 'log').mockImplementation((...args) => { writes.push(args.join(' ')); });
    const stopped = new Error('fixture process exit');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw stopped; });
    const previousCode = process.exitCode;
    let returned;
    try {
      try { returned = await main(['--dry-run', '--once', `--repo=${REPO}`]); }
      catch (error) { if (error !== stopped) throw error; }
      const code = exit.mock.calls.at(-1)?.[0] ?? (typeof returned === 'number' ? returned : process.exitCode);
      expect(Number.isInteger(code) && code !== 0).toBe(true);
      expect(writes.join('\n')).toMatch(/(?:not configured|missing|WE_PR_EVENTS|event.*config)/i);
      expect(pollEvents).not.toHaveBeenCalled();
    } finally { process.exitCode = previousCode; }
  });
  it('documents the exact dry-run command and exposes no acting-mode flag', () => {
    const source = readFileSync(new URL('../decider-daemon.mjs', import.meta.url), 'utf8');
    expect(source).toContain('node scripts/conveyor/decider-daemon.mjs --dry-run --once');
    expect(source).not.toMatch(/(?:argv|args)\.includes\(['"]--(?:act|apply|live|execute|no-dry-run)['"]\)/);
    expect(source).not.toMatch(/(?:flags|opts|options)\.(?:act|apply|live|execute)\b/);
  });
});

it('uses hydrated agents and live planner policies without a second listing', async () => {
  const agents = [{ name: 'fixture' }], plannerOptions = { requiredChecks: ['live-gate'], roundCap: 7 };
  const r = rig({ overrides: { hydrate: () => ({ pr: pr(), agents, agentsIncomplete: false, plannerOptions }) } });
  r.ingest([event()]); await r.tick();
  expect(planReconcile).toHaveBeenCalledWith(expect.objectContaining({ agents, ...plannerOptions }));
});
it('records incomplete hydration and retries without planning', async () => {
  const r = rig({ overrides: { hydrate: () => ({ pr: pr(), agents: [], agentsIncomplete: true, plannerOptions: {} }) } });
  r.ingest([event()]); await r.tick();
  expect(r.decisions()[0]).toMatchObject({ incomplete: true, action: null, reasons: ['agents-incomplete'], recheckAt: NOW + 60000 });
  expect(planReconcile).not.toHaveBeenCalled();
});
