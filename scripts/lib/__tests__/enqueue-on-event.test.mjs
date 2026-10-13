/**
 * @file Event-driven enqueue eligibility, policy resolution, debounce, and injected fast-drain runs.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseMarkCause, isEligibleCause, parseMarkKey, notePending, duePending,
  CATCH_UP_QUERY, ENQUEUE_ON_EVENT_DEFAULTS, readCatchUpCandidates, readyAtQuery, planCatchUp,
  fastDrainArgs, summarizeFastDrain, resolveEnqueueOnEventSetting, createEnqueueOnEvent, wakeWorthy,
} from '../enqueue-on-event.mjs';

const REPO = 'web-everything/web-everything';
const GREEN = 'check_suite.completed=success@12';
const mark = (num = 42, cause = GREEN) => ({ key: `${REPO}#${num}`, cause });
const READY_PR = { state: 'OPEN', isDraft: false, labels: [{ name: 'ready-to-merge' }], statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };

function resolveSetting(tool = {}, extra = {}) {
  return resolveEnqueueOnEventSetting({
    tool, platform: undefined,
    ...extra,
    env: {
      WE_PLATFORM_PREFERENCES_FILE: join(tmpdir(), `nope-${randomUUID()}.json`),
      ...extra.env,
    },
  });
}

function setup(extra = {}) {
  let time = 1000;
  const calls = [];
  const lines = [];
  const children = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    child.finish = () => queueMicrotask(() => {
      child.stdout.emit('data', '{"considered":1,"toMerge":[{"num":42}],"failed":[],"skipReasons":[]}\n');
      queueMicrotask(() => child.emit('close', 0));
    });
    children.push(child);
    if (!extra.manualFinish) child.finish();
    return child;
  };
  const handle = createEnqueueOnEvent({
    cwd: '/clone', localSlug: REPO, scriptRoot: () => '/code', env: {},
    now: () => time, spawnImpl, log: (line) => lines.push(line),
    resolveSetting: () => ({ enabled: true, debounceSeconds: 15, line: 'x' }),
    readPr: async () => READY_PR,
    ...extra,
  });
  return { handle, calls, lines, children, advance: (ms) => { time += ms; } };
}

describe('parseMarkCause / isEligibleCause', () => {
  it.each([
    [GREEN, { type: 'check_suite', action: 'completed', label: null, conclusion: 'success' }, true],
    ['check_suite.completed=failure@12', { type: 'check_suite', action: 'completed', label: null, conclusion: 'failure' }, false],
    ['check_run.completed=success@3 via head commit', { type: 'check_run', action: 'completed', label: null, conclusion: 'success' }, true],
    ['pull_request.labeled(review:accepted)@5', { type: 'pull_request', action: 'labeled', label: 'review:accepted', conclusion: null }, true],
    ['pull_request.labeled(ready-to-merge)@5', { type: 'pull_request', action: 'labeled', label: 'ready-to-merge', conclusion: null }, true],
    ['pull_request.labeled(review:pending)@5', { type: 'pull_request', action: 'labeled', label: 'review:pending', conclusion: null }, false],
    ['pull_request.unlabeled(ready-to-merge)@5', { type: 'pull_request', action: 'unlabeled', label: 'ready-to-merge', conclusion: null }, false],
    ['pull_request_review.submitted@4', { type: 'pull_request_review', action: 'submitted', label: null, conclusion: null }, false],
    ['garbage', null, false],
    ['', null, false],
    [undefined, null, false],
  ])('parses %s and checks eligibility', (cause, parsed, eligible) => {
    expect(parseMarkCause(cause)).toEqual(parsed);
    expect(isEligibleCause(cause)).toBe(eligible);
  });
});

describe('parseMarkKey', () => {
  it('accepts numbered repo keys and rejects unknown PRs and full sweeps', () => {
    expect(parseMarkKey(`${REPO}#123`)).toEqual({ repo: REPO, num: 123 });
    expect(parseMarkKey(`${REPO}#?`)).toBeNull();
    expect(parseMarkKey('*')).toBeNull();
  });
});

describe('pending marks', () => {
  it('keeps only eligible numbered local PRs and leaves the input map untouched', () => {
    const input = new Map();
    const next = notePending(input, [
      mark(), { key: 'another/repo#42', cause: GREEN },
      { key: `${REPO}#?`, cause: GREEN }, { key: '*', cause: GREEN },
      mark(43, 'check_suite.completed=failure@12'),
    ], { localSlug: REPO, now: 1000 });
    expect(next).not.toBe(input);
    expect(input.size).toBe(0);
    expect([...next.entries()]).toEqual([[`${REPO}#42`, {
      repo: REPO, num: 42, firstAt: 1000, lastAt: 1000, causes: ['check_suite.completed=success'],
    }]]);
    const updated = notePending(next, [mark(42, 'pull_request.labeled(ready-to-merge)@5')], {
      localSlug: REPO, now: 5000,
    });
    expect(updated).not.toBe(next);
    expect(updated.get(`${REPO}#42`)).toEqual({
      repo: REPO, num: 42, firstAt: 1000, lastAt: 5000,
      causes: ['check_suite.completed=success', 'pull_request.labeled(ready-to-merge)'],
    });
    expect(next.get(`${REPO}#42`)).toEqual({
      repo: REPO, num: 42, firstAt: 1000, lastAt: 1000, causes: ['check_suite.completed=success'],
    });
  });

  it('debounces from lastAt and orders due PRs by firstAt', () => {
    let pending = notePending(new Map(), [mark(42)], { localSlug: REPO, now: 1000 });
    pending = notePending(pending, [mark(43)], { localSlug: REPO, now: 2000 });
    pending = notePending(pending, [mark(42)], { localSlug: REPO, now: 5000 });
    expect(duePending(pending, { now: 16_999, debounceSeconds: 15 })).toEqual([]);
    expect(duePending(pending, { now: 17_000, debounceSeconds: 15 }).map((p) => p.num)).toEqual([43]);
    expect(duePending(pending, { now: 19_999, debounceSeconds: 15 }).map((p) => p.num)).toEqual([43]);
    expect(duePending(pending, { now: 20_000, debounceSeconds: 15 }).map((p) => p.num)).toEqual([42, 43]);
  });
});

describe('fast drain helpers', () => {
  it('builds the exact single-PR fast drain arguments', () => {
    expect(fastDrainArgs({ scriptRoot: '/code', num: 42 })).toEqual([
      join('/code', 'scripts', 'merge-ai-prs.mjs'), '--only=42', '--label=ready-to-merge', '--this-repo', '--json',
    ]);
  });

  it.each([
    [{ failed: [{ num: 42, reason: 'refused' }] }, /^failed:/],
    [{ skipReasons: [{ num: 42, reason: 'checks pending' }] }, /^skipped:/],
    [{ toMerge: [{ num: 42 }] }, /enqueued/],
    [{ skipped: 'drain-in-progress' }, /^no-op/],
    [{ considered: 0 }, /^not listed/],
  ])('summarizes %j', (json, pattern) => {
    expect(summarizeFastDrain(json, 42)).toMatch(pattern);
  });

  it('reports an absent JSON result', () => {
    expect(summarizeFastDrain(null, 42)).toBe('no JSON result');
  });
});

describe('resolveEnqueueOnEventSetting', () => {
  it('uses standard defaults when no tool or platform block is set', () => {
    const result = resolveSetting();
    expect(result).toMatchObject({
      enabled: false, debounceSeconds: 15,
      sources: { enabled: 'standard', debounceSeconds: 'standard' }, invalid: [],
    });
    expect(result.line).toContain('mergeQueue.enqueueOnEvent');
    expect(result.line).toContain('enabled=false (standard)');
    expect(result.line).toContain('debounceSeconds=15 (standard)');
  });

  it('uses valid tool values and names their source', () => {
    const result = resolveSetting({ enabled: true, debounceSeconds: 30 });
    expect(result).toMatchObject({
      enabled: true, debounceSeconds: 30,
      sources: { enabled: 'tool', debounceSeconds: 'tool' }, invalid: [],
    });
    expect(result.line).toContain('mergeQueue.enqueueOnEvent');
    expect(result.line).toContain('enabled=true (tool)');
    expect(result.line).toContain('debounceSeconds=30 (tool)');
  });

  it('lets the env override beat the tool enabled value', () => {
    const result = resolveSetting({ enabled: true, debounceSeconds: 30 }, { env: { WE_ENQUEUE_ON_EVENT: 'off' } });
    expect(result).toMatchObject({ enabled: false, debounceSeconds: 30, sources: { enabled: 'env', debounceSeconds: 'tool' } });
    expect(result.line).toContain('mergeQueue.enqueueOnEvent');
    expect(result.line).toContain('enabled=false (env)');
    expect(result.line).toContain('debounceSeconds=30 (tool)');
  });

  it('names an explicitly injected platform source', () => {
    const result = resolveSetting({}, { platform: { enabled: true, debounceSeconds: 20 } });
    expect(result).toMatchObject({ enabled: true, debounceSeconds: 20, sources: { enabled: 'platform', debounceSeconds: 'platform' } });
    expect(result.line).toContain('mergeQueue.enqueueOnEvent');
    expect(result.line).toContain('enabled=true (platform)');
    expect(result.line).toContain('debounceSeconds=20 (platform)');
  });

  it('ignores invalid tool leaves and lists both invalid values', () => {
    const result = resolveSetting({ debounceSeconds: -1, enabled: 'yes' });
    expect(result).toMatchObject({ enabled: false, debounceSeconds: 15, sources: { enabled: 'standard', debounceSeconds: 'standard' } });
    expect(result.invalid).toEqual(expect.arrayContaining(['tool.debounceSeconds=-1', 'tool.enabled="yes"']));
    expect(result.invalid).toHaveLength(2);
    expect(result.line).toContain('ignored invalid:');
    for (const invalid of result.invalid) expect(result.line).toContain(invalid);
  });
});

describe('createEnqueueOnEvent', () => {
  it('waits for debounce, then runs the local fast drain and logs its verdict', async () => {
    const { handle, calls, lines, advance } = setup();
    handle.notePoll({ ok: true, marked: [mark()] });
    await handle.tick();
    expect(calls).toEqual([]);
    expect(handle.pending()).toHaveLength(1);
    advance(15_000);
    await handle.tick();
    expect(calls).toEqual([{
      command: process.execPath, args: fastDrainArgs({ scriptRoot: '/code', num: 42 }),
      options: { cwd: '/clone', env: {}, stdio: ['ignore', 'pipe', 'pipe'] },
    }]);
    expect(handle.pending()).toEqual([]);
    expect(lines.some((line) => line.includes('#42') && line.includes('enqueued'))).toBe(true);
  });

  it('keeps a due PR pending when the caller disallows running', async () => {
    const { handle, calls, advance } = setup({ allowed: () => false });
    handle.notePoll({ ok: true, marked: [mark()] });
    advance(15_000);
    await handle.tick();
    expect(calls).toEqual([]);
    expect(handle.pending().map((p) => p.num)).toEqual([42]);
  });

  it('clears pending PRs when the setting becomes disabled', async () => {
    let enabled = true;
    const { handle, calls, advance } = setup({
      resolveSetting: () => ({ enabled, debounceSeconds: 15, line: 'x' }),
    });
    handle.notePoll({ ok: true, marked: [mark()] });
    expect(handle.pending()).toHaveLength(1);
    enabled = false;
    advance(15_000);
    await handle.tick();
    expect(calls).toEqual([]);
    expect(handle.pending()).toEqual([]);
  });

  it('shares concurrent ticks and makes idle wait for child completion', async () => {
    const { handle, calls, children, advance } = setup({ manualFinish: true });
    handle.notePoll({ ok: true, marked: [mark()] });
    advance(15_000);
    const first = handle.tick();
    const second = handle.tick();
    expect(second).toBe(first);
    await new Promise((r) => { setImmediate(r); }); // the wake read resolves before the spawn
    expect(calls).toHaveLength(1);
    let idleResolved = false;
    const idle = handle.idle().then(() => { idleResolved = true; });
    await Promise.resolve();
    expect(idleResolved).toBe(false);
    children[0].finish();
    await Promise.all([first, second, idle]);
    expect(idleResolved).toBe(true);
    expect(calls).toHaveLength(1);
    expect(handle.pending()).toEqual([]);
    await handle.idle();
  });

  it('ignores failed polls and polls without marks', async () => {
    const { handle, calls, advance } = setup();
    handle.notePoll({ ok: false, marked: [mark()] });
    handle.notePoll({ ok: true });
    expect(handle.pending()).toEqual([]);
    advance(15_000);
    await handle.tick();
    expect(calls).toEqual([]);
  });

  it('logs spawn errors without rejecting tick', async () => {
    const { handle, lines, advance } = setup({ spawnImpl: () => { throw new Error('fake spawn failure'); } });
    handle.notePoll({ ok: true, marked: [mark()] });
    advance(15_000);
    await expect(handle.tick()).resolves.toEqual([{
      num: 42, code: null, what: 'could not run (fake spawn failure)',
    }]);
    expect(lines.some((line) => line.includes('#42') && line.includes('could not run'))).toBe(true);
    expect(handle.pending()).toEqual([]);
  });
});

describe('wakeWorthy — a wake filter, never the gate', () => {
  it('wakes only an open, non-draft ready-to-merge PR whose checks all finished; an unread PR is woken', () => {
    expect(wakeWorthy(READY_PR).wake).toBe(true);
    expect(wakeWorthy(null).wake).toBe(true);
    expect(wakeWorthy({ ...READY_PR, state: 'MERGED' }).wake).toBe(false);
    expect(wakeWorthy({ ...READY_PR, isDraft: true }).wake).toBe(false);
    expect(wakeWorthy({ ...READY_PR, labels: [{ name: 'review:pending' }] }).reason).toMatch(/no ready-to-merge/);
    expect(wakeWorthy({ ...READY_PR, statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS' }] }).reason).toMatch(/still running \(test\)/);
    expect(wakeWorthy({ ...READY_PR, statusCheckRollup: [{ __typename: 'StatusContext', context: 'ci', state: 'PENDING' }] }).wake).toBe(false);
  });

  it('skips the fast drain for a PR the filter does not wake, and logs why', async () => {
    const { handle, calls, lines, advance } = setup({ readPr: async () => ({ ...READY_PR, labels: [] }) });
    handle.notePoll({ ok: true, marked: [mark(42)] });
    advance(15_000);
    await handle.tick();
    expect(calls).toHaveLength(0);
    expect(handle.pending()).toEqual([]);
    expect(lines.some((l) => l.includes('#42') && l.includes('not woken'))).toBe(true);
  });
});

describe('summarizeFastDrain — queue-mode accounting (live 2026-10-13, #5202)', () => {
  it('reports an enqueued PR as enqueued although the drain also lists it as ready-not-reached', () => {
    const json = { considered: 1, toMerge: [{ num: 5202 }], failed: [], skipReasons: [{ num: 5202, kind: 'ready-not-reached', reason: 'ready at pass start; the pass ended before it was reached' }] };
    expect(summarizeFastDrain(json, 5202)).toMatch(/enqueued/);
  });
  it('reports a revalidation abort as not enqueued', () => {
    const json = { considered: 1, toMerge: [{ num: 7 }], revalidationAborted: [{ num: 7, reason: 'numbered card(s) on branch before enqueue' }], skipReasons: [] };
    expect(summarizeFastDrain(json, 7)).toMatch(/^not enqueued: numbered/);
  });
});

const CATCH_UP_SETTING = { enabled: true, debounceSeconds: 15, catchUp: { enabled: true, intervalMinutes: 10 } };
const candidate = (num, readyAt = null, extra = {}) => ({ num, readyAt, isDraft: false, inQueue: false, ...extra });
const catchUpSetup = (extra = {}) => setup({
  resolveSetting: () => CATCH_UP_SETTING,
  readCandidates: async () => ({ ok: true, prs: [candidate(43, 200), candidate(42, 100), candidate(44)], queued: 1 }),
  readCapacity: () => ({ capacity: 3, source: 'mergeDelivery.batchSize (tool)' }),
  ...extra,
});

describe('catch-up setting', () => {
  it('has frozen standard defaults and leaf sources', () => {
    expect(Object.isFrozen(ENQUEUE_ON_EVENT_DEFAULTS.catchUp)).toBe(true);
    expect(resolveSetting()).toMatchObject({
      catchUp: { enabled: false, intervalMinutes: 10 },
      sources: { 'catchUp.enabled': 'standard', 'catchUp.intervalMinutes': 'standard' },
    });
  });

  it('resolves tool leaves and logs their sources', () => {
    const s = resolveSetting({ catchUp: { enabled: true, intervalMinutes: 20 } });
    expect(s.catchUp).toEqual({ enabled: true, intervalMinutes: 20 });
    expect(s.sources).toMatchObject({ 'catchUp.enabled': 'tool', 'catchUp.intervalMinutes': 'tool' });
    expect(s.line).toContain(', catchUp.enabled=true (tool), catchUp.intervalMinutes=20 (tool)');
  });

  it.each([
    [{ enabled: 'yes', intervalMinutes: 0 }, ['catchUp.enabled="yes"', 'catchUp.intervalMinutes=0']],
    [{ enabled: 12, intervalMinutes: true }, ['catchUp.enabled=12', 'catchUp.intervalMinutes=true']],
  ])('falls back for invalid per-leaf values %j', (catchUp, invalid) => {
    const s = resolveSetting({ catchUp });
    expect(s.catchUp).toEqual({ enabled: false, intervalMinutes: 10 });
    expect(s.sources).toMatchObject({ 'catchUp.enabled': 'standard', 'catchUp.intervalMinutes': 'standard' });
    expect(s.invalid).toEqual(expect.arrayContaining(invalid));
    for (const value of invalid) expect(s.line).toContain(value);
  });
});

describe('planCatchUp', () => {
  const prs = [candidate(9), candidate(5, 200), candidate(4, 100), candidate(3, 100), candidate(8),
    candidate(1, 0, { isDraft: true }), candidate(2, 0, { inQueue: true }), candidate(7, 0)];
  it('skips drafts, queued and pending PRs, sorts oldest ready first and caps by room', () => {
    expect(planCatchUp({ prs, queued: 2, capacity: 5, pendingNums: [7] })).toEqual({
      run: [{ num: 3, readyAt: 100 }, { num: 4, readyAt: 100 }, { num: 5, readyAt: 200 }],
      later: [8, 9], skipped: [{ num: 1, reason: 'draft' }, { num: 2, reason: 'already queued' }, { num: 7, reason: 'already pending' }],
    });
  });
  it('never assigns negative room', () => {
    expect(planCatchUp({ prs, queued: 6, capacity: 5, pendingNums: [7] })).toMatchObject({ run: [], later: [3, 4, 5, 8, 9] });
  });
});

describe('readCatchUpCandidates', () => {
  it('lists through the GraphQL connection, then reads each open PR\'s latest ready label time per PR', async () => {
    const env = { TEST: 'yes' };
    const ready = (createdAt, name = 'ready-to-merge') => ({ createdAt, label: { name } });
    const calls = [];
    const result = await readCatchUpCandidates({ repo: REPO, env, execFileImpl: (...args) => {
      calls.push(args.slice(0, 3));
      const data = calls.length === 1
        ? { repository: {
          pullRequests: { nodes: [
            { number: 42, isDraft: false, isInMergeQueue: true },
            { number: 43, isDraft: true, isInMergeQueue: false },
            { number: 44, isDraft: false, isInMergeQueue: false },
          ] },
          mergeQueue: { entries: { totalCount: 4 } },
        } }
        : { repository: { p44: { timelineItems: { nodes: [ready('2026-10-01'), ready('2026-10-03', 'other'), ready('2026-10-02')] } } } };
      args[3](null, JSON.stringify({ data }));
    } });
    const opts = { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 };
    expect(calls).toEqual([
      ['gh', ['api', 'graphql', '-f', `query=${CATCH_UP_QUERY}`, '-F', 'owner=web-everything', '-F', 'name=web-everything'], opts],
      ['gh', ['api', 'graphql', '-f', `query=${readyAtQuery([44])}`, '-F', 'owner=web-everything', '-F', 'name=web-everything'], opts],
    ]);
    expect(result).toEqual({ ok: true, queued: 4, prs: [
      candidate(42, null, { inQueue: true }), candidate(43, null, { isDraft: true }), candidate(44, Date.parse('2026-10-02')),
    ] });
  });

  it('keeps the listing when the ready-time read fails (readyAt null, sorted last)', async () => {
    let n = 0;
    const result = await readCatchUpCandidates({ repo: REPO, execFileImpl: (_c, _a, _o, cb) => {
      n += 1;
      if (n === 1) cb(null, JSON.stringify({ data: { repository: { pullRequests: { nodes: [{ number: 7, isDraft: false, isInMergeQueue: false }] }, mergeQueue: null } } }));
      else cb(new Error('HTTP 502'));
    } });
    expect(result).toEqual({ ok: true, queued: 0, prs: [candidate(7, null)] });
  });

  it('treats a null merge queue as empty', async () => {
    expect(await readCatchUpCandidates({ repo: REPO, execFileImpl: (_cmd, _args, _opts, cb) => cb(null,
      JSON.stringify({ data: { repository: { pullRequests: { nodes: [] }, mergeQueue: null } } })),
    })).toEqual({ ok: true, prs: [], queued: 0 });
  });

  it.each([
    [null, '{"errors":[{"message":"GraphQL failed\\nextra"}]}', 'GraphQL failed'],
    [new Error('exec failed\nextra'), '', 'exec failed'],
    [null, 'invalid JSON', expect.any(String)],
  ])('reports read failure without rejection', async (error, stdout, message) => {
    expect(await readCatchUpCandidates({ repo: REPO, execFileImpl: (_cmd, _args, _opts, cb) => cb(error, stdout) }))
      .toEqual({ ok: false, error: message });
  });

  it('handles a synchronous exec exception', async () => {
    expect(await readCatchUpCandidates({ repo: REPO, execFileImpl: () => { throw new Error('spawn failed'); } }))
      .toEqual({ ok: false, error: 'spawn failed' });
  });
});

describe('catch-up handle', () => {
  it('runs at the first opportunity, oldest first within room, then only every interval', async () => {
    let reads = 0;
    const { handle, calls, lines, advance } = catchUpSetup({ readCandidates: async () => {
      reads++;
      return { ok: true, prs: [candidate(43, 200), candidate(42, 100), candidate(44)], queued: 1 };
    } });
    const ran = await handle.tick();
    expect(reads).toBe(1);
    expect(calls.map((c) => c.args[1])).toEqual(['--only=42', '--only=43']);
    expect(ran.map((p) => [p.num, p.catchUp])).toEqual([[42, true], [43, true]]);
    expect(lines).toContain('enqueue-on-event: catch-up listed 3 ready-to-merge PR(s), 1 in the merge queue, room 2 (capacity 3 from mergeDelivery.batchSize (tool)) — fast drain for #42 #43 (oldest ready first); later: #44');
    expect(lines.filter((l) => l.startsWith('enqueue-on-event: catch-up #'))).toHaveLength(4);
    expect(handle.lastCatchUpAt()).toBe(1000);
    advance(60_000);
    await handle.tick();
    expect(reads).toBe(1);
    advance(9 * 60_000);
    await handle.tick();
    expect(reads).toBe(2);
  });

  it.each([false, undefined])('does not read when catchUp.enabled is %s', async (enabled) => {
    let reads = 0;
    const { handle } = catchUpSetup({
      resolveSetting: () => ({ enabled: true, debounceSeconds: 15, ...(enabled === undefined ? {} : { catchUp: { enabled, intervalMinutes: 10 } }) }),
      readCandidates: async () => { reads++; },
    });
    await handle.tick();
    expect(reads).toBe(0);
  });

  it('waits for the allowed window without advancing lastCatchUpAt', async () => {
    let reads = 0;
    const { handle } = catchUpSetup({ allowed: () => false, readCandidates: async () => { reads++; } });
    await handle.tick();
    expect(reads).toBe(0);
    expect(handle.lastCatchUpAt()).toBeNull();
  });

  it('catchUp runs only catch-up PRs, skips event-pending PRs, and idle waits for it', async () => {
    const { handle, calls, children, advance, lines } = catchUpSetup({ manualFinish: true,
      readCapacity: () => ({ capacity: 2, source: 'test' }),
      readCandidates: async () => ({ ok: true, prs: [candidate(99, 0), candidate(42, 100)], queued: 1 }),
    });
    handle.notePoll({ ok: true, marked: [mark(99)] });
    advance(15_000);
    const run = handle.catchUp();
    await new Promise((r) => setImmediate(r));
    expect(calls.map((c) => c.args[1])).toEqual(['--only=42']);
    let idleDone = false;
    const idle = handle.idle().then(() => { idleDone = true; });
    await Promise.resolve();
    expect(idleDone).toBe(false);
    children[0].finish();
    await Promise.all([run, idle]);
    expect(idleDone).toBe(true);
    expect(handle.pending().map((p) => p.num)).toEqual([99]);
    expect(lines.some((l) => l.includes('; skipped: #99 already pending'))).toBe(true);
  });

  it('serializes catchUp after a tick and includes the waiting catch-up in idle', async () => {
    let catchEnabled = false;
    let reads = 0;
    const { handle, calls, children, advance } = catchUpSetup({ manualFinish: true,
      resolveSetting: () => ({ ...CATCH_UP_SETTING, catchUp: { enabled: catchEnabled, intervalMinutes: 10 } }),
      readCandidates: async () => { reads++; return { ok: true, prs: [candidate(43)], queued: 0 }; },
    });
    handle.notePoll({ ok: true, marked: [mark(42)] });
    advance(15_000);
    const tick = handle.tick();
    await new Promise((r) => setImmediate(r));
    catchEnabled = true;
    const catchUp = handle.catchUp();
    let idleDone = false;
    const idle = handle.idle().then(() => { idleDone = true; });
    expect(reads).toBe(0);
    children[0].finish();
    await tick;
    await new Promise((r) => setImmediate(r));
    expect(reads).toBe(1);
    expect(calls.map((c) => c.args[1])).toEqual(['--only=42', '--only=43']);
    expect(idleDone).toBe(false);
    children[1].finish();
    await Promise.all([catchUp, idle]);
    expect(idleDone).toBe(true);
  });

  it('runs a tick after an in-flight catch-up so due event PRs are also drained', async () => {
    const { handle, children, calls, advance } = catchUpSetup({ manualFinish: true,
      readCandidates: async () => ({ ok: true, prs: [candidate(43)], queued: 0 }),
    });
    handle.notePoll({ ok: true, marked: [mark(42)] });
    advance(15_000);
    const catchUp = handle.catchUp();
    await new Promise((r) => setImmediate(r));
    const tick = handle.tick();
    children[0].finish();
    await catchUp;
    await new Promise((r) => setImmediate(r));
    expect(calls.map((c) => c.args[1])).toEqual(['--only=43', '--only=42']);
    children[1].finish();
    await tick;
    expect(handle.pending()).toEqual([]);
  });

  it('keeps a catch-up PR pending if the window closes during the wake read', async () => {
    let allowed = true;
    const { handle, calls } = catchUpSetup({ allowed: () => allowed,
      readCandidates: async () => ({ ok: true, prs: [candidate(42)], queued: 0 }),
      readPr: async () => { allowed = false; return READY_PR; },
    });
    expect(await handle.catchUp()).toEqual([]);
    expect(calls).toEqual([]);
    expect(handle.pending()).toMatchObject([{ num: 42, catchUp: true }]);
  });

  it('logs candidate failure, does not spawn, and waits until the next interval to retry', async () => {
    let reads = 0;
    const { handle, calls, lines, advance } = catchUpSetup({ readCandidates: async () => {
      reads++; return { ok: false, error: 'HTTP 504' };
    } });
    await handle.tick();
    expect(lines).toContain('enqueue-on-event: catch-up could not list ready PRs (HTTP 504) — retrying in 10 min');
    expect(calls).toEqual([]);
    advance(60_000);
    await handle.tick();
    expect(reads).toBe(1);
  });

  it('uses the same wake filter and catch-up prefix for a PR not woken', async () => {
    const { handle, calls, lines } = catchUpSetup({ readPr: async () => ({ ...READY_PR, isDraft: true }) });
    const ran = await handle.catchUp();
    expect(calls).toEqual([]);
    expect(ran.every((p) => p.catchUp && p.what === 'not woken: draft')).toBe(true);
    expect(lines).toContain('enqueue-on-event: catch-up #42 catch-up — not woken: draft');
  });
});

it('reports top-level fast-drain refusal honestly', () => {
  expect(summarizeFastDrain({ ok: false, reason: 'gh-error', detail: 'gh pr list failed [network]: HTTP 504' }, 1))
    .toBe('refused: gh-error: gh pr list failed [network]: HTTP 504');
});
