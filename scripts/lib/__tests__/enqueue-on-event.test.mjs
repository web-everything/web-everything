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
  fastDrainArgs, summarizeFastDrain, resolveEnqueueOnEventSetting, createEnqueueOnEvent,
} from '../enqueue-on-event.mjs';

const REPO = 'web-everything/web-everything';
const GREEN = 'check_suite.completed=success@12';
const mark = (num = 42, cause = GREEN) => ({ key: `${REPO}#${num}`, cause });

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
