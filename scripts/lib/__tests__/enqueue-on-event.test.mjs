/**
 * @file Event-driven enqueue eligibility, policy resolution, debounce, and injected fast-drain runs.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractPassTimings, parseMarkCause, isEligibleCause, parseMarkKey, notePending, duePending,
  CATCH_UP_QUERY, ENQUEUE_ON_EVENT_DEFAULTS, readCatchUpCandidates, readyAtQuery, planCatchUp,
  fastDrainArgs, summarizeFastDrain, resolveEnqueueOnEventSetting, createEnqueueOnEvent, wakeWorthy,
} from '../enqueue-on-event.mjs';
import * as enqueueModule from '../enqueue-on-event.mjs';
import { readCompletePrComments } from '../../conveyor/pr-comments-complete.mjs';
import { OPERATOR_LOGINS } from '../marker-authorship.mjs';

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
      const num = Number(args.find(a => a.startsWith('--only=')).slice('--only='.length));
      const result = extra.drainResult ? extra.drainResult(num) : extra.drainJson ?? { considered: 1, toMerge: [{ num }], failed: [], skipReasons: [] };
      child.stdout.emit('data', `${JSON.stringify(result)}\n`);
      if (extra.drainStderr) child.stderr.emit('data', extra.drainStderr);
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
    readQueueDepth: async () => ({ ok: true, queued: 0 }),
    readPr: async () => READY_PR,
    readMainFixPr: () => null, readRedMainState: () => null, readManualFreeze: () => null,
    readMembership: async () => ({ ok: true, inQueue: true, entry: { position: 1, state: 'QUEUED' }, lastEvents: [] }),
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
      command: process.execPath, args: [...fastDrainArgs({ scriptRoot: '/code', num: 42 }), '--from-green-event'],
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
      num: 42, code: null, what: 'could not run (fake spawn failure)', verified: null, outcome: 'error',
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

const CATCH_UP_SETTING = { enabled: true, debounceSeconds: 15, catchUp: { enabled: true, intervalMinutes: 10, concurrency: 1, maxQueued: 3, order: 'priority-then-first-accept' } };
const candidate = (num, readyAt = null, extra = {}) => ({ num, readyAt, isDraft: false, inQueue: false, labels: [], ...extra });
const catchUpSetup = (extra = {}) => setup({
  resolveSetting: () => CATCH_UP_SETTING,
  readCandidates: async () => ({ ok: true, prs: [candidate(43, 200), candidate(42, 100), candidate(44)], queued: 1 }),
  readCapacity: () => ({ capacity: 3, source: 'mergeQueue.enqueueOnEvent.catchUp.maxQueued (tool)' }),
  readPriorities: () => ({}),
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
    expect(s.catchUp).toEqual({ ...ENQUEUE_ON_EVENT_DEFAULTS.catchUp, enabled: true, intervalMinutes: 20 });
    expect(s.sources).toMatchObject({ 'catchUp.enabled': 'tool', 'catchUp.intervalMinutes': 'tool' });
    expect(s.line).toContain(', catchUp.enabled=true (tool), catchUp.intervalMinutes=20 (tool)');
  });

  it.each([
    [{ enabled: 'yes', intervalMinutes: 0 }, ['catchUp.enabled="yes"', 'catchUp.intervalMinutes=0']],
    [{ enabled: 12, intervalMinutes: true }, ['catchUp.enabled=12', 'catchUp.intervalMinutes=true']],
  ])('falls back for invalid per-leaf values %j', (catchUp, invalid) => {
    const s = resolveSetting({ catchUp });
    expect(s.catchUp).toEqual(ENQUEUE_ON_EVENT_DEFAULTS.catchUp);
    expect(s.sources).toMatchObject({ 'catchUp.enabled': 'standard', 'catchUp.intervalMinutes': 'standard' });
    expect(s.invalid).toEqual(expect.arrayContaining(invalid));
    for (const value of invalid) expect(s.line).toContain(value);
  });
});

describe('planCatchUp', () => {
  it.each(['now', 'urgent'])('ranks an operator priority:%s PR first even without readyAt', (value) => {
    const plan = planCatchUp({ priority: { mode: 'enforce' }, queued: 0, capacity: 1, prs: [
      candidate(42, 100), candidate(5715, null, { override: { value, byOperator: true } }),
    ] });
    expect(plan.run).toEqual([{ num: 5715, readyAt: null }]);
    expect(plan.later).toEqual([42]);
  });

  it.each(['now', 'urgent'])('does not raise rank for a non-operator priority:%s label', (value) => {
    const plan = planCatchUp({ priority: { mode: 'enforce' }, queued: 0, capacity: 1, prs: [
      candidate(5715, null, { labels: [`priority:${value}`], override: { value, byOperator: false } }),
      candidate(42, 100),
    ] });
    expect(plan.run).toEqual([{ num: 42, readyAt: 100 }]);
    expect(plan.later).toEqual([5715]);
  });

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
  it.each([
    ['now', 'operator-last', true],
    ['urgent', 'operator-last', true],
    ['now', 'non-operator-last', false],
    ['urgent', 'non-operator-last', false],
    ['now', 'missing', false],
    ['now', 'error', false],
    ['now', 'throw', false],
    ['now', 'malformed', false],
    ['now', 'non-array', false],
  ])('reads priority:%s labels and verifies event history (%s)', async (value, history, byOperator) => {
    const label = `priority:${value}`;
    const env = { TEST: 'priority' };
    const calls = [];
    const event = (login, name = label, kind = 'labeled') => ({ event: kind, label: { name }, actor: { login } });
    const operator = OPERATOR_LOGINS[0];
    const outsider = 'untrusted-priority-labeler';
    const result = await readCatchUpCandidates({ repo: REPO, env, readComments: () => [],
      execFileImpl: (cmd, args, opts, cb) => {
        calls.push(args);
        expect(cmd).toBe('gh');
        expect(opts.env).toBe(env);
        if (args[1] !== 'graphql') {
          expect(args).toEqual(['api', `repos/${REPO}/issues/5715/events`, '--paginate']);
          if (history === 'throw') throw new Error('spawn failed');
          if (history === 'error') { cb(new Error('HTTP 503')); return; }
          if (history === 'malformed') { cb(null, '{'); return; }
          if (history === 'non-array') { cb(null, '{}'); return; }
          const events = history === 'missing' ? [] : [
            event(history === 'operator-last' ? outsider : operator),
            event(history === 'operator-last' ? operator : outsider),
            event(operator, 'unrelated'), event(operator, label, 'unlabeled'),
          ];
          cb(null, JSON.stringify(events));
          return;
        }
        const listing = args.includes(`query=${CATCH_UP_QUERY}`);
        if (listing) expect(CATCH_UP_QUERY).toContain('labels(first:30){nodes{name}}');
        cb(null, JSON.stringify({ data: { repository: listing ? {
          pullRequests: { nodes: [
            { number: 5715, labels: { nodes: [{ name: 'ready-to-merge' }, { name: label }] } },
            { number: 42, labels: { nodes: [{ name: 'ready-to-merge' }] } },
          ], pageInfo: { hasNextPage: false } },
        } : {} } }));
      },
    });
    expect(result).toEqual({ ok: true, queued: 0, prs: [
      candidate(5715, null, { labels: ['ready-to-merge', label], override: { value, byOperator } }),
      candidate(42, null, { labels: ['ready-to-merge'] }),
    ] });
    expect(calls.filter(args => args[1] !== 'graphql')).toHaveLength(1);
  });

  it('considers a ready candidate after a full page of drafts', async () => {
    const calls = [];
    const result = await readCatchUpCandidates({ repo: REPO, readComments: () => [], execFileImpl: (_cmd, args, _opts, cb) => {
      calls.push(args);
      const repository = calls.length === 1
        ? { pullRequests: {
          nodes: Array.from({ length: 100 }, (_, i) => ({ number: i + 1, isDraft: true })),
          pageInfo: { hasNextPage: true, endCursor: 'page-one' },
        }, mergeQueue: { entries: { totalCount: 2 } } }
        : calls.length === 2
          ? { pullRequests: { nodes: [{ number: 101, isDraft: false, isInMergeQueue: false }],
            pageInfo: { hasNextPage: false, endCursor: 'page-two' } } }
          : { p101: { timelineItems: { nodes: [{ createdAt: '2026-10-01', label: { name: 'ready-to-merge' } }] } } };
      cb(null, JSON.stringify({ data: { repository } }));
    } });
    expect(result.ok).toBe(true);
    expect(planCatchUp({ ...result, capacity: 3 }).run.map((p) => p.num)).toEqual([101]);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain('cursor=page-one');
    expect(result.prs[100].readyAt).toBe(Date.parse('2026-10-01'));
    const { handle, calls: drains } = catchUpSetup({ readCandidates: async () => result });
    const ran = await handle.catchUp();
    expect(ran.map((p) => p.num)).toEqual([101]);
    expect(drains.map((c) => c.args[1])).toEqual(['--only=101']);
  });

  it('refuses a partial listing when a later page fails', async () => {
    let calls = 0;
    const result = await readCatchUpCandidates({ repo: REPO, readComments: () => [], execFileImpl: (_cmd, _args, _opts, cb) => {
      if (++calls === 1) cb(null, JSON.stringify({ data: { repository: {
        pullRequests: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'next' } },
      } } }));
      else cb(new Error('HTTP 504'));
    } });
    expect(result).toEqual({ ok: false, error: 'HTTP 504' });
    expect(calls).toBe(2);
  });

  it('bounds ready-time reads across pages and preserves successful batches on a time-read failure', async () => {
    const calls = [];
    const result = await readCatchUpCandidates({ repo: REPO, readComments: () => [], execFileImpl: (_cmd, args, _opts, cb) => {
      calls.push(args);
      const n = calls.length;
      if (n <= 2) {
        const nodes = Array.from({ length: n === 1 ? 100 : 1 }, (_, i) => ({ number: n === 1 ? i + 1 : 101 }));
        cb(null, JSON.stringify({ data: { repository: { pullRequests: { nodes,
          pageInfo: { hasNextPage: n === 1, endCursor: `page-${n}` },
        }, mergeQueue: null } } }));
      } else if (n === 3) cb(new Error('HTTP 502'));
      else cb(null, JSON.stringify({ data: { repository: {
        p101: { timelineItems: { nodes: [{ createdAt: '2026-10-01', label: { name: 'ready-to-merge' } }] } },
      } } }));
    } });
    expect(result.ok).toBe(true);
    expect(result.prs).toHaveLength(101);
    expect(calls).toHaveLength(4);
    expect(calls[2]).toContain(`query=${readyAtQuery(Array.from({ length: 100 }, (_, i) => i + 1))}`);
    expect(calls[3]).toContain(`query=${readyAtQuery([101])}`);
    expect(result.prs[0].readyAt).toBeNull();
    expect(result.prs[100].readyAt).toBe(Date.parse('2026-10-01'));
  });

  it.each([null, 'same'])('refuses a missing or repeated continuation cursor (%s)', async (cursor) => {
    let calls = 0;
    const result = await readCatchUpCandidates({ repo: REPO, readComments: () => [], execFileImpl: (_cmd, _args, _opts, cb) => {
      calls += 1;
      cb(null, JSON.stringify({ data: { repository: { pullRequests: {
        nodes: [], pageInfo: { hasNextPage: true, endCursor: cursor },
      } } } }));
    } });
    expect(result).toEqual({ ok: false, error: 'invalid pullRequests pagination cursor' });
    expect(calls).toBe(cursor ? 2 : 1);
  });

  it('refuses a listing without pagination metadata', async () => {
    expect(await readCatchUpCandidates({ repo: REPO, readComments: () => [], execFileImpl: (_cmd, _args, _opts, cb) => {
      cb(null, JSON.stringify({ data: { repository: { pullRequests: { nodes: [] } } } }));
    } })).toEqual({ ok: false, error: 'no pullRequests pageInfo in the GraphQL answer' });
  });

  it('lists through the GraphQL connection, then reads each open PR\'s latest ready label time per PR', async () => {
    const env = { TEST: 'yes' };
    const ready = (createdAt, name = 'ready-to-merge') => ({ createdAt, label: { name } });
    const calls = [];
    const result = await readCatchUpCandidates({ repo: REPO, readComments: () => [], env, execFileImpl: (...args) => {
      calls.push(args.slice(0, 3));
      const data = calls.length === 1
        ? { repository: {
          pullRequests: { nodes: [
            { number: 42, isDraft: false, isInMergeQueue: true },
            { number: 43, isDraft: true, isInMergeQueue: false },
            { number: 44, isDraft: false, isInMergeQueue: false },
          ], pageInfo: { hasNextPage: false, endCursor: null } },
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
    const result = await readCatchUpCandidates({ repo: REPO, readComments: () => [], execFileImpl: (_c, _a, _o, cb) => {
      n += 1;
      if (n === 1) cb(null, JSON.stringify({ data: { repository: { pullRequests: { nodes: [{ number: 7, isDraft: false, isInMergeQueue: false }], pageInfo: { hasNextPage: false, endCursor: null } }, mergeQueue: null } } }));
      else cb(new Error('HTTP 502'));
    } });
    expect(result).toEqual({ ok: true, queued: 0, prs: [candidate(7, null)] });
  });

  it('treats a null merge queue as empty', async () => {
    expect(await readCatchUpCandidates({ repo: REPO, readComments: () => [], execFileImpl: (_cmd, _args, _opts, cb) => cb(null,
      JSON.stringify({ data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, mergeQueue: null } } })),
    })).toEqual({ ok: true, prs: [], queued: 0 });
  });

  it.each([
    [null, '{"errors":[{"message":"GraphQL failed\\nextra"}]}', 'GraphQL failed'],
    [new Error('exec failed\nextra'), '', 'exec failed'],
    [null, 'invalid JSON', expect.any(String)],
  ])('reports read failure without rejection', async (error, stdout, message) => {
    expect(await readCatchUpCandidates({ repo: REPO, readComments: () => [], execFileImpl: (_cmd, _args, _opts, cb) => cb(error, stdout) }))
      .toEqual({ ok: false, error: message });
  });

  it('handles a synchronous exec exception', async () => {
    expect(await readCatchUpCandidates({ repo: REPO, readComments: () => [], execFileImpl: () => { throw new Error('spawn failed'); } }))
      .toEqual({ ok: false, error: 'spawn failed' });
  });
});

describe('catch-up handle', () => {
  it.each([
    ['10 minutes after child end', 10, null, true],
    ['16 minutes after child end', 16, null, false],
    ['enqueue retry deadline passed', 10, 'enqueueFailures', false],
    ['requested red-team retry deadline passed', 10, 'redTeamPending', true],
    ['unattempted red-team retry deadline passed', 10, 'redTeamPending', false, null],
  ])('measures unchanged hold age from child completion: %s', async (_name, minutesAfterEnd, retryState, skips, requestedAt = 1_000) => {
    const head = 'a'.repeat(40);
    const state = retryState ? { [retryState]: { [`${REPO}#42`]: {
      headSha: head, retryAt: 1_000 + 600_000 + 5 * 60_000,
      firstPendingAt: 1_000, requestedAt,
    } } } : {};
    const f = catchUpSetup({
      resolveSetting: () => ({ ...CATCH_UP_SETTING, catchUp: { ...CATCH_UP_SETTING.catchUp, intervalMinutes: 1 } }),
      resolveThroughput: () => ({ value: { catchUpSkipUnchangedHolds: true, catchUpSkipMaxMin: 15 } }),
      readCandidates: async () => ({ ok: true, queued: 0, prs: [candidate(42, 100)] }),
      readPr: async () => ({ ...READY_PR, headRefOid: head }),
      readHoldEvidence: () => ({ recorded: false }),
      readHoldQueueState: () => state,
      resolveQueueSafety: () => ({ value: { redTeamPendingMaxMin: 60, redTeamRequestCooldownMin: 3 } }),
      drainResult: () => {
        f.advance(600_000);
        return { considered: 1, skipReasons: [{ num: 42, kind: 'red-team-pending', reason: 'waiting' }] };
      },
    });
    try {
      await f.handle.catchUp();
      expect(f.calls).toHaveLength(1);
      f.advance(minutesAfterEnd * 60_000);
      const result = await f.handle.catchUp();
      expect(f.calls).toHaveLength(skips ? 1 : 2);
      if (skips) {
        expect(result).toEqual([expect.objectContaining({ num: 42, what: 'unchanged hold: red-team-pending', outcome: 'skipped' })]);
      } else {
        expect(result.some(row => row.what.startsWith('unchanged hold'))).toBe(false);
      }
    } finally { f.handle.kill(); }
  });

  it.each([
    ['gate skip', { considered: 1, toMerge: [], skipReasons: [{ num: 1, reason: 'checks failing' }] }],
    ['revalidation abort', { considered: 1, toMerge: [{ num: 1 }], revalidationAborted: [{ num: 1, reason: 'blockedBy' }] }],
    ['dependency deferral', { considered: 1, toMerge: [{ num: 1 }], deferred: [{ num: 1, waitOn: [99] }], skipReasons: [{ num: 1, kind: 'blocked-by' }] }],
    ['couple hold', { considered: 1, toMerge: [{ num: 1 }], coupleHeld: [{ num: 1, reason: 'partner held' }] }],
    ['parked candidate', { considered: 1, toMerge: [{ num: 1 }], parked: [{ num: 1, reasons: ['review pending'] }] }],
  ])('tries a later candidate after a confirmed %s', async (_name, skipped) => {
    const { handle, calls } = catchUpSetup({
      readCapacity: () => ({ capacity: 1, source: 'test' }),
      readCandidates: async () => ({ ok: true, queued: 0, prs: [1, 2, 3].map(num => candidate(num, num)) }),
      readPr: async ({ num }) => num === 1 ? { ...READY_PR, statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }] } : READY_PR,
      drainResult: num => num === 1 ? skipped : { considered: 1, toMerge: [{ num }], skipReasons: [{ num, reason: 'ready-not-reached' }] },
    });
    await handle.catchUp();
    expect(calls.map(c => c.args[1])).toEqual(['--only=1', '--only=2']);
  });

  it.each([
    null,
    { ok: false, reason: 'gh-error' },
    { considered: 1, failed: [{ num: 1 }], skipReasons: [{ num: 1, reason: 'merge-failed' }] },
    { considered: 1, toMerge: [{ num: 1 }], skipReasons: [{ num: 1, kind: 'ready-not-reached' }] },
    { considered: 1, toMerge: [{ num: 1 }], pendingRebased: [1], failed: [], merged: [], skipReasons: [{ num: 1, kind: 'rebuilt-pending-ci' }] },
  ])('keeps room consumed for an ambiguous drain result %j', async (result) => {
    const { handle, calls } = catchUpSetup({
      readCapacity: () => ({ capacity: 1, source: 'test' }),
      readCandidates: async () => ({ ok: true, queued: 0, prs: [candidate(1, 0), candidate(2, 1)] }),
      drainResult: () => result,
    });
    await handle.catchUp();
    await handle.tick();
    expect(calls.map(c => c.args[1])).toEqual(['--only=1']);
  });

  it.each(['tick', 'catchUp'])('%s proceeds past older unwakeable PRs without exceeding room', async (method) => {
    const wakeReads = [];
    const { handle, calls, advance } = catchUpSetup({
      readCapacity: () => ({ capacity: 1, source: 'test' }),
      readCandidates: async () => ({ ok: true, queued: 0, prs: [candidate(1, 0), candidate(2, 1), candidate(3, 2)] }),
      readPr: async ({ num }) => {
        wakeReads.push(num);
        return num === 1 ? { ...READY_PR, statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS' }] } : READY_PR;
      },
    });
    for (let interval = 0; interval < 3; interval++) {
      await handle[method]();
      advance(10 * 60_000);
    }
    expect(wakeReads).toEqual([1, 2, 1, 3, 1, 2, 1, 3, 1, 2, 1, 3]);
    expect(calls.map(c => c.args[1])).toEqual(['--only=2', '--only=2', '--only=2']);
  });

  it.each(['tick', 'catchUp'])('%s counts retained work against the next interval capacity', async (method) => {
    let allowed = true;
    let closeDuringRead = true;
    const { handle, calls, advance } = catchUpSetup({
      allowed: () => allowed,
      readCapacity: () => ({ capacity: 2, source: 'test' }),
      readCandidates: async () => ({ ok: true, queued: 0, prs: [1, 2, 3, 4].map(num => candidate(num, num)) }),
      readPr: async () => { if (closeDuringRead) allowed = false; return READY_PR; },
    });
    await handle[method]();
    expect(handle.pending().map(p => p.num)).toEqual([2, 1]);
    closeDuringRead = false;
    allowed = true;
    advance(10 * 60_000);
    await handle[method]();
    expect(calls.map(c => c.args[1])).toEqual(['--only=1', '--only=2']);
  });

  it('limits retained work when the queue fills while the window is closed', async () => {
    let allowed = true;
    let queued = 0;
    const { handle, calls, advance } = catchUpSetup({
      allowed: () => allowed,
      readCapacity: () => ({ capacity: 2, source: 'test' }),
      readCandidates: async () => ({ ok: true, queued, prs: [1, 2, 3].map(num => candidate(num, num)) }),
      readPr: async () => { if (!queued) allowed = false; return READY_PR; },
    });
    await handle.catchUp();
    queued = 1;
    allowed = true;
    advance(10 * 60_000);
    await handle.catchUp();
    await handle.tick();
    expect(calls.map(c => c.args[1])).toEqual(['--only=1']);
    expect(handle.pending().map(p => p.num)).toEqual([2]);
  });

  it('replaces an unwakeable retained reservation with a later candidate', async () => {
    let allowed = true;
    let reopened = false;
    const { handle, calls, advance } = catchUpSetup({
      allowed: () => allowed,
      readCapacity: () => ({ capacity: 2, source: 'test' }),
      readCandidates: async () => ({ ok: true, queued: 0, prs: [1, 2, 3, 4].map(num => candidate(num, num)) }),
      readPr: async ({ num }) => {
        if (!reopened) allowed = false;
        return reopened && num === 1 ? { ...READY_PR, state: 'CLOSED' } : READY_PR;
      },
    });
    await handle.catchUp();
    reopened = allowed = true;
    advance(10 * 60_000);
    await handle.catchUp();
    expect(calls.map(c => c.args[1])).toEqual(['--only=2', '--only=3']);
  });

  it('holds retained work when the next queue snapshot is unreadable', async () => {
    let allowed = true;
    let listingFails = false;
    const { handle, calls, advance } = catchUpSetup({
      allowed: () => allowed,
      readCandidates: async () => listingFails ? { ok: false, error: 'HTTP 504' }
        : { ok: true, queued: 0, prs: [candidate(1)] },
      readPr: async () => { if (!listingFails) allowed = false; return READY_PR; },
    });
    await handle.catchUp();
    listingFails = allowed = true;
    advance(10 * 60_000);
    await handle.catchUp();
    await handle.tick();
    expect(calls).toEqual([]);
    expect(handle.pending().map(p => p.num)).toEqual([1]);
  });

  it('runs at the first opportunity, oldest first within room, and uses the busy interval for remaining work', async () => {
    let reads = 0;
    const { handle, calls, lines, advance } = catchUpSetup({ readCandidates: async () => {
      reads++;
      return { ok: true, prs: [candidate(43, 200), candidate(42, 100), candidate(44)], queued: 1 };
    } });
    const ran = await handle.tick();
    expect(reads).toBe(1);
    expect(calls.map((c) => c.args[1])).toEqual(['--only=42', '--only=43']);
    expect(ran.map((p) => [p.num, p.catchUp])).toEqual([[42, true], [43, true]]);
    expect(lines).toContain('enqueue-on-event: catch-up listed 3 ready-to-merge PR(s), 1 in the merge queue, room 2 (capacity 3 from mergeQueue.enqueueOnEvent.catchUp.maxQueued (tool)) — fast drain for #42 #43 (priority-then-first-accept); later: #44');
    expect(lines.filter((l) => l.startsWith('enqueue-on-event: catch-up #'))).toHaveLength(4);
    expect(handle.lastCatchUpAt()).toBe(1000);
    advance(60_000);
    await handle.tick();
    expect(reads).toBe(2);
    advance(9 * 60_000);
    await handle.tick();
    expect(reads).toBe(3);
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

  it.each(['tick', 'catchUp'])('%s drops retained catch-up work once catch-up is disabled', async (method) => {
    let allowed = true;
    let setting = CATCH_UP_SETTING;
    const { handle, calls, advance } = catchUpSetup({
      allowed: () => allowed,
      resolveSetting: () => setting,
      readCapacity: () => ({ capacity: 1, source: 'test' }),
      readCandidates: async () => ({ ok: true, prs: [candidate(42)], queued: 0 }),
      readPr: async () => { if (setting.catchUp.enabled) allowed = false; return READY_PR; },
    });
    await handle.catchUp();
    expect(handle.pending()).toMatchObject([{ num: 42, catchUp: true }]);
    setting = { ...CATCH_UP_SETTING, catchUp: { ...CATCH_UP_SETTING.catchUp, enabled: false } };
    allowed = true;
    advance(10 * 60_000);
    await handle[method]();
    expect(calls).toEqual([]);
    expect(handle.pending()).toEqual([]);
  });

  it.each([
    ['catch-up is disabled', (s) => ({ ...s, catchUp: { ...s.catchUp, enabled: false } })],
    ['enqueue-on-event is disabled', (s) => ({ ...s, enabled: false })],
  ])('stops catch-up work in the same run once %s during a fast drain', async (_name, change) => {
    let setting = CATCH_UP_SETTING;
    const { handle, calls } = catchUpSetup({
      resolveSetting: () => setting,
      readCandidates: async () => ({ ok: true, queued: 0, prs: [1, 2, 3, 4].map(num => candidate(num, num)) }),
      drainResult: (num) => { setting = change(CATCH_UP_SETTING); return { considered: 1, toMerge: [], skipReasons: [{ num, reason: 'checks failing' }] }; },
    });
    await handle.catchUp();
    expect(calls.map(c => c.args[1])).toEqual(['--only=1']);
    expect(handle.pending()).toEqual([]);
  });

  it.each(['tick', 'catchUp'])('%s shrinks retained room when maxQueued is lowered before the next snapshot', async (method) => {
    let allowed = true;
    let capacity = 3;
    const { handle, calls } = catchUpSetup({
      allowed: () => allowed,
      readCapacity: () => ({ capacity, source: 'test' }),
      readCandidates: async () => ({ ok: true, queued: 0, prs: [1, 2, 3].map(num => candidate(num, num)) }),
      readPr: async () => { if (capacity === 3) allowed = false; return READY_PR; },
    });
    await handle.catchUp();
    expect(handle.pending()).toHaveLength(3);
    capacity = 1;
    allowed = true;
    await handle[method]();
    expect(calls.map(c => c.args[1])).toEqual(['--only=1']);
  });

  it('keeps an event on a retained catch-up PR as ordinary event work once catch-up is disabled', async () => {
    let allowed = true;
    let setting = CATCH_UP_SETTING;
    const { handle, calls, advance } = catchUpSetup({
      allowed: () => allowed,
      resolveSetting: () => setting,
      readCapacity: () => ({ capacity: 1, source: 'test' }),
      readCandidates: async () => ({ ok: true, prs: [candidate(42)], queued: 0 }),
      readPr: async () => { if (setting.catchUp.enabled) allowed = false; return READY_PR; },
    });
    await handle.catchUp();
    handle.notePoll({ ok: true, marked: [mark(42)] });
    setting = { ...CATCH_UP_SETTING, catchUp: { ...CATCH_UP_SETTING.catchUp, enabled: false } };
    allowed = true;
    advance(15_000);
    const ran = await handle.tick();
    expect(calls.map(c => c.args[1])).toEqual(['--only=42']);
    expect(ran[0].catchUp).toBeUndefined();
    expect(handle.pending()).toEqual([]);
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

describe('catch-up fill and stable acceptance ordering', () => {
  it('resolves and logs maxQueued and order with their sources', () => {
    const s = resolveSetting({ catchUp: { maxQueued: 12, order: 'priority-then-first-accept' } });
    expect(s.catchUp.maxQueued).toBe(12);
    expect(s.line).toContain('catchUp.maxQueued=12 (tool)');
    expect(s.line).toContain('catchUp.order=priority-then-first-accept (tool)');
  });

  it('fills to maxQueued even when build batchSize is five', async () => {
    const { handle, calls } = catchUpSetup({
      resolveSetting: () => resolveSetting({ ...CATCH_UP_SETTING, catchUp: { ...CATCH_UP_SETTING.catchUp, maxQueued: 12 } }),
      readCapacity: undefined,
      readCandidates: async () => ({ ok: true, queued: 5, prs: Array.from({ length: 10 }, (_, i) => candidate(100 + i, i)) }),
    });
    await handle.catchUp();
    expect(calls).toHaveLength(7);
  });

  it('drains a P0 ahead of build.priority and older acceptances', async () => {
    const { handle, calls } = catchUpSetup({
      readPriorities: () => ({ priority: { mode: 'enforce' }, buildPriority: ['7'], mainFix: { repo: 'we', pr: 99 } }),
      readCandidates: async () => ({ ok: true, queued: 1, prs: [candidate(7, 0, { firstAcceptedAt: 0, itemIds: ['7'] }), candidate(99, 900)] }),
    });
    await handle.catchUp();
    expect(calls.map(c => c.args[1])).toEqual(['--only=99', '--only=7']);
  });

  it('uses build.priority list order within a class', () => {
    const plan = planCatchUp({ capacity: 3, queued: 0, buildPriority: ['8', '7'], prs: [
      candidate(1, 0), candidate(2, 200, { itemIds: ['7'] }), candidate(3, 300, { itemIds: ['8'] }),
    ] });
    expect(plan.run.map(p => p.num)).toEqual([3, 2, 1]);
  });

  it('retains first acceptance across heads and restore, and falls back to ready time', async () => {
    const at = t => Date.parse(`2026-10-13T${t}:00Z`);
    const result = await readCatchUpCandidates({ repo: REPO, readComments: (num, { repo }) => {
      expect(repo).toBe(REPO);
      return num === 5027 ? [] : [
        { body: '✅ review — accepted\n<!-- reviewed-sha: original -->', createdAt: `2026-10-13T${num === 5025 ? '16:49' : '17:00'}:00Z` },
        ...(num === 5025 ? [{ body: '✅ review — `review:human` cleared via the sanctioned path\n<!-- reviewed-sha: restored -->', createdAt: '2026-10-13T19:11:00Z' }] : []),
      ];
    }, execFileImpl: (_cmd, _args, _opts, cb) => {
      const query = _args.find(a => a.startsWith('query='));
      const repository = query.includes('pullRequests(') ? {
        pullRequests: { nodes: [5025, 5026, 5027].map(number => ({ number })), pageInfo: { hasNextPage: false } },
        mergeQueue: { entries: { totalCount: 0 } },
      } : Object.fromEntries([5025, 5026, 5027].map(num => [`p${num}`, {
        timelineItems: { nodes: [{ createdAt: `2026-10-13T${num === 5025 ? '19:11' : num === 5026 ? '17:00' : '18:00'}:00Z`, label: { name: 'ready-to-merge' } }] },

      }]));
      cb(null, JSON.stringify({ data: { repository } }));
    } });
    expect(result.prs[0].firstAcceptedAt).toBe(at('16:49'));
    const { handle, calls } = catchUpSetup({ readCandidates: async () => result, readCapacity: () => ({ capacity: 3, source: 'test' }) });
    await handle.catchUp();
    expect(calls.map(c => c.args[1])).toEqual(['--only=5025', '--only=5026', '--only=5027']);
    expect(planCatchUp({ ...result, capacity: 3, order: 'oldest-ready' }).run.map(p => p.num)).toEqual([5026, 5027, 5025]);
  });
});

it('reads an acceptance beyond the first comments page', async () => {
  let calls = 0;
  const result = await readCatchUpCandidates({ repo: REPO,
    readComments: (number, opts) => readCompletePrComments(number, { ...opts, exec: (cmd, args) => {
      expect(cmd).toBe('gh');
      expect(args).toContain('--paginate');
      expect(args).toContain(`repos/${REPO}/issues/42/comments`);
      // gh --paginate emits all pages through the shared reader's TSV projection.
      return Array.from({ length: 100 }, () => 'ordinary comment\t2026-10-01\tbot').join('\n') +
        '\n✅ review — `review:human` cleared via the sanctioned path\t2026-10-02\tbot\n';
    } }),
    execFileImpl: (_cmd, args, _opts, cb) => {
      calls++;
      const repository = calls === 1 ? {
        pullRequests: { nodes: [{ number: 42 }], pageInfo: { hasNextPage: false } },
        mergeQueue: { entries: { totalCount: 0 } },
      } : { p42: { timelineItems: { nodes: [] } } };
      expect(args.find(a => a.startsWith('query='))).not.toContain('comments(');
      cb(null, JSON.stringify({ data: { repository } }));
    },
  });
  expect(calls).toBe(2);
  expect(result.prs[0].firstAcceptedAt).toBe(Date.parse('2026-10-02'));
});

it('keeps ready time when the complete comment read fails', async () => {
  const result = await readCatchUpCandidates({ repo: REPO,
    readComments: (number, opts) => readCompletePrComments(number, { ...opts, exec: () => { throw new Error('HTTP 502'); } }),
    execFileImpl: (_cmd, args, _opts, cb) => {
      const repository = args.includes(`query=${CATCH_UP_QUERY}`) ? {
        pullRequests: { nodes: [{ number: 42 }], pageInfo: { hasNextPage: false } },
      } : { p42: { timelineItems: { nodes: [{ createdAt: '2026-10-02', label: { name: 'ready-to-merge' } }] } } };
      cb(null, JSON.stringify({ data: { repository } }));
    },
  });
  expect(result).toEqual({ ok: true, queued: 0, prs: [candidate(42, Date.parse('2026-10-02'))] });
});

it('uses oldest-ready fallback when acceptance history cannot be read', async () => {
  const { handle, calls } = catchUpSetup({ readCandidates: async () => ({ ok: true, queued: 1,
    prs: [candidate(7, 200), candidate(8, 100)],
  }) });
  await handle.catchUp();
  expect(calls.map(c => c.args[1])).toEqual(['--only=8', '--only=7']);
});


describe('actual enqueue outcomes and membership', () => {
  const membershipSetup = (extra = {}) => catchUpSetup({ readCandidates: async () => ({ ok: true, prs: [candidate(42)], queued: 0 }), ...extra });
  it('reports the live batching deferral instead of the pre-enqueue toMerge verdict', () => {
    expect(summarizeFastDrain({ toMerge: [{ num: 5025 }], enqueueOutcomes: [{ num: 5025, outcome: 'not-enqueued', kind: 'batching-deferred', reason: 'queue holds 2 group(s) (max 2)' }] }, 5025))
      .toBe('not enqueued: batching-deferred: queue holds 2 group(s) (max 2)');
  });

  it('uses recorded success, already queued, missing outcomes and legacy results', () => {
    const enqueued = 'passed every drain gate — enqueued';
    expect(summarizeFastDrain({ enqueueOutcomes: [{ num: 42, outcome: 'enqueued', already: false }] }, 42)).toBe(enqueued);
    expect(summarizeFastDrain({ enqueueOutcomes: [{ num: 42, outcome: 'enqueued', already: true }] }, 42)).toBe(enqueued + ' (already queued)');
    expect(summarizeFastDrain({ toMerge: [{ num: 42 }], enqueueOutcomes: [] }, 42)).toBe('not enqueued: no enqueue outcome recorded');
    expect(summarizeFastDrain({ toMerge: [{ num: 42 }] }, 42)).toBe(enqueued);
    expect(summarizeFastDrain({ enqueueOutcomes: [{ num: 42, outcome: 'not-enqueued', kind: 'merge-lock-held', reason: 'x'.repeat(300) }] }, 42).length).toBeLessThanOrEqual(200);
  });

  it.each([false, true])('verifies a legacy enqueue claim against GitHub (inQueue=%s)', async (inQueue) => {
    const reads = [];
    const { handle, lines } = membershipSetup({ readMembership: async (args) => {
      reads.push(args); return { ok: true, inQueue, entry: { position: 2, state: 'QUEUED' }, lastEvents: [] };
    } });
    const ran = await handle.catchUp();
    expect(reads).toEqual([{ repo: REPO, num: 42 }]);
    expect(ran[0].verified).toBe(inQueue);
    expect(ran[0].what).toContain(inQueue ? 'verified: isInMergeQueue=true, position 2, state QUEUED' : 'NOT enqueued: the fast drain claimed enqueued but GitHub isInMergeQueue=false');
    expect(lines.some(line => line.includes(ran[0].what))).toBe(true);
    expect(handle.misses().get(42)).toBe(inQueue ? undefined : 1);
  });

  it('counts consecutive misses, logs at each threshold, retries, and resets on verified success', async () => {
    let inQueue = false;
    const { handle, lines, advance } = membershipSetup({ readMembership: async () => ({ ok: true, inQueue, lastEvents: [] }) });
    for (let i = 0; i < 3; i++) { await handle.catchUp(); advance(600_000); }
    expect(handle.misses().get(42)).toBe(3);
    expect(lines.filter(line => line.includes('SMELL enqueue-not-entering'))).toHaveLength(1);
    for (let i = 0; i < 3; i++) { await handle.catchUp(); advance(600_000); }
    expect(lines.filter(line => line.includes('SMELL enqueue-not-entering'))).toHaveLength(2);
    const snapshot = handle.misses(); snapshot.clear();
    expect(handle.misses().get(42)).toBe(6);
    inQueue = true;
    await handle.catchUp();
    expect(handle.misses().has(42)).toBe(false);
  });

  it('includes queue timeline evidence and the collapsed last 300 stderr characters in a miss', async () => {
    const { handle } = membershipSetup({ drainStderr: 'x'.repeat(400) + '\n batching   blocked',
      readMembership: async () => ({ ok: true, inQueue: false, lastEvents: [{ __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-10-14', reason: 'checks failed' }] }),
    });
    const [ran] = await handle.catchUp();
    expect(ran.what).toContain('RemovedFromMergeQueueEvent at 2026-10-14: checks failed');
    expect(ran.what).toContain('fast-drain stderr: ' + ('x'.repeat(400) + ' batching blocked').slice(-300));
  });

  it('does not count failed membership reads as misses', async () => {
    const { handle } = membershipSetup({ readMembership: async () => ({ ok: false, error: 'HTTP 504' }) });
    const ran = await handle.catchUp();
    expect(ran[0]).toMatchObject({ verified: null, what: 'passed every drain gate — enqueued (unverified: HTTP 504)' });
    expect(handle.misses().size).toBe(0);
  });

  it('stops remaining catch-up admissions on batching deferral but runs event-origin PRs', async () => {
    const drains = [];
    const { handle, lines, advance } = membershipSetup({
      readCapacity: () => ({ capacity: 3, source: 'test' }),
      readCandidates: async () => ({ ok: true, queued: 0, prs: [candidate(42, 0), candidate(43, 1), candidate(44, 2)] }),
      spawnImpl: (_command, args) => {
        const num = Number(args[1].split('=')[1]); drains.push(num);
        if (drains.length === 1) { handle.notePoll({ ok: true, marked: [mark(99)] }); advance(15_000); }
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
        queueMicrotask(() => {
          child.stdout.emit('data', JSON.stringify({ toMerge: [{ num }], enqueueOutcomes: [{ num, outcome: 'not-enqueued', kind: 'batching-deferred', reason: 'queue holds 2 group(s) (max 2)' }] }));
          child.emit('close', 0);
        });
        return child;
      },
    });
    await handle.tick();
    expect(drains).toEqual([42, 99]);
    expect(handle.pending()).toEqual([]);
    expect(lines).toContain('enqueue-on-event: catch-up stopping this round — batching deferred #42 (queue holds 2 group(s) (max 2)); 2 PR(s) retried at the next catch-up');
    expect(handle.misses().get(42)).toBe(1);
    advance(600_000);
    await handle.tick();
    expect(drains).toEqual([42, 99, 42]);
  });

  it('resolves the miss threshold and falls back on invalid settings', () => {
    const s = resolveSetting({ catchUp: { missSmellAfter: 5 } });
    expect(s.catchUp.missSmellAfter).toBe(5);
    expect(s.line).toContain('catchUp.missSmellAfter=5 (tool)');
    for (const missSmellAfter of [0, -1, 'x']) {
      const invalid = resolveSetting({ catchUp: { missSmellAfter } });
      expect(invalid.catchUp.missSmellAfter).toBe(3);
      expect(invalid.invalid.join(' ')).toContain('catchUp.missSmellAfter=');
    }
  });

  it('reads queue entry and recent timeline through repo-scoped GraphQL', async () => {
    const pr = { isInMergeQueue: false, mergeQueueEntry: null, timelineItems: { nodes: [{ __typename: 'RemovedFromMergeQueueEvent', reason: 'checks failed', createdAt: '2026-10-14' }] } };
    const result = await enqueueModule.readMergeQueueMembership({ repo: REPO, num: 42, env: {}, execFileImpl: (cmd, args, opts, cb) => {
      expect(cmd).toBe('gh'); expect(args).toContain('owner=web-everything'); expect(args).toContain('name=web-everything');
      const query = args.find(a => a.startsWith('query='));
      expect(query).toContain('pullRequest(number:42)'); expect(query).toContain('isInMergeQueue');
      expect(query).toContain('ADDED_TO_MERGE_QUEUE_EVENT'); expect(query).toContain('REMOVED_FROM_MERGE_QUEUE_EVENT');
      expect(opts.env).toEqual({}); cb(null, JSON.stringify({ data: { repository: { pullRequest: pr } } }));
    } });
    expect(result).toEqual({ ok: true, inQueue: false, entry: null, lastEvents: pr.timelineItems.nodes });
  });

  it.each(['throw', 'errors', 'missing', 'invalid'])('never throws on a membership read failure (%s)', async (mode) => {
    const result = await enqueueModule.readMergeQueueMembership({ repo: REPO, num: 42, execFileImpl: (_cmd, _args, _opts, cb) => {
      if (mode === 'throw') throw new Error('spawn failed');
      cb(null, mode === 'errors' ? '{"errors":[{"message":"denied"}]}' : mode === 'missing' ? '{"data":{"repository":{}}}' : 'oops');
    } });
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
  });
});


describe('BLOCKED catch-up back-off', () => {
  const reason = 'merge state BLOCKED (branch protection unsatisfied: required checks pending or red, or an uncleared review) — owned by the ci-heal / review daemons, nothing for the drain to rebase; required-checks-not-successful: merge-gate (failure); merge-gate hold review-acceptance not cleared on this head';
  const head = { ...READY_PR, headRefOid: 'abcdef123456789', statusCheckRollup: [...READY_PR.statusCheckRollup, { context: 'merge-gate', state: 'FAILURE' }] };
  const blockedSetup = (extra = {}) => catchUpSetup({
    resolveSetting: () => resolveSetting({ ...CATCH_UP_SETTING, catchUp: { ...CATCH_UP_SETTING.catchUp, blockedBackoffRounds: 2 } }),
    readCandidates: async () => ({ ok: true, queued: 0, prs: [candidate(5193, 0), candidate(42, 1), candidate(43, 2), candidate(44, 3)] }),
    readPr: async () => head,
    drainResult: num => num === 5193 ? { considered: 1, skipReasons: [{ num, reason }] } : { toMerge: [{ num }] },
    ...extra,
  });
  const nums = calls => calls.map(c => Number(c.args[1].split('=')[1]));

  it('resolves the default, cascade overrides, zero, and invalid leaves', () => {
    expect(ENQUEUE_ON_EVENT_DEFAULTS.catchUp.blockedBackoffRounds).toBe(6);
    expect(resolveSetting().catchUp.blockedBackoffRounds).toBe(6);
    expect(resolveSetting({}, { platform: { catchUp: { blockedBackoffRounds: 4 } } }).catchUp.blockedBackoffRounds).toBe(4);
    for (const blockedBackoffRounds of [0, 2]) {
      const s = resolveSetting({ catchUp: { blockedBackoffRounds } });
      expect(s.catchUp.blockedBackoffRounds).toBe(blockedBackoffRounds);
      expect(s.line).toContain(`catchUp.blockedBackoffRounds=${blockedBackoffRounds} (tool)`);
    }
    for (const blockedBackoffRounds of [-1, 1.5, 'x', true]) {
      const s = resolveSetting({ catchUp: { blockedBackoffRounds } });
      expect(s.catchUp.blockedBackoffRounds).toBe(6);
      expect(s.invalid.join(' ')).toContain('catchUp.blockedBackoffRounds=');
    }
  });

  it('signs the head and sorted check states, and returns null for unreadable heads', () => {
    const signature = enqueueModule.prHeadSignature(head);
    expect(signature).toEqual(enqueueModule.prHeadSignature({ ...head, statusCheckRollup: [...head.statusCheckRollup].reverse() }));
    expect(signature).not.toEqual(enqueueModule.prHeadSignature({ ...head, headRefOid: 'different' }));
    expect(signature).not.toEqual(enqueueModule.prHeadSignature({ ...head, statusCheckRollup: [{ ...head.statusCheckRollup[0], conclusion: 'FAILURE' }] }));
    for (const pr of [null, undefined, {}, { headRefOid: '' }, { headRefOid: 42 }]) expect(enqueueModule.prHeadSignature(pr)).toBeNull();
  });

  it('reads the head SHA with the wake checks', async () => {
    await enqueueModule.readPrForWake({ repo: REPO, num: 5193, execFileImpl: (_cmd, args, _opts, cb) => {
      expect(args[args.indexOf('--json') + 1].split(',')).toEqual(expect.arrayContaining(['headRefOid', 'statusCheckRollup']));
      cb(null, JSON.stringify(head));
    } });
  });

  it('continues and refills every round, skips the next N listings, then retries and re-arms', async () => {
    const { handle, calls, lines, advance } = blockedSetup();
    await handle.catchUp();
    expect(nums(calls)).toEqual([5193, 42, 43, 44]);
    expect(handle.blocked().has(5193)).toBe(true);
    handle.blocked().clear();
    expect(handle.blocked().has(5193)).toBe(true);
    for (let i = 0; i < 2; i++) {
      advance(600_000);
      const ran = await handle.catchUp();
      expect(ran[0]).toMatchObject({ num: 5193, catchUp: true, what: expect.stringMatching(/^backed off:/) });
      expect(nums(calls).filter(n => n === 5193)).toHaveLength(1);
      expect(nums(calls).slice(-3)).toEqual([42, 43, 44]);
      expect(lines).toContain(`enqueue-on-event: catch-up #5193 — backed off: BLOCKED at head abcdef123 (${2 - i} of 2 catch-up(s) left; retried sooner if its head or checks change)`);
      await handle.tick(); // another tick is not another listing
      expect(nums(calls).filter(n => n === 5193)).toHaveLength(1);
    }
    advance(600_000);
    await handle.catchUp();
    expect(nums(calls).filter(n => n === 5193)).toHaveLength(2);
    expect(handle.blocked().has(5193)).toBe(true);
  });

  it.each(['head', 'checks', 'unreadable'])('retries when the %s changes', async (change) => {
    let pr = head;
    const { handle, calls, advance } = blockedSetup({ readPr: async () => pr });
    await handle.catchUp(); advance(600_000);
    pr = change === 'head' ? { ...head, headRefOid: 'new-head' } : change === 'checks' ? { ...head, statusCheckRollup: [{ ...head.statusCheckRollup[0], conclusion: 'FAILURE' }] } : null;
    await handle.catchUp();
    expect(nums(calls).filter(n => n === 5193)).toHaveLength(2);
    if (!pr) expect(handle.blocked().has(5193)).toBe(false);
  });

  it('disables back-off at zero', async () => {
    const { handle, calls, advance } = blockedSetup({ resolveSetting: () => resolveSetting({ ...CATCH_UP_SETTING, catchUp: { ...CATCH_UP_SETTING.catchUp, blockedBackoffRounds: 0 } }) });
    await handle.catchUp(); advance(600_000); await handle.catchUp();
    expect(nums(calls).filter(n => n === 5193)).toHaveLength(2);
    expect(handle.blocked().size).toBe(0);
  });

  it('runs an event wake despite back-off and clears it on enqueue', async () => {
    let blocked = true;
    const { handle, calls, advance } = blockedSetup({ drainResult: num => blocked && num === 5193 ? { skipReasons: [{ num, reason }] } : { toMerge: [{ num }] } });
    await handle.catchUp();
    handle.notePoll({ ok: true, marked: [mark(5193)] }); advance(15_000);
    await handle.tick();
    expect(nums(calls).filter(n => n === 5193)).toHaveLength(2);
    expect(handle.blocked().has(5193)).toBe(true);
    blocked = false;
    handle.notePoll({ ok: true, marked: [mark(5193)] }); advance(15_000);
    await handle.tick();
    expect(handle.blocked().has(5193)).toBe(false);
  });

  it.each(['merge-gate hold review-acceptance not cleared on this head', 'unrelated gate skip'])('only backs off the targeted gate skips (%s)', async (skip) => {
    const { handle, calls, advance } = blockedSetup({ drainResult: num => num === 5193 ? { skipReasons: [{ num, reason: skip }] } : { toMerge: [{ num }] } });
    await handle.catchUp(); advance(600_000); await handle.catchUp();
    expect(nums(calls).filter(n => n === 5193)).toHaveLength(skip.startsWith('merge-gate hold') ? 1 : 2);
  });

  it('bypasses back-off for an event folded into retained catch-up work', async () => {
    let closeDuringRead = false;
    let allowed = true;
    const { handle, calls, advance } = blockedSetup({ allowed: () => allowed, readPr: async ({ num }) => {
      if (num === 5193 && closeDuringRead) allowed = false;
      return head;
    } });
    await handle.catchUp(); advance(600_000);
    closeDuringRead = true;
    await handle.catchUp();
    expect(handle.pending().some(p => p.num === 5193 && p.catchUp)).toBe(true);
    handle.notePoll({ ok: true, marked: [mark(5193)] }); advance(15_000);
    closeDuringRead = false; allowed = true;
    await handle.tick();
    expect(nums(calls).filter(n => n === 5193)).toHaveLength(2);
  });

  it.each(['CLOSED', 'MERGED', 'unlabeled'])('clears back-off on a %s wake read', async (state) => {
    let pr = head;
    const { handle, advance } = blockedSetup({ readPr: async () => pr });
    await handle.catchUp();
    pr = state === 'unlabeled' ? { ...head, labels: [] } : { ...head, state };
    handle.notePoll({ ok: true, marked: [mark(5193)] }); advance(15_000);
    await handle.tick();
    expect(handle.blocked().has(5193)).toBe(false);
  });

  it('clears entries for PRs absent from the next listing', async () => {
    let prs = [candidate(5193)];
    const { handle, advance } = blockedSetup({ readCandidates: async () => ({ ok: true, queued: 0, prs }) });
    await handle.catchUp(); prs = []; advance(600_000); await handle.catchUp();
    expect(handle.blocked().size).toBe(0);
  });
});


describe('fast-drain timeout settings and outcomes', () => {
  it('resolves timeoutSeconds defaults, cascade sources, boundaries and invalid values', () => {
    expect(ENQUEUE_ON_EVENT_DEFAULTS.timeoutSeconds).toBe(600);
    expect(resolveSetting()).toMatchObject({ timeoutSeconds: 600, sources: { timeoutSeconds: 'standard' } });
    expect(resolveSetting({}, { platform: { timeoutSeconds: 120 } }).line).toContain('timeoutSeconds=120 (platform)');
    for (const timeoutSeconds of [60, 900, 3600]) {
      expect(resolveSetting({ timeoutSeconds }).line).toContain(`timeoutSeconds=${timeoutSeconds} (tool)`);
    }
    for (const timeoutSeconds of [59, 3601, 60.5, '600', true]) {
      const s = resolveSetting({ timeoutSeconds });
      expect(s).toMatchObject({ timeoutSeconds: 600, sources: { timeoutSeconds: 'standard' } });
      expect(s.invalid.join(' ')).toContain('timeoutSeconds=');
    }
  });

  it('resolves timeoutBackoffRounds defaults, cascade sources, zero and invalid values', () => {
    expect(ENQUEUE_ON_EVENT_DEFAULTS.catchUp.timeoutBackoffRounds).toBe(3);
    expect(resolveSetting().line).toContain('catchUp.timeoutBackoffRounds=3 (standard)');
    expect(resolveSetting({}, { platform: { catchUp: { timeoutBackoffRounds: 4 } } }).line).toContain('catchUp.timeoutBackoffRounds=4 (platform)');
    for (const timeoutBackoffRounds of [0, 2]) {
      expect(resolveSetting({ catchUp: { timeoutBackoffRounds } }).line).toContain(`catchUp.timeoutBackoffRounds=${timeoutBackoffRounds} (tool)`);
    }
    for (const timeoutBackoffRounds of [-1, 1.5, 'x', true]) {
      const s = resolveSetting({ catchUp: { timeoutBackoffRounds } });
      expect(s.catchUp.timeoutBackoffRounds).toBe(3);
      expect(s.sources['catchUp.timeoutBackoffRounds']).toBe('standard');
      expect(s.invalid.join(' ')).toContain('catchUp.timeoutBackoffRounds=');
    }
  });

  it.each([
    [{ summary: 'passed every drain gate — enqueued (already queued)' }, 'enqueued'],
    [{ summary: 'not enqueued: batching-deferred: full' }, 'not-enqueued'],
    [{ summary: 'NOT enqueued: GitHub isInMergeQueue=false' }, 'not-enqueued'],
    [{ summary: 'skipped: merge state BLOCKED' }, 'skipped'],
    [{ summary: 'not listed (closed)' }, 'not-listed'],
    [{ summary: 'refused: unsafe' }, 'refused'],
    [{ summary: 'could not run (spawn failed)' }, 'error'],
    [{ summary: 'no JSON result', error: 'spawn failed' }, 'error'],
    [{ summary: 'no JSON result', timedOut: true }, 'timeout'],
    [{ summary: 'passed every drain gate — enqueued', timedOut: true, error: 'killed' }, 'timeout'],
    [{ summary: 'no verdict for the PR' }, 'other'],
    [{ summary: 'no JSON result' }, 'other'],
    [{}, 'other'],
  ])('classifies %j as %s', (input, outcome) => {
    expect(enqueueModule.fastDrainOutcome(input)).toBe(outcome);
  });

  it.each([undefined, 1000])('uses the setting timeout unless timeoutMs=%s overrides it', async timeoutMs => {
    vi.useFakeTimers();
    try {
      const { handle, children, advance, lines } = setup({ manualFinish: true,
        resolveSetting: () => resolveSetting({ enabled: true, timeoutSeconds: 60 }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      handle.notePoll({ ok: true, marked: [mark()] }); advance(15_000);
      const run = handle.tick();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      const kill = vi.fn(() => children[0].emit('close', null));
      children[0].kill = kill;
      const duration = timeoutMs ?? 60_000;
      await vi.advanceTimersByTimeAsync(duration - 1);
      expect(kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(kill).toHaveBeenCalledWith('SIGTERM');
      expect(await run).toMatchObject([{ num: 42, outcome: 'timeout', what: `timed out after ${duration / 1000}s with no JSON result` }]);
      expect(lines.some(l => l.includes(`timed out after ${duration / 1000}s with no JSON result`) && l.endsWith(' [outcome=timeout]'))).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe('timeout catch-up back-off', () => {
  const head = { ...READY_PR, headRefOid: 'abcdef123456789' };
  const timedSetup = (extra = {}) => catchUpSetup({ manualFinish: true, timeoutMs: 1000,
    resolveSetting: () => resolveSetting({ ...CATCH_UP_SETTING, catchUp: { ...CATCH_UP_SETTING.catchUp, timeoutBackoffRounds: 2 } }),
    readCandidates: async () => ({ ok: true, queued: 0, prs: [candidate(42)] }),
    readPr: async () => head,
    ...extra,
  });
  const timeOut = async (fixture, run) => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
    const child = fixture.children.at(-1);
    child.kill = () => child.emit('close', null);
    await vi.advanceTimersByTimeAsync(1000);
    return run;
  };

  it('skips N rounds, waits the full idle interval, then retries and re-arms', async () => {
    vi.useFakeTimers();
    try {
      const f = timedSetup();
      expect(await timeOut(f, f.handle.catchUp())).toMatchObject([{ outcome: 'timeout' }]);
      expect(f.handle.blocked().get(42)).toMatchObject({ rounds: 2, untilRound: 3, reason: 'timeout' });
      f.advance(60_000); await f.handle.catchUp();
      expect(f.calls).toHaveLength(1);
      f.advance(540_000);
      for (let i = 0; i < 2; i++) {
        const ran = await f.handle.catchUp();
        expect(ran).toMatchObject([{ num: 42, outcome: 'skipped' }]);
        expect(f.lines).toContain(`enqueue-on-event: catch-up #42 — backed off: fast drain TIMED OUT at head abcdef123 (${2 - i} of 2 catch-up(s) left; retried sooner if its head or checks change)`);
        expect(f.calls).toHaveLength(1);
        f.advance(600_000);
      }
      await timeOut(f, f.handle.catchUp());
      expect(f.calls).toHaveLength(2);
      expect(f.handle.blocked().get(42)).toMatchObject({ untilRound: 6, reason: 'timeout' });
    } finally { vi.useRealTimers(); }
  });

  it.each(['head', 'checks', 'unreadable', 'disabled', 'event'])('retries immediately after %s changes or bypasses the hold', async change => {
    vi.useFakeTimers();
    try {
      let pr = head; let rounds = 2;
      const f = timedSetup({ readPr: async () => pr,
        resolveSetting: () => resolveSetting({ ...CATCH_UP_SETTING, catchUp: { ...CATCH_UP_SETTING.catchUp, timeoutBackoffRounds: rounds } }),
      });
      await timeOut(f, f.handle.catchUp());
      expect(f.handle.blocked().get(42)?.reason).toBe('timeout');
      if (change === 'head') pr = { ...head, headRefOid: 'new-head' };
      if (change === 'checks') pr = { ...head, statusCheckRollup: [{ ...head.statusCheckRollup[0], conclusion: 'FAILURE' }] };
      if (change === 'unreadable') pr = null;
      if (change === 'disabled') rounds = 0;
      let run;
      if (change === 'event') {
        f.handle.notePoll({ ok: true, marked: [mark()] }); f.advance(15_000);
        run = f.handle.tick();
      } else { f.advance(600_000); run = f.handle.catchUp(); }
      for (let i = 0; i < 40; i++) await Promise.resolve();
      expect(f.calls).toHaveLength(2);
      f.children.at(-1).finish();
      expect(await run).toMatchObject([{ outcome: 'enqueued' }]);
      expect(f.handle.blocked().size).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['closed', 'unlabelled', 'absent', 'not-listed'])('clears a timeout hold when the PR is %s', async change => {
    vi.useFakeTimers();
    try {
      let pr = head; let prs = [candidate(42)];
      const f = timedSetup({ readPr: async () => pr, readCandidates: async () => ({ ok: true, queued: 0, prs }), drainJson: {} });
      await timeOut(f, f.handle.catchUp());
      expect(f.handle.blocked().get(42)?.reason).toBe('timeout');
      if (change === 'closed') pr = { ...head, state: 'CLOSED' };
      if (change === 'unlabelled') pr = { ...head, labels: [] };
      if (change === 'absent') prs = [];
      f.advance(600_000);
      if (change === 'not-listed') f.handle.notePoll({ ok: true, marked: [mark()] });
      f.advance(15_000);
      const run = change === 'not-listed' ? f.handle.tick() : f.handle.catchUp();
      for (let i = 0; i < 40; i++) await Promise.resolve();
      if (change === 'not-listed') f.children.at(-1).finish();
      await run;
      expect(f.handle.blocked().size).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe('concurrent catch-up rounds', () => {
  const concurrent = (extra = {}) => catchUpSetup({
    manualFinish: true,
    resolveSetting: () => ({ ...CATCH_UP_SETTING, catchUp: { ...CATCH_UP_SETTING.catchUp, concurrency: 3, busyIntervalSeconds: 60 } }),
    readCapacity: () => ({ capacity: 8, source: 'test' }),
    readCandidates: async () => ({ ok: true, queued: 0, prs: [1, 2, 3, 4, 5].map(n => candidate(n, n)) }),
    ...extra,
  });
  const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

  it.each([1, 3])('bounds active drains at concurrency %s and suppresses repeated events for an active PR', async concurrency => {
    const { handle, calls, children, advance } = concurrent({
      resolveSetting: () => ({ ...CATCH_UP_SETTING, catchUp: { ...CATCH_UP_SETTING.catchUp, concurrency } }),
    });
    const round = handle.tick();
    await flush();
    expect(calls).toHaveLength(concurrency);
    handle.notePoll({ ok: true, marked: [mark(1)] });
    advance(15_000);
    children[0].finish();
    await flush();
    expect(calls).toHaveLength(concurrency + 1);
    for (let i = 1; i < 5; i++) { children[i]?.finish(); await flush(); }
    await round;
    expect(calls.map(c => c.args[1])).toEqual([1, 2, 3, 4, 5].map(n => `--only=${n}`));
  });

  it('rechecks room before each start, accounting for active reservations', async () => {
    let reads = 0;
    const { handle, calls, children } = concurrent({ readQueueDepth: async () => ({ ok: true, queued: ++reads === 1 ? 0 : 7 }) });
    const round = handle.catchUp();
    await flush();
    expect(calls).toHaveLength(1);
    children[0].finish();
    await round;
    expect(calls).toHaveLength(1);
    expect(reads).toBeGreaterThan(1);
  });

  it('stops new starts after batching defers without cancelling siblings', async () => {
    const { handle, calls, children } = concurrent({ drainResult: num => num === 1
      ? { enqueueOutcomes: [{ num, outcome: 'not-enqueued', kind: 'batching-deferred', reason: 'full' }] }
      : { toMerge: [{ num }] } });
    const round = handle.catchUp();
    await flush();
    expect(calls).toHaveLength(3);
    children[0].finish();
    await flush();
    expect(calls).toHaveLength(3);
    children[1].finish(); children[2].finish();
    expect(await round).toHaveLength(3);
  });

  it('isolates child failure and kills every active child on shutdown', async () => {
    const { handle, calls, children } = concurrent();
    const round = handle.catchUp();
    await flush();
    children[0].emit('error', new Error('failed'));
    await flush();
    expect(calls).toHaveLength(4);
    let killed = 0;
    for (const c of children.slice(1)) c.kill = () => { killed++; c.emit('close', 143); };
    handle.kill();
    await flush();
    children[4]?.finish();
    await round;
    expect(killed).toBe(3);
  });

  it('uses the busy interval from round completion when room and runnable work remain', async () => {
    let listings = 0;
    const { handle, advance } = concurrent({ manualFinish: false,
      readCandidates: async () => { listings++; return { ok: true, queued: 0, prs: [candidate(1)] }; },
      drainJson: { failed: [{ num: 1 }] },
    });
    await handle.catchUp();
    advance(59_000);
    await handle.catchUp();
    expect(listings).toBe(1);
    advance(1000);
    await handle.catchUp();
    expect(listings).toBe(2);
  });

  it('waits the full interval when live room is full or remaining PRs are queued', async () => {
    for (const snapshot of [{ ok: true, queued: 8 }, { ok: true, queued: 1, queuedNums: [1] }]) {
      let listings = 0;
      const { handle, advance } = concurrent({ manualFinish: false,
        readQueueDepth: async () => snapshot,
        readCandidates: async () => { listings++; return { ok: true, queued: 0, prs: [candidate(1)] }; },
      });
      await handle.catchUp();
      advance(60_000);
      await handle.catchUp();
      expect(listings).toBe(1);
      advance(540_000);
      await handle.catchUp();
      expect(listings).toBe(2);
    }
  });

  it('measures the busy delay after a long round completes', async () => {
    let listings = 0;
    const { handle, children, advance } = concurrent({
      readCandidates: async () => { listings++; return { ok: true, queued: 0, prs: [candidate(1)] }; },
      drainJson: { failed: [{ num: 1 }] },
    });
    const round = handle.catchUp();
    await flush();
    advance(20 * 60_000);
    children[0].finish();
    await round;
    await handle.catchUp();
    expect(listings).toBe(1);
    advance(60_000);
    const next = handle.catchUp();
    await flush();
    expect(listings).toBe(2);
    children[1].finish();
    await next;
  });

  it('a timed out PR frees only its own slot while siblings keep running', async () => {
    vi.useFakeTimers();
    try {
      const { handle, children, calls } = concurrent({ timeoutMs: 1000 });
      const round = handle.catchUp();
      await flush();
      const killed = [];
      children.forEach((child, index) => { child.kill = () => { killed.push(index); child.emit('close', 143); }; });
      children[1].finish(); children[2].finish();
      await flush();
      expect(calls).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(1000);
      expect(killed).toEqual([0]);
      children[3].finish(); children[4].finish();
      expect(await round).toHaveLength(5);
    } finally { vi.useRealTimers(); }
  });

  it('cascade-resolves and logs the new leaves and rejects invalid values', () => {
    const s = resolveSetting({ catchUp: { concurrency: 1 } }, { platform: { catchUp: { concurrency: 5, busyIntervalSeconds: 30 } } });
    expect(s.catchUp).toMatchObject({ concurrency: 1, busyIntervalSeconds: 30 });
    expect(s.line).toContain('catchUp.concurrency=1 (tool)');
    expect(s.line).toContain('catchUp.busyIntervalSeconds=30 (platform)');
    expect(resolveSetting({ catchUp: { concurrency: 0, busyIntervalSeconds: -1 } }).catchUp).toMatchObject({ concurrency: 3, busyIntervalSeconds: 60 });
  });
});


describe('child pass timings', () => {
  const phases = 'listing=1ms listing.snapshot=2ms listing.target=3ms verdicts=4ms total=10ms';
  it('extracts the last pass timings from stderr with trailing skip reasons', () => {
    expect(extractPassTimings(`starting\nmerge-ai-prs · pass timings: listing=9ms total=20ms (considered 2)\nother\nmerge-ai-prs · pass timings: ${phases} (considered 1, merged 0)\n{"skipReasons":[]}\n`)).toBe(phases);
  });
  it('returns null when stderr contains no pass timings', () => {
    expect(extractPassTimings('starting\n{"skipReasons":[]}\n')).toBeNull();
  });
  it.each(['close', 'error'])('logs split timings after they leave the stderr tail on child %s', async (event) => {
    const { handle, lines, advance, children } = setup({ manualFinish: true });
    handle.notePoll({ ok: true, marked: [mark()] });
    advance(15_000);
    const tick = handle.tick();
    await new Promise((r) => setImmediate(r));
    const child = children[0];
    child.stderr.emit('data', 'merge-ai-prs · pass tim');
    child.stderr.emit('data', `ings: ${phases} (considered 1)\n${'x'.repeat(2500)}\n`);
    child.stdout.emit('data', JSON.stringify({ considered: 1, toMerge: [{ num: 42 }], failed: [], skipReasons: [] }));
    child.emit(event, event === 'close' ? 0 : new Error('fake child error'));
    await tick;
    expect(lines.find((line) => line.includes('fast drain exit'))).toContain(` · phases: ${phases}`);
  });
});


describe('pre-staged green events', () => {
  it('runs immediately before catch-up listing, even with optional checks pending', async () => {
    const readCandidates = vi.fn();
    const prestageCache = { get: () => ({ eligible: true }), drop: vi.fn() };
    const { handle, calls } = setup({ prestageCache, readCandidates,
      readPr: async () => ({ ...READY_PR, labels: [{ name: 'review:accepted' }, { name: 'ready-to-merge' }],
        statusCheckRollup: [{ name: 'optional', status: 'IN_PROGRESS' }] }),
      resolveSetting: () => ({ enabled: true, debounceSeconds: 15, catchUp: { enabled: true, intervalMinutes: 10 } }),
    });
    handle.notePoll({ ok: true, marked: [mark()] });
    await handle.tick();
    expect(readCandidates).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('--from-green-event');
  });
  it.each([[], ['checking']])('does not wake a cached PR without ready-to-merge (%j)', async (...labels) => {
    const prestageCache = { get: () => ({ eligible: true }), drop: vi.fn() };
    const { handle, calls } = setup({ prestageCache,
      readPr: async () => ({ ...READY_PR, labels: [{ name: 'review:accepted' }, ...labels.map(name => ({ name }))] }),
    });
    handle.notePoll({ ok: true, marked: [mark()] });
    await handle.tick();
    expect(calls).toHaveLength(0);
    expect(handle.pending()).toHaveLength(0);
  });
  const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
  const pendingChecks = { ok: true, prestaged: true, considered: 1, merged: [], failed: [],
    enqueueOutcomes: [{ num: 42, outcome: 'not-enqueued', kind: 'prestage', reason: 'required checks pending' }] };
  it.each([
    ['a green check', mark(42, 'check_suite.completed=success@13')],
    ['an eligibility label', mark(42, 'pull_request.labeled(ready-to-merge)@13')],
  ])('re-wakes a PR when %s arrives during its own run', async (_, late) => {
    const prestageCache = { get: () => ({ eligible: true }), drop: vi.fn() };
    const { handle, calls, children, advance } = setup({ prestageCache, manualFinish: true, drainJson: pendingChecks });
    handle.notePoll({ ok: true, marked: [mark()] });
    const first = handle.tick();
    await flush();
    expect(calls).toHaveLength(1);
    handle.notePoll({ ok: true, marked: [late] });
    await flush();
    expect(calls).toHaveLength(1);
    children[0].finish();
    await first;
    advance(15_000); // a label wake is not a staged green event: it keeps the ordinary debounce
    const second = handle.tick();
    await flush();
    expect(calls).toHaveLength(2);
    children[1].finish();
    await second;
    expect(handle.pending()).toHaveLength(0);
  });
  it('drops a wake that arrived during a run which verified the enqueue', async () => {
    const prestageCache = { get: () => ({ eligible: true }), drop: vi.fn() };
    const { handle, calls, children } = setup({ prestageCache, manualFinish: true });
    handle.notePoll({ ok: true, marked: [mark()] });
    const first = handle.tick();
    await flush();
    handle.notePoll({ ok: true, marked: [mark(42, 'check_suite.completed=success@13')] });
    children[0].finish();
    await first;
    expect(handle.pending()).toHaveLength(0);
    await handle.tick();
    expect(calls).toHaveLength(1);
  });
  it.each(['success', 'skipped', 'neutral', 'cancelled', 'failure', 'timed_out', 'action_required', 'stale', 'startup_failure', null])('keeps the green wake after an unattributed %s event', async conclusion => {
    const prestageCache = { get: () => ({ eligible: true }), drop: vi.fn() };
    const { handle, calls } = setup({ prestageCache });
    handle.notePoll({ ok: true, marked: [mark()] });
    handle.notePoll({ ok: true, marked: [mark(42, `check_run.completed${conclusion ? `=${conclusion}` : ''}@13`)] });
    await handle.tick();
    expect(prestageCache.drop).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(handle.pending()).toHaveLength(0);
  });
});

describe('red-main scheduling', () => {
  const mainFix = { repo: 'we', pr: 42, prs: [42], expiresAt: 1e15 };
  it('runs an event-only main fix first in catchUpOnly without debounce, and waits before starting catch-up', async () => {
    const f = catchUpSetup({ manualFinish: true,
      readMainFixPr: () => mainFix,
      resolveThroughput: () => ({ value: { redMainSkipCatchUp: false } }),
      resolveSetting: () => ({ ...CATCH_UP_SETTING, catchUp: { ...CATCH_UP_SETTING.catchUp, concurrency: 3 } }),
      readCandidates: async () => ({ ok: true, queued: 0, prs: [candidate(43), candidate(42)] }),
    });
    try {
      f.handle.notePoll({ ok: true, marked: [mark(42)] });
      const run = f.handle.catchUp();
      for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r));
      expect(f.calls.map(c => c.args.find(a => a.startsWith('--only=')))).toEqual(['--only=42']);
      expect(f.lines.join('\n')).not.toContain('#42 already pending');
      f.children[0].finish();
      for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r));
      f.children.slice(1).forEach(c => c.finish());
      await run;
      expect(f.calls.map(c => c.args.find(a => a.startsWith('--only=')))).toEqual(['--only=42', '--only=43']);
      expect(f.lines).toContain('enqueue-on-event: main-fix #42 first (red main)');
    } finally { f.handle.kill(); }
  });
  it('starts no other catch-up PR while the main-fix catch-up drain is active', async () => {
    const f = catchUpSetup({ manualFinish: true, readMainFixPr: () => mainFix,
      resolveThroughput: () => ({ value: { redMainSkipCatchUp: false } }),
      resolveSetting: () => ({ ...CATCH_UP_SETTING, catchUp: { ...CATCH_UP_SETTING.catchUp, concurrency: 3 } }),
      readCandidates: async () => ({ ok: true, queued: 0, prs: [candidate(42), candidate(43)] }),
    });
    try {
      const run = f.handle.catchUp();
      for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r));
      expect(f.calls.map(c => c.args[1])).toEqual(['--only=42']);
      f.children[0].finish();
      for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r));
      expect(f.calls.map(c => c.args[1])).toEqual(['--only=42', '--only=43']);
      f.children[1].finish();
      await run;
    } finally { f.handle.kill(); }
  });
  it.each([
    ['on', 'on', mainFix, true, [42]],
    ['off', 'on', mainFix, false, [42, 43]],
    ['on', 'off', mainFix, false, [42, 43]],
    ['on', 'on', { ...mainFix, repo: 'fui' }, true, []],
  ])('catch-up skip %s, hold %s, ownership %j', async (skip, hold, priority, logsSkip, expected) => {
    const f = catchUpSetup({ readMainFixPr: () => priority,
      readRedMainState: () => ({ red: true, expiresAt: 1e15 }),
      readManualFreeze: () => null,
      resolveRedMainHold: () => ({ value: hold }),
      resolveThroughput: () => ({ value: { redMainSkipCatchUp: skip === 'on' }, sources: { redMainSkipCatchUp: 'tool' } }),
      readPriorities: () => ({ mainFix: priority }),
      readCandidates: async () => ({ ok: true, queued: 0, prs: [candidate(42), candidate(43)] }),
    });
    try {
      await f.handle.catchUp();
      expect(f.calls.map(c => Number(c.args.find(a => a.startsWith('--only=')).split('=')[1]))).toEqual(expected);
      expect(f.lines.some(l => l.includes('catch-up skipped') && l.includes('drain.redMainSkipCatchUp=on (tool)'))).toBe(logsSkip);
    } finally { f.handle.kill(); }
  });
});


describe('queue overlap catch-up scheduling', () => {
  const overlap = { considered: 1, enqueueOutcomes: [
    { num: 42, outcome: 'not-enqueued', kind: 'queue-file-overlap', reason: '#12,#13 share backlog/card.md, scripts/a.mjs' },
  ] };
  const options = {
    resolveThroughput: () => ({ value: { catchUpSkipQueueOverlap: true }, sources: { catchUpSkipQueueOverlap: 'tool' } }),
    readCandidates: async () => ({ ok: true, queued: 0, prs: [candidate(42)] }),
    drainJson: overlap,
  };
  it('skips while any blocker is queued, resumes after departure and forgets a different outcome', async () => {
    let queuedNums = [13], result = overlap;
    const f = catchUpSetup({ ...options,
      readQueueDepth: async () => ({ ok: true, queued: queuedNums.length, queuedNums }),
      drainResult: () => result,
    });
    try {
      await f.handle.catchUp();
      f.advance(600_001);
      await f.handle.catchUp();
      expect(f.calls).toHaveLength(1);
      expect(f.lines).toContain('enqueue-on-event: catch-up skipped 1 PR(s): queue-file-overlap blocker still queued (#42<-#13) (drain.catchUpSkipQueueOverlap=on (tool))');
      queuedNums = [];
      result = { considered: 1, enqueueOutcomes: [{ num: 42, outcome: 'not-enqueued', kind: 'checks', reason: 'checks pending' }] };
      f.advance(600_001);
      await f.handle.catchUp();
      expect(f.calls).toHaveLength(2);
      queuedNums = [12, 13];
      f.advance(600_001);
      await f.handle.catchUp();
      expect(f.calls).toHaveLength(3);
    } finally { f.handle.kill(); }
  });
  it('applies no skip when the queue is unreadable (no drain starts without a readable depth either)', async () => {
    const f = catchUpSetup({ ...options, readQueueDepth: async () => ({ ok: false, error: 'HTTP 502' }) });
    try {
      await f.handle.catchUp();
      f.advance(600_001);
      await f.handle.catchUp();
      expect(f.lines.some(l => l.includes('queue-file-overlap blocker still queued'))).toBe(false);
    } finally { f.handle.kill(); }
  });
  it.each([
    ['setting off', false, { ok: true, queued: 1, queuedNums: [12] }],
  ])('fails open with %s', async (_name, enabled, depth) => {
    const f = catchUpSetup({ ...options,
      resolveThroughput: () => ({ value: { catchUpSkipQueueOverlap: enabled } }),
      readQueueDepth: async () => depth,
    });
    try {
      await f.handle.catchUp();
      f.advance(600_001);
      await f.handle.catchUp();
      expect(f.calls).toHaveLength(2);
    } finally { f.handle.kill(); }
  });
  it('leaves event-driven runs eligible while a blocker remains queued', async () => {
    const f = catchUpSetup({ ...options,
      readQueueDepth: async () => ({ ok: true, queued: 1, queuedNums: [12] }),
    });
    try {
      await f.handle.catchUp();
      f.handle.notePoll({ ok: true, marked: [mark(42)] });
      f.advance(16_000);
      await f.handle.tick();
      expect(f.calls).toHaveLength(2);
    } finally { f.handle.kill(); }
  });
});

describe('stale pending event work in catch-up (live 2026-10-20, #5738 skipped as "already pending" for 80+ min)', () => {
  const run = async ({ ageMs, stalePendingMinutes, mainFix = null, capacity = 3 }) => {
    const f = catchUpSetup({ manualFinish: true,
      resolveThroughput: () => ({ value: { redMainSkipCatchUp: false } }),
      ...(mainFix ? { readMainFixPr: () => mainFix } : {}),
      readCapacity: () => ({ capacity, source: 'test' }),
      resolveSetting: () => ({ ...CATCH_UP_SETTING, catchUp: { ...CATCH_UP_SETTING.catchUp, ...(stalePendingMinutes !== undefined ? { stalePendingMinutes } : {}) } }),
      readCandidates: async () => ({ ok: true, queued: 0, prs: [candidate(43, 100), candidate(42, 200), candidate(99, 300)] }),
    });
    f.handle.notePoll({ ok: true, marked: [mark(42)] });
    f.advance(ageMs);
    const done = f.handle.catchUp();
    for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r));
    const first = f.calls.map(c => c.args.find(a => a.startsWith('--only=')));
    for (let i = 0; i < 40; i++) { f.children.forEach(c => c.finish()); await new Promise(r => setImmediate(r)); }
    await done;
    f.handle.kill();
    return { f, first, all: f.calls.map(c => c.args.find(a => a.startsWith('--only='))) };
  };
  it('plans stale event work in its normal order (no priority jump)', async () => {
    const { f, first, all } = await run({ ageMs: 11 * 60_000 });
    expect(first).toEqual(['--only=43']);
    expect(all).toEqual(['--only=43', '--only=42', '--only=99']);
    expect(f.lines.join('\n')).not.toContain('#42 already pending');
    expect(f.lines.join('\n')).toContain('catch-up plans stale pending event work #42 in normal order');
  });
  it('still skips fresh pending work, and stalePendingMinutes=0 disables the fold', async () => {
    for (const o of [{ ageMs: 60_000 }, { ageMs: 60 * 60_000, stalePendingMinutes: 0 }]) {
      const { f, all } = await run(o);
      expect(all).not.toContain('--only=42');
      expect(f.lines.join('\n')).toContain('#42 already pending');
    }
  });
  it('keeps catch-up room: stale work only takes a planned slot', async () => {
    const { all } = await run({ ageMs: 11 * 60_000, capacity: 1 });
    expect(all).toEqual(['--only=43']);
  });
});
