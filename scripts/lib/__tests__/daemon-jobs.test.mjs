/**
 * @file scripts/lib/__tests__/daemon-jobs.test.mjs
 * @description #4125 — the pure job policy: classify (live / stalled / dead / launching / foreign), the
 *   reattach plan and its 3-attempt cap, the per-daemon cap and serial lane, the sleep rule, snapshot-store
 *   eviction, and the record transitions.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  admitJobs, backoffMs, classifyJob, defineJobKind, detectSleep, kindRegistry, markClaimed, markCheckpoint,
  markLaunching, markQueued, markRequeued, markHeartbeat, planReattach, selectEvictions, SLEEP_GAP_THRESHOLD_MS,
  validateTaskPolicy, taskDeadlineDecision, TASK_OUTCOMES, taskFailureCharge, taskRunId, createToolVersionWatch,
} from '../daemon-jobs.mjs';
import { newJobRunRecord, isValidRunId } from '../../operations/run-record.mjs';
import { resolveCascade } from '../policy-cascade.mjs';

const T0 = Date.parse('2026-09-28T12:00:00.000Z');
const at = (ms) => new Date(ms).toISOString();
const HANDLE = 'host-a:4242:Mon Sep 28 12:00:00 2026';

function running(overrides = {}, { heartbeatAt = T0, attempts = 1 } = {}) {
  let r = markQueued(newJobRunRecord({ id: overrides.id ?? 'job-1', kind: overrides.kind ?? 'noop', codeSha: 'sha' }), { at: at(T0 - 1000) });
  for (let i = 0; i < attempts; i += 1) r = markLaunching(r, { at: at(T0) });
  r = markClaimed(r, { at: at(heartbeatAt), handle: HANDLE, host: 'host-a', pid: 4242, procStart: 'Mon Sep 28 12:00:00 2026' });
  return r;
}

const kinds = kindRegistry([
  defineJobKind({ kind: 'noop', entry: 'scripts/noop.mjs' }),
  defineJobKind({ kind: 'writer', entry: 'scripts/writer.mjs', serial: true }),
  defineJobKind({ kind: 'session', entry: 'scripts/session.mjs', resumable: false }),
]);

function taskRecord(id, { repo = 'owner/repo', acting = true, kind = 'noop', actingRepoCap = 1 } = {}) {
  const r = markQueued(newJobRunRecord({ id, kind }), { at: at(T0) });
  r.job.task = {
    id: `${kind}:${repo}:42:1`, kind, repo, item: 42, seq: 1, acting, actingRepoCap,
    timeoutMs: 300000, policy: { timeoutMs: 300000 }, sources: { timeoutMs: 'standard' },
    resourceKind: 'review', failureCount: 0, outcome: null, resultRef: null,
  };
  return r;
}

describe('pure item-task policy', () => {
  it('task policy persists the 300000ms default and cascade provenance', () => {
    expect(validateTaskPolicy()).toEqual({ policy: { timeoutMs: 300000 }, sources: { timeoutMs: 'standard' } });
    const valid = { timeoutMs: v => Number.isFinite(v) && v > 0 };
    const layers = { standard: { timeoutMs: 300000 }, platform: { timeoutMs: 2000 }, tool: { timeoutMs: 1000 }, envValues: { timeoutMs: 500 }, valid };
    expect(validateTaskPolicy(resolveCascade(layers))).toEqual({ policy: { timeoutMs: 500 }, sources: { timeoutMs: 'env' } });
    expect(validateTaskPolicy(resolveCascade({ standard: layers.standard, platform: layers.platform, valid })).sources.timeoutMs).toBe('platform');
    expect(validateTaskPolicy(resolveCascade({ standard: layers.standard, tool: layers.tool, valid })).sources.timeoutMs).toBe('tool');
    for (const layer of ['standard', 'platform', 'tool', 'envValues']) {
      for (const timeoutMs of [0, -1, Infinity, NaN, '1000', null]) {
        // The cascade does not validate its standard layer; exercise the final-policy guard there.
        const input = layer === 'standard' ? { standard: { timeoutMs }, valid } : { ...layers, [layer]: { timeoutMs } };
        expect(() => validateTaskPolicy(resolveCascade(input))).toThrow(/policy/);
      }
    }
    for (const invalid of [null, {}, { value: {} }, { value: { timeoutMs: 1 }, sources: {} }, { value: { timeoutMs: 1 }, sources: { timeoutMs: 'unknown' }, invalid: [] }]) {
      expect(() => validateTaskPolicy(invalid)).toThrow(/policy/);
    }
  });

  it('heartbeats and host sleep never extend task deadlines, which coexist with legacy absolute deadlines', () => {
    const queued = taskRecord('q');
    expect(taskDeadlineDecision(queued, { now: T0 + 999999 })).toBeNull();
    const launch = markLaunching(queued, { at: at(T0) });
    expect(taskDeadlineDecision(launch, { now: T0 + 299999 })).toEqual({ deadlineAt: T0 + 300000, expired: false });
    const live = markClaimed(launch, { at: at(T0 + 300000), handle: HANDLE });
    const persisted = JSON.parse(JSON.stringify(live));
    expect(taskDeadlineDecision(persisted, { now: T0 + 300000 })).toEqual({ deadlineAt: T0 + 300000, expired: true });
    const heartbeat = markHeartbeat(persisted, { at: at(T0 + 300001) });
    expect(heartbeat.job.heartbeatAt).toBe(at(T0 + 300001));
    expect(taskDeadlineDecision(heartbeat, { now: T0 + 300001 })).toEqual({ deadlineAt: T0 + 300000, expired: true });
    const wakeAt = T0 + 900001;
    const sleepDetected = detectSleep({ wallMs: T0 + 300001, monoMs: 0 }, { wallMs: wakeAt, monoMs: 1 }).slept;
    expect(sleepDetected).toBe(true);
    expect(classifyJob(heartbeat, { now: wakeAt, liveness: 'alive', sleepDetected })).toBe('live');
    expect(taskDeadlineDecision(heartbeat, { now: wakeAt })).toEqual({ deadlineAt: T0 + 300000, expired: true });
    const backoff = markRequeued(live, { at: at(T0 + 400000), now: T0 + 400000, reason: 'retry' });
    expect(taskDeadlineDecision(backoff, { now: T0 + 999999 })).toBeNull();
    const retry = markLaunching(backoff, { at: at(T0 + 500000) });
    expect(taskDeadlineDecision(retry, { now: T0 + 500001 }).deadlineAt).toBe(T0 + 800000);
    expect(taskDeadlineDecision(running(), { now: T0 + 999999 })).toBeNull();
    expect(taskDeadlineDecision({ ...live, job: { ...live.job, status: 'succeeded' } }, { now: T0 + 999999 })).toBeNull();
    expect(() => taskDeadlineDecision({ ...live, job: { ...live.job, launchedAt: null } }, { now: T0 })).toThrow(/launch/);
    expect(() => taskDeadlineDecision(live, { now: NaN })).toThrow(/now/);
  });

  it('task outcomes preserve launch identity and charge only failed attempts', () => {
    expect(TASK_OUTCOMES).toEqual(['acted', 'nothing-owed', 'superseded', 'deferred-claim-held', 'deferred-read', 'failed']);
    let r = taskRecord('outcome');
    for (const [index, outcome] of TASK_OUTCOMES.entries()) {
      r = markLaunching(r, { at: at(T0 + index) });
      expect(r.job.attempts).toBe(index + 1);
      expect(r.job.task.failureCount).toBe(0);
      expect(taskFailureCharge(outcome)).toBe(outcome === 'failed' ? 1 : 0);
    }
    expect(() => taskFailureCharge('success')).toThrow(/outcome/);
    expect(() => taskFailureCharge(null)).toThrow(/outcome/);
    const identity = taskRecord('identity').job.task;
    const id = taskRunId(identity);
    expect(isValidRunId(id)).toBe(true);
    expect(isValidRunId(identity.id)).toBe(false);
    expect(taskRunId(JSON.parse(JSON.stringify(identity)))).toBe(id);
    expect(taskRunId({ ...identity, seq: 2, id: 'noop:owner/repo:42:2' })).not.toBe(id);
    expect(taskRunId({ ...identity, repo: 'owner/other', id: 'noop:owner/other:42:1' })).not.toBe(id);
    expect(() => taskRunId({ ...identity, item: '../escape' })).toThrow(/task/);
  });

  it('acting tasks share the default one-per-repo cap across kinds', () => {
    const a = taskRecord('a');
    const b = taskRecord('b', { kind: 'session' });
    const c = taskRecord('c', { repo: 'owner/other' });
    const d = taskRecord('d', { acting: false });
    delete a.job.task.actingRepoCap;
    const records = [a, b, c, d];
    const admit = (rows, cap = 10) => admitJobs({ records: rows, kinds, maxConcurrent: cap, now: T0 });
    const before = structuredClone(records);
    expect(admit(records)).toEqual(['a', 'c', 'd']);
    expect(records).toEqual(before);
    for (const busy of [markLaunching(a, { at: at(T0) }), markClaimed(markLaunching(a, { at: at(T0) }), { at: at(T0), handle: HANDLE })]) {
      expect(admit([busy, b, c, d])).toEqual(['c', 'd']);
    }
    expect(admit(records, 1)).toEqual(['a']);
    expect(admit([a, taskRecord('b', { actingRepoCap: 2 }), taskRecord('c', { actingRepoCap: 2 })])).toEqual(['a']);
    expect(admit([taskRecord('a', { actingRepoCap: 2 }), taskRecord('b', { actingRepoCap: 2 }), taskRecord('c', { actingRepoCap: 2 })])).toEqual(['a', 'b']);
    const serial = [taskRecord('a', { kind: 'writer' }), taskRecord('b', { kind: 'writer', repo: 'owner/other' }), c];
    expect(admit(serial)).toEqual(['a', 'c']);
    expect(() => admit([{ ...b, job: { ...b.job, task: {} } }])).toThrow(/task/);
    expect(() => admit([taskRecord('bad', { actingRepoCap: 0 })])).toThrow(/task/);
    const unknownResource = taskRecord('unknown');
    unknownResource.job.task.resourceKind = 'invented';
    expect(() => admit([unknownResource])).toThrow(/resourceKind/);
  });
});

describe('classifyJob', () => {
  it('expires a foreign heartbeat only past the 30-minute default backstop', () => {
    expect(classifyJob(running(), { now: T0 + 30 * 60_000, liveness: 'foreign' })).toBe('foreign');
    expect(classifyJob(running(), { now: T0 + 30 * 60_000 + 1, liveness: 'foreign' })).toBe('dead');
  });

  it('honors foreignStaleMs and skips foreign staleness after sleep', () => {
    const options = { now: T0 + 1001, liveness: 'foreign', foreignStaleMs: 1000 };
    expect(classifyJob(running(), options)).toBe('dead');
    expect(classifyJob(running(), { ...options, sleepDetected: true })).toBe('foreign');
  });

  it('uses startedAt when a foreign heartbeat is absent, but retains unparseable evidence', () => {
    const r = running();
    const options = { now: T0 + 1001, liveness: 'foreign', foreignStaleMs: 1000 };
    expect(classifyJob({ ...r, job: { ...r.job, heartbeatAt: null } }, options)).toBe('dead');
    expect(classifyJob({ ...r, job: { ...r.job, heartbeatAt: 'invalid' } }, options)).toBe('foreign');
    expect(classifyJob({ ...r, job: { ...r.job, heartbeatAt: null, startedAt: null } }, options)).toBe('foreign');
  });

  it('live pid + fresh heartbeat = live; live pid + stale heartbeat = stalled', () => {
    const r = running();
    expect(classifyJob(r, { now: T0 + 10_000, liveness: 'alive', staleMs: 60_000 })).toBe('live');
    expect(classifyJob(r, { now: T0 + 61_000, liveness: 'alive', staleMs: 60_000 })).toBe('stalled');
  });

  it('a dead or reused pid is dead regardless of heartbeat; another host is foreign', () => {
    expect(classifyJob(running(), { now: T0 + 1, liveness: 'dead' })).toBe('dead');
    expect(classifyJob(running(), { now: T0 + 999_999, liveness: 'foreign' })).toBe('foreign');
  });

  it('the sleep rule skips staleness only on the tick it fires, never the dead check', () => {
    const r = running();
    expect(classifyJob(r, { now: T0 + 600_000, liveness: 'alive', sleepDetected: true })).toBe('live');
    expect(classifyJob(r, { now: T0 + 600_000, liveness: 'alive', sleepDetected: false })).toBe('stalled');
    expect(classifyJob(r, { now: T0 + 600_000, liveness: 'dead', sleepDetected: true })).toBe('dead');
  });

  it('an unclaimed launch is launching within the grace and dead after it', () => {
    const r = markLaunching(markQueued(newJobRunRecord({ id: 'j', kind: 'noop', codeSha: 's' }), { at: at(T0) }), { at: at(T0) });
    expect(classifyJob(r, { now: T0 + 5_000, liveness: null, launchGraceMs: 30_000 })).toBe('launching');
    expect(classifyJob(r, { now: T0 + 31_000, liveness: null, launchGraceMs: 30_000 })).toBe('dead');
  });

  it('queued is waiting until nextAttemptAt, terminal stays terminal', () => {
    const q = markRequeued(running(), { at: at(T0), now: T0, reason: 'x', backoffBaseMs: 1000 });
    expect(classifyJob(q, { now: T0 + 500, liveness: null })).toBe('waiting');
    expect(classifyJob(q, { now: T0 + 1000, liveness: null })).toBe('queued');
    const done = { ...q, job: { ...q.job, status: 'succeeded' } };
    expect(classifyJob(done, { now: T0, liveness: 'dead' })).toBe('terminal');
  });
});

describe('planReattach', () => {
  it('leaves live/launching/foreign alone', () => {
    for (const s of ['live', 'launching', 'foreign', 'queued', 'waiting', 'terminal']) {
      expect(planReattach(running(), s, { kindDef: kinds.get('noop') }).type).toBe('none');
    }
  });

  it('dead resumes from the checkpoint; stalled stops first; a non-resumable kind restarts', () => {
    expect(planReattach(running(), 'dead', { kindDef: kinds.get('noop') })).toMatchObject({ type: 'requeue', resume: true, stopFirst: false });
    expect(planReattach(running(), 'stalled', { kindDef: kinds.get('noop') })).toMatchObject({ type: 'requeue', stopFirst: true });
    expect(planReattach(running({ kind: 'session' }), 'dead', { kindDef: kinds.get('session') })).toMatchObject({ resume: false });
  });

  it('fails visibly after 3 attempts, and when the daemon no longer declares the kind', () => {
    const third = running({}, { attempts: 3 });
    expect(planReattach(third, 'dead', { kindDef: kinds.get('noop') })).toMatchObject({ type: 'fail', reason: expect.stringMatching(/3\/3/) });
    expect(planReattach(third, 'stalled', { kindDef: kinds.get('noop') })).toMatchObject({ type: 'fail', stopFirst: true });
    expect(planReattach(running(), 'dead', { kindDef: null })).toMatchObject({ type: 'fail', reason: expect.stringMatching(/not declared/) });
  });

  it('requeue keeps the checkpoint on resume and rewinds it otherwise; backoff doubles', () => {
    const r = markCheckpoint(running(), { at: at(T0), step: 2, data: { k: 1 } });
    expect(markRequeued(r, { at: at(T0), now: T0, reason: 'x', resume: true }).job.checkpoint).toEqual({ step: 2, data: { k: 1 } });
    expect(markRequeued(r, { at: at(T0), now: T0, reason: 'x', resume: false }).job.checkpoint).toEqual({ step: 0, data: {} });
    expect([1, 2, 3].map((n) => backoffMs(n, 1000))).toEqual([1000, 2000, 4000]);
  });
});

describe('admitJobs — per-daemon cap and serial lane', () => {
  const queued = (id, kind, t) => markQueued(newJobRunRecord({ id, kind, codeSha: 's' }), { at: at(T0 + t) });

  it('admits oldest first up to the cap, counting launching and running jobs', () => {
    const records = [running({ id: 'r1' }), queued('q2', 'noop', 2), queued('q1', 'noop', 1), queued('q3', 'noop', 3)];
    expect(admitJobs({ records, kinds, maxConcurrent: 3, now: T0 + 10 })).toEqual(['q1', 'q2']);
    expect(admitJobs({ records, kinds, maxConcurrent: 1, now: T0 + 10 })).toEqual([]);
  });

  it('runs at most one serial job at a time, without blocking other kinds', () => {
    const records = [queued('w1', 'writer', 1), queued('w2', 'writer', 2), queued('n1', 'noop', 3)];
    expect(admitJobs({ records, kinds, maxConcurrent: 5, now: T0 + 10 })).toEqual(['w1', 'n1']);
    const busy = [running({ id: 'w0', kind: 'writer' }), ...records];
    expect(admitJobs({ records: busy, kinds, maxConcurrent: 5, now: T0 + 10 })).toEqual(['n1']);
  });

  it('skips jobs still backing off and kinds the daemon does not declare', () => {
    const backing = markRequeued(running({ id: 'b' }), { at: at(T0), now: T0, reason: 'x', backoffBaseMs: 60_000 });
    const records = [backing, queued('u', 'unknown-kind', 1)];
    expect(admitJobs({ records, kinds, maxConcurrent: 5, now: T0 + 1 })).toEqual([]);
    expect(admitJobs({ records, kinds, maxConcurrent: 5, now: T0 + 60_000 })).toEqual(['b']);
  });

  it('refuses a non-positive cap', () => {
    expect(() => admitJobs({ records: [], kinds, maxConcurrent: 0, now: T0 })).toThrow(/maxConcurrent/);
  });
});

describe('detectSleep', () => {
  it('fires when the wall clock ran ahead of the monotonic clock past the threshold', () => {
    const prev = { wallMs: 0, monoMs: 0 };
    expect(detectSleep(prev, { wallMs: 5_000, monoMs: 5_000 })).toEqual({ slept: false, gapMs: 0 });
    // a blocked event loop moves both clocks: no sleep
    expect(detectSleep(prev, { wallMs: 120_000, monoMs: 119_500 }).slept).toBe(false);
    // host asleep 10 minutes: wall moved, monotonic did not
    expect(detectSleep(prev, { wallMs: 605_000, monoMs: 5_000 })).toEqual({ slept: true, gapMs: 600_000 });
    // exactly at the threshold is not a sleep; a backwards wall step is not a sleep
    expect(detectSleep(prev, { wallMs: SLEEP_GAP_THRESHOLD_MS + 1000, monoMs: 1000 }).slept).toBe(false);
    expect(detectSleep(prev, { wallMs: -60_000, monoMs: 5_000 }).slept).toBe(false);
    expect(detectSleep(null, { wallMs: 1, monoMs: 1 }).slept).toBe(false);
  });
});

describe('selectEvictions', () => {
  const stores = [
    { key: 'a', mtimeMs: 1 }, { key: 'b', mtimeMs: 2 }, { key: 'c', mtimeMs: 3 }, { key: 'd', mtimeMs: 4 },
  ];

  it('keeps the newest two when nothing is referenced', () => {
    expect(selectEvictions({ stores, referenced: [] }).sort()).toEqual(['a', 'b']);
  });

  it('never evicts a referenced store, and referenced stores count toward the two', () => {
    expect(selectEvictions({ stores, referenced: ['a'] }).sort()).toEqual(['b', 'c']);
    expect(selectEvictions({ stores, referenced: ['a', 'b', 'c'] })).toEqual(['d']);
  });
});

describe('defineJobKind', () => {
  it('refuses a mutates-tree kind with no worktree provider, and an absolute or escaping entry', () => {
    expect(() => defineJobKind({ kind: 'm', entry: 'x.mjs', codeMode: 'mutates-tree' })).toThrow(/prepareWorktree/);
    expect(() => defineJobKind({ kind: 'm', entry: '/abs.mjs' })).toThrow(/repo-relative/);
    expect(() => defineJobKind({ kind: 'm', entry: '../up.mjs' })).toThrow(/repo-relative/);
    expect(() => kindRegistry([{ kind: 'x', entry: 'a' }, { kind: 'x', entry: 'b' }])).toThrow(/twice/);
  });
});


// Homebrew's v2 installed-info and outdated outputs, including formula and cask naming differences.
const WEEK = 7 * 24 * 60 * 60_000;
function watchFixture() {
  const inventory = {
    formulae: [{ name: 'gh', full_name: 'gh', installed: [{ version: '2.80.0' }], versions: { stable: '2.80.0' } }],
    casks: [
      { token: 'antigravity-cli', full_token: 'vendor/tap/antigravity-cli', installed: '1.5.11', version: '1.5.16' },
      { token: 'codex', installed: '0.60.0', version: '0.60.0' },
    ],
  };
  const outdated = { formulae: [], casks: [{ name: 'antigravity-cli', installed_versions: ['1.5.11'], current_version: '1.5.16' }] };
  let state = null, tail = Promise.resolve();
  const io = {
    env: { HOMEBREW_NO_AUTO_UPDATE: '0' },
    exec: vi.fn(async (_command, args) => ({ status: 0, stdout: JSON.stringify(args[0] === 'info' ? inventory : outdated), stderr: '' })),
    readState: vi.fn(async () => structuredClone(state)),
    writeState: vi.fn(async value => { state = structuredClone(value); }),
    // Shared across factory instances, just as the runtime's durable store lock must be.
    withLock: vi.fn((_key, action) => {
      const result = tail.then(action);
      tail = result.catch(() => {});
      return result;
    }),
    alert: vi.fn(async () => {}),
  };
  return { io, inventory, outdated, state: () => state };
}

describe('weekly tool version advisory', () => {
  it('missing inventory with positive outdated evidence stays unknown and keeps an active episode', async () => {
    const { io, inventory, state } = watchFixture();
    const job = createToolVersionWatch(io);
    await job.tick({ now: T0 });
    inventory.casks.shift();
    const result = await job.tick({ now: T0 + WEEK });
    expect(result.tools[0]).toMatchObject({ status: 'unknown', diagnostic: expect.stringMatching(/inspect.*Homebrew/i) });
    expect(state().episodes['antigravity-cli']).toBeTruthy();
    expect(io.alert).toHaveBeenCalledTimes(2);
  });

  it('a string-valued formula installed field is unknown and alerts', async () => {
    const { io, inventory } = watchFixture();
    inventory.formulae[0].installed = '2.80.0';
    const result = await createToolVersionWatch(io).tick({ now: T0 });
    expect(result.tools[2]).toMatchObject({ status: 'unknown', diagnostic: expect.stringMatching(/inspect.*Homebrew/i) });
    expect(io.alert.mock.calls.some(([event]) => event.tool === 'gh')).toBe(true);
  });

  it.each(['formula', 'cask'])('outdated evidence under the other type refuses a current %s', async type => {
    const { io, outdated } = watchFixture();
    const tool = type === 'formula' ? 'gh' : 'codex';
    outdated[type === 'formula' ? 'casks' : 'formulae'].push({
      name: `vendor/tap/${tool}`, installed_versions: ['old'], current_version: 'new',
    });
    const result = await createToolVersionWatch(io).tick({ now: T0 });
    expect(result.tools.find(item => item.tool === tool)).toMatchObject({ status: 'unknown', diagnostic: expect.stringMatching(/inspect.*Homebrew/i) });
    expect(io.alert.mock.calls.some(([event]) => event.tool === tool)).toBe(true);
  });

  it.each(['outdated', 'unknown'])('identical %s after recovery publishes a distinct episode across restarts', async status => {
    const { io, inventory, outdated, state } = watchFixture();
    const published = new Set();
    io.alert.mockImplementation(async event => { published.add(event.episode); });
    if (status === 'unknown') inventory.casks[0].installed = null;
    await createToolVersionWatch(io).tick({ now: T0 });
    const original = state().episodes['antigravity-cli'];
    await createToolVersionWatch(io).tick({ now: T0 + WEEK });
    expect(published.size).toBe(1);
    inventory.casks[0].installed = '1.5.16';
    outdated.casks = [];
    await createToolVersionWatch(io).tick({ now: T0 + 2 * WEEK });
    inventory.casks[0].installed = status === 'unknown' ? null : '1.5.11';
    outdated.casks = [{ name: 'antigravity-cli', installed_versions: ['1.5.11'], current_version: '1.5.16' }];
    await createToolVersionWatch(io).tick({ now: T0 + 3 * WEEK });
    expect(state().episodes['antigravity-cli']).not.toBe(original);
    expect(published.size).toBe(2);
    await createToolVersionWatch(io).tick({ now: T0 + 4 * WEEK });
    expect(io.alert).toHaveBeenCalledTimes(2);
  });

  it('weekly CLI watch reports outdated and unknown without self-updating', async () => {
    const { io } = watchFixture();
    const job = createToolVersionWatch(io);
    const result = await job.tick({ now: T0 });
    expect(result.tools.find(t => t.tool === 'antigravity-cli')).toMatchObject({ status: 'outdated', installed: ['1.5.11'], latest: '1.5.16' });
    expect(io.alert).toHaveBeenCalledOnce();
    io.exec.mockResolvedValue({ status: 1, stdout: '', stderr: 'unavailable' });
    const failed = await job.tick({ now: T0 + WEEK });
    expect(failed.tools.map(t => t.status)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(failed.tools.every(t => /inspect.*Homebrew/i.test(t.diagnostic))).toBe(true);
    expect(io.exec.mock.calls.every(([cmd, args]) => cmd === 'brew' && ['info', 'outdated'].includes(args[0]))).toBe(true);
  });

  it('weekly inventory resolves all tools and bounded statuses', async () => {
    const { io, inventory } = watchFixture();
    const job = createToolVersionWatch(io);
    expect(job).toMatchObject({ kind: 'tool-version-watch', intervalMs: WEEK });
    const result = await job.tick({ now: T0 });
    expect(result.nextDueAt).toBe(T0 + WEEK);
    expect(result.tools.map(t => [t.tool, t.status])).toEqual([
      ['antigravity-cli', 'outdated'], ['codex', 'current'], ['gh', 'current'], ['claude', 'not-installed'],
    ]);
    expect(result.tools[0]).toMatchObject({ package: 'vendor/tap/antigravity-cli', type: 'cask', provenance: 'homebrew' });
    expect(result.tools[2]).toMatchObject({ package: 'gh', type: 'formula', installed: ['2.80.0'], latest: '2.80.0' });
    for (const [, , options] of io.exec.mock.calls) {
      expect(options.timeout).toBe(15000);
      expect(options.maxBuffer).toBe(1048576);
      expect(options.env.HOMEBREW_NO_AUTO_UPDATE).toBe('1');
    }
    inventory.casks.push({ token: 'claude-code', installed: '2.0.0', version: '2.0.0' });
    expect((await job.tick({ now: T0 + WEEK })).tools[3]).toMatchObject({ package: 'claude-code', status: 'current' });
  });

  it('version episodes alert once without auto-upgrade', async () => {
    const { io, inventory, outdated, state } = watchFixture();
    const first = createToolVersionWatch(io), restarted = createToolVersionWatch(io);
    await Promise.all([first.tick({ now: T0 }), restarted.tick({ now: T0 })]);
    expect(io.exec).toHaveBeenCalledTimes(2);
    expect(io.alert).toHaveBeenCalledOnce();
    expect(state().nextDueAt).toBe(T0 + WEEK);
    await restarted.tick({ now: T0 + WEEK });
    expect(io.alert).toHaveBeenCalledOnce();
    inventory.casks[0].version = '1.5.17';
    outdated.casks[0].current_version = '1.5.17';
    await first.tick({ now: T0 + WEEK * 2 });
    expect(io.alert).toHaveBeenCalledTimes(2);
    inventory.casks[0].installed = '1.5.17';
    outdated.casks = [];
    await first.tick({ now: T0 + WEEK * 3 });
    inventory.casks[0].installed = '1.5.11';
    outdated.casks = [{ name: 'antigravity-cli', installed_versions: ['1.5.11'], current_version: '1.5.17' }];
    await first.tick({ now: T0 + WEEK * 4 });
    expect(io.alert).toHaveBeenCalledTimes(3);
    expect(io.exec.mock.calls.every(([, args, opts]) => ['info', 'outdated'].includes(args[0]) && opts.env.HOMEBREW_NO_AUTO_UPDATE === '1')).toBe(true);
  });

  it.each([
    ['missing brew', () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }],
    ['timeout', () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); }],
    ['nonzero exit', () => ({ status: 1, stdout: '{}', stderr: 'failed' })],
    ['malformed JSON', () => ({ status: 0, stdout: '{' })],
    ['incomplete inventory', () => ({ status: 0, stdout: '{"casks":[]}' })],
    ['oversized stdout', () => ({ status: 0, stdout: ' '.repeat(1048577) })],
    ['oversized stderr', () => ({ status: 0, stdout: '{}', stderr: 'x'.repeat(1048577) })],
  ])('%s stays unknown, alerts once, and recovers', async (_name, badRead) => {
    const { io } = watchFixture();
    const goodRead = io.exec.getMockImplementation();
    io.exec.mockImplementation(badRead);
    const job = createToolVersionWatch(io);
    const failed = await job.tick({ now: T0 });
    expect(failed.tools.every(t => t.status === 'unknown' && /inspect.*Homebrew/i.test(t.diagnostic))).toBe(true);
    expect(io.alert).toHaveBeenCalledTimes(4);
    await job.tick({ now: T0 + WEEK });
    expect(io.alert).toHaveBeenCalledTimes(4);
    io.exec.mockImplementation(goodRead);
    expect((await job.tick({ now: T0 + 2 * WEEK })).tools[1].status).toBe('current');
    expect(io.alert).toHaveBeenCalledTimes(5);
  });

  it('refuses conflicting, incomplete or ambiguous package evidence', async () => {
    const { io, inventory, outdated } = watchFixture();
    inventory.casks[1].installed = null;
    inventory.formulae.push({ name: 'codex', installed: [{ version: '1' }], versions: { stable: '1' } });
    outdated.casks[0].current_version = 'different';
    const result = await createToolVersionWatch(io).tick({ now: T0 });
    expect(result.tools[0].status).toBe('unknown');
    expect(result.tools[1].status).toBe('unknown');
    expect(result.tools[2].status).toBe('current');
  });

  it('a failed alert leaves the episode and due time retryable', async () => {
    const { io, state } = watchFixture();
    io.alert.mockRejectedValueOnce(new Error('feed unavailable'));
    const job = createToolVersionWatch(io);
    await expect(job.tick({ now: T0 })).rejects.toThrow('feed unavailable');
    expect(state()).toBeNull();
    await job.tick({ now: T0 });
    expect(io.alert).toHaveBeenCalledTimes(2);
  });

  it('unreadable or invalid persisted state refuses IO with an operator diagnostic', async () => {
    const { io } = watchFixture();
    const job = createToolVersionWatch(io);
    for (const value of [{}, { nextDueAt: 'tomorrow', episodes: {} }, { nextDueAt: T0, episodes: null }]) {
      io.readState.mockResolvedValueOnce(value);
      await expect(job.tick({ now: T0 })).rejects.toThrow(/inspect.*state/i);
    }
    io.readState.mockRejectedValueOnce(new Error('unreadable'));
    await expect(job.tick({ now: T0 })).rejects.toThrow(/inspect.*state/i);
    expect(io.exec).not.toHaveBeenCalled();
    expect(io.writeState).not.toHaveBeenCalled();
  });
});
