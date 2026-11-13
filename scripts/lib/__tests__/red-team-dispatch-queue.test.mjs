import { describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';
import {
  createRedTeamDispatchQueue,
  defaultQueueFile,
  RED_TEAM_QUEUE_MIN_CONCURRENT_CAP,
  RED_TEAM_QUEUE_REVIEW_STARTS_CAP,
  raiseReviewStartsPerTick,
  loadRedTeamQueueFloor,
  applyRedTeamQueueFloor,
  redTeamQueueAdmitCount,
  runWithRedTeamQueue,
} from '../red-team-dispatch-queue.mjs';

const repo = 'example/project';
const otherRepo = 'example/other';
const head = pr => pr.toString(16).padStart(40, '0');
const candidates = prs => prs.map(pr => ({ pr, head: head(pr) }));
const numbers = entries => entries.map(entry => entry.pr);
const capacity = count => ({ lanes: count, remainingStarts: count, budget: { left: count } });
const prefix = 'review-daemon: red-team queue ';

// Sync IO doubles match node:fs semantics without touching the operator's queue.
// No persisted envelope is assumed: restart assertions exercise the public reader.
// maxAttempts is deliberately NOT defaulted here: omitting it exercises the production default (3).
function fixture({ maxAttempts, logger } = {}) {
  const file = join('queue-fixture', 'queue.json');
  const files = new Map();
  const operations = [];
  const logs = [];
  let clock = Date.parse('2026-11-09T12:00:00Z');
  const readFile = vi.fn(path => {
    if (!files.has(path)) throw Object.assign(new Error('missing fixture file'), { code: 'ENOENT' });
    return files.get(path);
  });
  const writeFile = vi.fn((path, data) => {
    operations.push({ type: 'write', path, data: String(data), visible: files.get(file) });
    files.set(path, String(data));
  });
  const rename = vi.fn((from, to) => {
    if (!files.has(from)) throw new Error('rename source missing');
    if (from.endsWith('.tmp')) JSON.parse(files.get(from));
    operations.push({ type: 'rename', from, to, visible: files.get(to) });
    files.set(to, files.get(from));
    files.delete(from);
  });
  const unlink = vi.fn(path => { files.delete(path); });
  const log = logger ?? ((...parts) => logs.push(parts.join(' ')));
  const open = () => createRedTeamDispatchQueue({
    file, readFile, writeFile, rename, unlink, now: () => clock, log, maxAttempts,
  });
  return {
    file, files, operations, logs, log, readFile, writeFile, rename, unlink, open,
    queue: open(), advance: () => { clock += 1000; },
  };
}

function inputs(prs, extra = {}) {
  return {
    repo,
    plan: { refusals: prs.map(prNumber => ({
      prNumber, kind: 'already-reviewed-head', headSha: head(prNumber),
    })) },
    rawPrs: prs.map(number => ({ number, headRefOid: head(number) })),
    capacity: capacity(2),
    ...extra,
  };
}

function started(options) {
  const prs = options.plan.refusals.filter(row => row.kind === 'already-reviewed-head');
  return {
    rows: prs.map(row => ({ prNumber: row.prNumber, action: 'dispatch' })),
    dispatched: prs.map(row => ({ prNumber: row.prNumber, jobPid: 1000 + row.prNumber })),
    notStarted: [],
  };
}

function refused(pr, reason) {
  return {
    rows: [{ prNumber: pr, action: 'skip', why: reason }],
    dispatched: [], notStarted: [{ prNumber: pr, reason }],
  };
}

describe('setting-driven red-team queue floor', () => {
  const floorCapacity = count => ({ ...capacity(count), startsCeiling: Infinity });
  const floor = { minConcurrent: 2, idlePct: 10, reviewStartsPerTick: 0 };
  const file = join('queue-fixture', 'settings.json');
  const settings = (minConcurrent = 2, minConcurrentIdlePct = 10) =>
    JSON.stringify({ redTeam: { queue: { minConcurrent, minConcurrentIdlePct } } });
  const load = (text, env = {}) => loadRedTeamQueueFloor({ env, file, readFile: () => text });

  it.each([
    ['missing redTeam', {}],
    ['missing queue', { redTeam: {} }],
    ['missing minimum', { redTeam: { queue: { minConcurrentIdlePct: 10 } } }],
  ])('%s disables the floor without increasing capacity', (_name, configuration) => {
    const configured = load(JSON.stringify(configuration));
    expect(configured).toEqual({ minConcurrent: 0, idlePct: 10, reviewStartsPerTick: 0 });
    const bound = floorCapacity(1);
    const log = vi.fn();
    applyRedTeamQueueFloor(bound, { floor: configured, cpuIdlePct: 100, log });
    expect(bound).toEqual(floorCapacity(1));
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ['missing file threshold', {}],
    ['empty environment threshold', { WE_RED_TEAM_QUEUE_MIN_CONCURRENT_IDLE_PCT: '' }],
    ['blank environment threshold', { WE_RED_TEAM_QUEUE_MIN_CONCURRENT_IDLE_PCT: ' ' }],
    ['nonfinite environment threshold', { WE_RED_TEAM_QUEUE_MIN_CONCURRENT_IDLE_PCT: 'Infinity' }],
  ])('%s defaults to 10 while retaining the configured minimum', (_name, env) => {
    const configured = load(JSON.stringify({ redTeam: { queue: { minConcurrent: 3 } } }), env);
    expect(configured).toEqual({ minConcurrent: 3, idlePct: 10, reviewStartsPerTick: 0 });
    const bound = floorCapacity(1);
    applyRedTeamQueueFloor(bound, { floor: configured, cpuIdlePct: 9 });
    expect(bound.remainingStarts).toBe(1);
    applyRedTeamQueueFloor(bound, { floor: configured, cpuIdlePct: 10 });
    expect(bound).toEqual({ lanes: 1, startsCeiling: Infinity, remainingStarts: 3, budget: { left: 1 } });
  });

  it.each([
    ['file', settings(99), {}, 6],
    ['environment', settings(1), { WE_RED_TEAM_QUEUE_MIN_CONCURRENT: '99' }, 6],
    ['invalid environment', settings(4), { WE_RED_TEAM_QUEUE_MIN_CONCURRENT: 'bad' }, 0],
    ['valid environment over invalid file minimum', settings('bad'), { WE_RED_TEAM_QUEUE_MIN_CONCURRENT: '3' }, 3],
  ])('%s minimum resolves with a hard cap of six and invalid overrides disable it', (_name, text, env, expected) => {
    const configured = load(text, env);
    expect(configured).toEqual({ minConcurrent: expected, idlePct: 10, reviewStartsPerTick: 0 });
    const bound = { lanes: 10, startsCeiling: Infinity, remainingStarts: 1, budget: { left: 10 } };
    applyRedTeamQueueFloor(bound, { floor: configured, cpuIdlePct: 100 });
    expect(bound.remainingStarts).toBe(Math.max(1, expected));
    expect(redTeamQueueAdmitCount(bound)).toBe(Math.max(1, expected));
  });

  it.each([
    ['zero', 0, 0],
    ['one', 1, 1],
    ['unbounded', Infinity, 2],
    ['absent', undefined, 0],
    ['null', null, 0],
    ['string', '2', 0],
    ['NaN', NaN, 0],
    ['negative', -1, 0],
    ['negative infinity', -Infinity, 0],
  ])('host ceiling %s bounds the floor at idle 100', (_name, startsCeiling, expected) => {
    const bound = { lanes: 4, remainingStarts: 0, budget: { left: 4 } };
    if (startsCeiling !== undefined) bound.startsCeiling = startsCeiling;
    const before = structuredClone(bound);
    const log = vi.fn();
    applyRedTeamQueueFloor(bound, { floor, cpuIdlePct: 100, log });
    expect(bound).toEqual({ ...before, remainingStarts: expected });
    expect(redTeamQueueAdmitCount(bound)).toBe(expected);
    expect(log).toHaveBeenCalledTimes(expected > 0 ? 1 : 0);
  });

  it('loads defaults 6/10 from the real shipped settings file with no environment overrides', () => {
    expect(loadRedTeamQueueFloor({ env: {} })).toEqual({ minConcurrent: 6, idlePct: 10, reviewStartsPerTick: 6 });
    expect(RED_TEAM_QUEUE_MIN_CONCURRENT_CAP).toBe(6);
  });

  it('environment overrides win over both file settings', () => {
    expect(load(settings(4, 80), {
      WE_RED_TEAM_QUEUE_MIN_CONCURRENT: '1',
      WE_RED_TEAM_QUEUE_MIN_CONCURRENT_IDLE_PCT: '20',
    })).toEqual({ minConcurrent: 1, idlePct: 20, reviewStartsPerTick: 0 });
  });

  it.each([['file', 99, {}], ['environment', 2, { WE_RED_TEAM_QUEUE_MIN_CONCURRENT: '99' }]])(
    '%s oversized minimum clamps to 6 and admits at most 6 with ten lanes', async (_source, minimum, env) => {
      const configured = load(settings(minimum), env);
      expect(configured).toEqual({ minConcurrent: 6, idlePct: 10, reviewStartsPerTick: 0 });
      const bound = { lanes: 10, startsCeiling: Infinity, remainingStarts: 0, budget: { left: 10 } };
      applyRedTeamQueueFloor(bound, { floor: configured, cpuIdlePct: 50, log: vi.fn() });
      expect(redTeamQueueAdmitCount(bound)).toBe(6);
      const f = fixture();
      const run = vi.fn(started);
      await runWithRedTeamQueue({ queue: f.queue, ...inputs([1, 2, 3, 4, 5, 6, 7, 8]),
        capacity: { lanes: 10, startsCeiling: Infinity, remainingStarts: 0, budget: { left: 10 } },
        floor: configured, readCpuIdlePct: () => 50, run, log: f.log });
      expect(run.mock.calls[0][0].plan.refusals.map(row => row.prNumber)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(f.logs.filter(line => line.startsWith(`${prefix}admit `))).toHaveLength(6);
      expect(f.logs.filter(line => new RegExp(`^${prefix}hold \\S+: capacity \\d+$`).test(line))).toHaveLength(2);
    },
  );

  it.each([[38, 2, 1], [10, 2, 1], [5, 1, 2]])(
    'CPU idle %s yields %s admits and %s holds for three queued PRs', async (idle, admits, holds) => {
      const bound = { lanes: 4, startsCeiling: Infinity, remainingStarts: 1, budget: { left: 4 } };
      const budget = bound.budget;
      const log = vi.fn();
      applyRedTeamQueueFloor(bound, { floor, cpuIdlePct: idle, log });
      expect(bound).toEqual({ lanes: 4, startsCeiling: Infinity, remainingStarts: admits, budget: { left: 4 } });
      expect(bound.budget).toBe(budget);
      expect(redTeamQueueAdmitCount(bound)).toBe(admits);
      expect(log).toHaveBeenCalledTimes(idle >= 10 ? 1 : 0);
      if (idle >= 10) expect(log.mock.calls[0].join(' ')).not.toMatch(/[\r\n]/);
      const f = fixture();
      const run = vi.fn(started);
      await runWithRedTeamQueue({ queue: f.queue, ...inputs([1, 2, 3]),
        capacity: { lanes: 4, startsCeiling: Infinity, remainingStarts: 1, budget: { left: 4 } },
        floor, readCpuIdlePct: () => idle, run, log: f.log });
      expect(run.mock.calls[0][0].plan.refusals.map(row => row.prNumber)).toEqual([1, 2, 3].slice(0, admits));
      expect(f.logs.filter(line => line.startsWith(`${prefix}admit `))).toHaveLength(admits);
      expect(f.logs.filter(line => new RegExp(`^${prefix}hold \\S+: capacity \\d+$`).test(line))).toHaveLength(holds);
    },
  );

  it.each([
    ['string', settings('3'), {}],
    ['negative', settings(-1), {}],
    ['fractional', settings(1.5), {}],
    ['null', settings(null), {}],
    ['NaN JSON', '{"redTeam":{"queue":{"minConcurrent":NaN}}}', {}],
    ['corrupt JSON', '{ truncated', {}],
    ...['bad', '-1', '1.5', 'NaN', 'Infinity', ''].map(value =>
      [`environment ${JSON.stringify(value)}`, settings(4), { WE_RED_TEAM_QUEUE_MIN_CONCURRENT: value }]),
  ])('invalid minimum (%s) disables the floor instead of increasing computed capacity', (_name, text, env) => {
    const configured = load(text, env);
    expect(configured.minConcurrent).toBe(0);
    const bound = { lanes: 4, startsCeiling: Infinity, remainingStarts: 1, budget: { left: 4 } };
    const before = structuredClone(bound);
    const log = vi.fn();
    applyRedTeamQueueFloor(bound, { floor: configured, cpuIdlePct: 100, log });
    expect(bound).toEqual(before);
    expect(redTeamQueueAdmitCount(bound)).toBe(1);
    expect(log).not.toHaveBeenCalled();
  });

  it.each(['ENOENT', 'EACCES'])('%s settings file with no env override disables the floor', code => {
    const configured = loadRedTeamQueueFloor({ env: {}, file, readFile: () => {
      throw Object.assign(new Error('fixture file unavailable'), { code });
    } });
    expect(configured.minConcurrent).toBe(0);
    const bound = floorCapacity(1);
    applyRedTeamQueueFloor(bound, { floor: configured, cpuIdlePct: 100, log: vi.fn() });
    expect(bound).toEqual(floorCapacity(1));
    expect(redTeamQueueAdmitCount(bound)).toBe(1);
  });

  it('zero minimum explicitly disables the floor in both file and environment', () => {
    for (const configured of [load(settings(0)), load(settings(2), { WE_RED_TEAM_QUEUE_MIN_CONCURRENT: '0' })]) {
      expect(configured).toEqual({ minConcurrent: 0, idlePct: 10, reviewStartsPerTick: 0 });
      const bound = floorCapacity(1);
      applyRedTeamQueueFloor(bound, { floor: configured, cpuIdlePct: 50, log: vi.fn() });
      expect(bound).toEqual(floorCapacity(1));
    }
  });

  it.each(['bad', -1, 101, 1.5, null])('invalid idle threshold %j disables the floor', value => {
    expect(load(settings(2, value))).toEqual({ minConcurrent: 0, idlePct: 10, reviewStartsPerTick: 0 });
    expect(load(settings(2, 0), { WE_RED_TEAM_QUEUE_MIN_CONCURRENT_IDLE_PCT: String(value) })).toEqual({ minConcurrent: 2, idlePct: 0, reviewStartsPerTick: 0 });
  });

  it.each([0, 100])('accepts idle threshold boundary %s', idlePct => {
    expect(load(settings(2, idlePct))).toEqual({ minConcurrent: 2, idlePct, reviewStartsPerTick: 0 });
    expect(load(settings(), { WE_RED_TEAM_QUEUE_MIN_CONCURRENT_IDLE_PCT: String(idlePct) }))
      .toEqual({ minConcurrent: 2, idlePct, reviewStartsPerTick: 0 });
  });

  it.each([null, undefined, NaN, Infinity, -Infinity, '38', -1])(
    'unreadable or insufficient CPU idle %j leaves capacity unchanged', cpuIdlePct => {
      const bound = floorCapacity(1);
      const log = vi.fn();
      applyRedTeamQueueFloor(bound, { floor, cpuIdlePct, log });
      expect(bound).toEqual(floorCapacity(1));
      expect(log).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, NaN, '1'])('unreadable remainingStarts %j is never raised', remainingStarts => {
    const bound = { lanes: 4, startsCeiling: Infinity, remainingStarts, budget: { left: 4 } };
    const before = structuredClone(bound);
    const log = vi.fn();
    applyRedTeamQueueFloor(bound, { floor, cpuIdlePct: 50, log });
    expect(bound).toEqual(before);
    expect(log).not.toHaveBeenCalled();
  });

  it('never lowers an existing higher value and logs only when raising', () => {
    const bound = floorCapacity(3);
    const log = vi.fn();
    applyRedTeamQueueFloor(bound, { floor, cpuIdlePct: 50, log });
    expect(bound).toEqual(floorCapacity(3));
    expect(log).not.toHaveBeenCalled();
    bound.remainingStarts = 1;
    applyRedTeamQueueFloor(bound, { floor, cpuIdlePct: 50, log });
    applyRedTeamQueueFloor(bound, { floor, cpuIdlePct: 50, log });
    expect(log).toHaveBeenCalledOnce();
  });

  it.each([[1, 4], [4, 1]])('floor preserves lanes=%s and budget.left=%s as independent bounds', async (lanes, left) => {
    const bound = { lanes, startsCeiling: Infinity, remainingStarts: 0, budget: { left } };
    const budget = bound.budget;
    applyRedTeamQueueFloor(bound, { floor, cpuIdlePct: 50, log: vi.fn() });
    expect(bound).toEqual({ lanes, startsCeiling: Infinity, remainingStarts: 2, budget: { left } });
    expect(bound.budget).toBe(budget);
    expect(redTeamQueueAdmitCount(bound)).toBe(1);
    const f = fixture();
    const run = vi.fn(started);
    await runWithRedTeamQueue({ queue: f.queue, ...inputs([1, 2, 3]),
      capacity: { lanes, startsCeiling: Infinity, remainingStarts: 0, budget: { left } },
      floor, readCpuIdlePct: () => 50, run, log: f.log });
    expect(run.mock.calls[0][0].plan.refusals.map(row => row.prNumber)).toEqual([1]);
  });

  it.each(['both', 'floor only', 'reader only', 'neither'])(
    'optional floor integration: %s preserves normalization and opt-in behavior', async mode => {
      const f = fixture();
      const run = vi.fn(started);
      const readCpuIdlePct = vi.fn(() => 38);
      const options = {};
      if (mode === 'both' || mode === 'floor only') options.floor = floor;
      if (mode === 'both' || mode === 'reader only') options.readCpuIdlePct = readCpuIdlePct;
      await runWithRedTeamQueue({ queue: f.queue, ...inputs([1, 2, 3]),
        capacity: { lanes: 4.9, startsCeiling: Infinity, remainingStarts: 1.9, budget: { left: 4.9 } },
        ...options, run, log: f.log });
      const received = run.mock.calls[0][0];
      expect(received.capacity).toEqual({ lanes: 4, startsCeiling: Infinity, remainingStarts: mode === 'both' ? 2 : 1, budget: { left: 4 } });
      expect(received.plan.refusals).toHaveLength(mode === 'both' ? 2 : 1);
    },
  );
});

describe('card-only red-team queue bypass', () => {
  it.each(['refusal', 'rawPrs'])('card-only PR with zero capacity is not held and stays in rawPrs/refusals (head from %s)', async source => {
    const f = fixture();
    const number = source === 'refusal' ? 101 : 121;
    const options = inputs([number], { capacity: capacity(0) });
    if (source === 'rawPrs') delete options.plan.refusals[0].headSha;
    else options.rawPrs[0].headRefOid = head(999); // the refusal head takes precedence
    const snapshot = structuredClone(options);
    const readNetFiles = vi.fn(() => ({ ok: true, files: ['backlog/101-card.md'] }));
    const sync = vi.spyOn(f.queue, 'sync');
    const run = vi.fn(() => ({ rows: [], dispatched: [], notStarted: [] }));

    await runWithRedTeamQueue({ queue: f.queue, ...options, readNetFiles, readSkipCardOnly: () => true, run, log: f.log });

    expect(readNetFiles.mock.calls).toEqual([[{ repo, number, headRefOid: head(number) }]]);
    expect(sync.mock.calls).toEqual([[repo, []]]);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0].plan.refusals).toEqual(snapshot.plan.refusals);
    expect(run.mock.calls[0][0].rawPrs).toEqual(snapshot.rawPrs);
    expect(options).toEqual(snapshot);
    expect(f.queue.entries()).toEqual([]);
    expect(f.logs.some(line => line.startsWith(`${prefix}hold ${repo}#${number}:`))).toBe(false);
    expect(f.logs.some(line => line.startsWith(prefix)
      && line.includes('card-only') && line.includes(`${repo}#${number}`)
      && line.includes('bypasses red-team queue'))).toBe(true);
  });

  it.each([
    ['skip policy false => card-only PR queues/held normally', () => false],
    ['policy reader throws => queues normally', () => { throw new Error('policy unavailable'); }],
  ])('%s', async (_name, reader) => {
    const f = fixture();
    const options = inputs([125, 126], { capacity: capacity(1) });
    const readNetFiles = vi.fn(() => ({ ok: true, files: ['backlog/125-card.md'] }));
    const readSkipCardOnly = vi.fn(reader);
    const sync = vi.spyOn(f.queue, 'sync');
    const run = vi.fn(started);

    await runWithRedTeamQueue({ queue: f.queue, ...options, readNetFiles, readSkipCardOnly, run, log: f.log });

    expect(readSkipCardOnly).toHaveBeenCalledOnce();
    expect(sync.mock.calls).toEqual([[repo, candidates([125, 126])]]);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0].plan.refusals).toEqual([options.plan.refusals[0]]);
    expect(run.mock.calls[0][0].rawPrs).toEqual([options.rawPrs[0]]);
    expect(numbers(f.open().entries())).toEqual([126]);
    expect(f.logs).toContain(`${prefix}hold ${repo}#126: capacity; waiting for a later tick`);
    expect(f.logs.some(line => line.includes('bypasses red-team queue'))).toBe(false);
  });

  it('policy reader not called when no card-only candidate', async () => {
    const f = fixture();
    const options = inputs([127]);
    const readNetFiles = vi.fn(() => ({ ok: true, files: ['scripts/code.mjs'] }));
    const readSkipCardOnly = vi.fn(() => { throw new Error('policy must not be read'); });
    const run = vi.fn(started);

    await runWithRedTeamQueue({ queue: f.queue, ...options, readNetFiles, readSkipCardOnly, run });

    expect(readNetFiles).toHaveBeenCalledOnce();
    expect(readSkipCardOnly).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0].plan.refusals).toEqual(options.plan.refusals);
    expect(run.mock.calls[0][0].rawPrs).toEqual(options.rawPrs);
    expect(f.open().entries()).toEqual([]);
  });

  it('card-only PR with unreadable capacity is queued and held instead of bypassed or forwarded to run', async () => {
    const f = fixture();
    const options = inputs([122], { capacity: undefined });
    const readNetFiles = vi.fn(() => ({ ok: true, files: ['backlog/122-card.md'] }));
    const sync = vi.spyOn(f.queue, 'sync');
    const run = vi.fn(started);

    await runWithRedTeamQueue({ queue: f.queue, ...options, readNetFiles, readSkipCardOnly: () => true, run, log: f.log });

    expect(readNetFiles.mock.calls).toEqual([[{ repo, number: 122, headRefOid: head(122) }]]);
    expect(sync.mock.calls).toEqual([[repo, candidates([122])]]);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0].plan.refusals).toEqual([]);
    expect(run.mock.calls[0][0].rawPrs).toEqual([]);
    expect(numbers(f.open().entries())).toEqual([122]);
    expect(f.logs).toContain(`${prefix}hold ${repo}#122: capacity; waiting for a later tick`);
    expect(f.logs.some(line => line.includes('bypasses red-team queue'))).toBe(false);
  });

  it('code PR precedes a card-only PR in refusals passed to run when the card-only PR was first in the plan', async () => {
    const f = fixture();
    const options = inputs([123, 124], { capacity: capacity(1) });
    const snapshot = structuredClone(options.plan.refusals);
    const readNetFiles = vi.fn(({ number }) => ({ ok: true,
      files: number === 123 ? ['backlog/123-card.md'] : ['scripts/code.mjs'],
    }));
    const run = vi.fn(started);

    await runWithRedTeamQueue({ queue: f.queue, ...options, readNetFiles, readSkipCardOnly: () => true, run, log: f.log });

    expect(readNetFiles.mock.calls).toEqual([123, 124].map(number => [{ repo, number, headRefOid: head(number) }]));
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0].plan.refusals).toEqual([snapshot[1], snapshot[0]]);
    expect(options.plan.refusals).toEqual(snapshot);
  });

  it('mixed card+code files queue normally', async () => {
    const f = fixture();
    const options = inputs([102, 103], { capacity: capacity(1) });
    const readNetFiles = vi.fn(() => ({ ok: true, files: ['backlog/102-card.md', 'scripts/code.mjs'] }));
    const run = vi.fn(started);

    await runWithRedTeamQueue({ queue: f.queue, ...options, readNetFiles, readSkipCardOnly: () => true, run, log: f.log });

    expect(readNetFiles.mock.calls).toEqual([102, 103].map(number => [{ repo, number, headRefOid: head(number) }]));
    expect(run.mock.calls[0][0].plan.refusals).toEqual([options.plan.refusals[0]]);
    expect(run.mock.calls[0][0].rawPrs).toEqual([options.rawPrs[0]]);
    expect(numbers(f.open().entries())).toEqual([103]);
    expect(f.logs).toContain(`${prefix}hold ${repo}#103: capacity; waiting for a later tick`);
    expect(f.logs.some(line => line.includes('bypasses red-team queue'))).toBe(false);
  });

  it.each([
    ['unreadable ({ok:false})', 104, () => ({ ok: false, files: ['backlog/104-card.md'] })],
    ['throwing reader', 106, () => { throw new Error('git unavailable'); }],
    ['empty files', 108, () => ({ ok: true, files: [] })],
    ['missing files', 110, () => ({ ok: true })],
    ['non-boolean ok', 112, () => ({ ok: 'true', files: ['backlog/112-card.md'] })],
    ['docs-only files', 114, () => ({ ok: true, files: ['docs/guide.md'] })],
  ])('%s queues normally (fail closed)', async (_label, first, reader) => {
    const f = fixture();
    const options = inputs([first, first + 1], { capacity: capacity(1) });
    const readNetFiles = vi.fn(reader);
    const run = vi.fn(started);

    await runWithRedTeamQueue({ queue: f.queue, ...options, readNetFiles, readSkipCardOnly: () => true, run, log: f.log });

    expect(readNetFiles.mock.calls).toEqual([first, first + 1].map(number => [{ repo, number, headRefOid: head(number) }]));
    expect(run.mock.calls[0][0].plan.refusals).toEqual([options.plan.refusals[0]]);
    expect(run.mock.calls[0][0].rawPrs).toEqual([options.rawPrs[0]]);
    expect(numbers(f.open().entries())).toEqual([first + 1]);
    expect(f.logs).toContain(`${prefix}hold ${repo}#${first + 1}: capacity; waiting for a later tick`);
    expect(f.logs.some(line => line.includes('bypasses red-team queue'))).toBe(false);
  });

  it('card-only does not consume the admitted slot of a code PR (capacity 1)', async () => {
    const f = fixture();
    const options = inputs([116, 117], { capacity: capacity(1) });
    const readNetFiles = vi.fn(({ number }) => ({ ok: true,
      files: number === 116 ? ['backlog/116-card.md'] : ['scripts/code.mjs'],
    }));
    const sync = vi.spyOn(f.queue, 'sync');
    const admit = vi.spyOn(f.queue, 'admit');
    const run = vi.fn(received => ({ rows: [{ prNumber: 116, action: 'clear' }],
      dispatched: received.rawPrs.filter(pr => pr.number === 117).map(pr => ({ prNumber: pr.number, jobPid: 1117 })),
      notStarted: [],
    }));

    await runWithRedTeamQueue({ queue: f.queue, ...options, readNetFiles, readSkipCardOnly: () => true, run, log: f.log });

    expect(sync.mock.calls).toEqual([[repo, candidates([117])]]);
    expect(numbers(admit.mock.results[0].value)).toEqual([117]);
    expect(run.mock.calls[0][0].plan.refusals).toEqual([options.plan.refusals[1], options.plan.refusals[0]]);
    expect(run.mock.calls[0][0].rawPrs).toEqual(options.rawPrs);
    expect(f.queue.entries()).toEqual([]);
    expect(f.logs.some(line => line.startsWith(`${prefix}hold `))).toBe(false);
  });

  it('cache: reader called once for same head across two calls, again for a new head', async () => {
    const f = fixture();
    const readNetFiles = vi.fn(() => ({ ok: true, files: ['backlog/118-card.md'] }));
    const run = vi.fn(() => ({ rows: [], dispatched: [], notStarted: [] }));
    const tick = options => runWithRedTeamQueue({ queue: f.queue, ...options, readNetFiles, readSkipCardOnly: () => true, run, log: f.log });

    await tick(inputs([118]));
    await tick(inputs([118]));
    expect(readNetFiles.mock.calls).toEqual([[{ repo, number: 118, headRefOid: head(118) }]]);

    const changed = inputs([118]);
    changed.plan.refusals[0].headSha = head(119);
    changed.rawPrs[0].headRefOid = head(119);
    await tick(changed);
    expect(readNetFiles).toHaveBeenCalledTimes(2);
    expect(readNetFiles).toHaveBeenLastCalledWith({ repo, number: 118, headRefOid: head(119) });

    await tick(inputs([118], { repo: otherRepo }));
    expect(readNetFiles).toHaveBeenCalledTimes(3);
    expect(readNetFiles).toHaveBeenLastCalledWith({ repo: otherRepo, number: 118, headRefOid: head(118) });
  });

  it('cache cap 256 evicts evidence after 257 identities and re-reads evicted heads', async () => {
    const f = fixture();
    const prs = Array.from({ length: 257 }, (_, index) => 1000 + index);
    const readNetFiles = vi.fn(() => ({ ok: true, files: ['backlog/1000-card.md'] }));
    const run = () => ({ rows: [], dispatched: [], notStarted: [] });

    await runWithRedTeamQueue({ queue: f.queue, ...inputs(prs), readNetFiles, readSkipCardOnly: () => true, run });
    expect(readNetFiles).toHaveBeenCalledTimes(257);
    await runWithRedTeamQueue({ queue: f.queue, ...inputs(prs), readNetFiles, readSkipCardOnly: () => true, run });
    expect(readNetFiles.mock.calls.length).toBeGreaterThan(257);
    expect(readNetFiles.mock.calls.length).toBeLessThanOrEqual(514);
    expect(f.queue.entries()).toEqual([]);
  });

  it('an already-queued entry that turns card-only is dropped from the queue file', async () => {
    const f = fixture();
    await f.queue.sync(repo, candidates([120]));
    await f.queue.sync(otherRepo, candidates([120]));
    expect(numbers(f.open().entries())).toEqual([120, 120]);
    const options = inputs([120], { capacity: capacity(0) });
    const readNetFiles = vi.fn(() => ({ ok: true, files: ['backlog/120-card.md'] }));
    const sync = vi.spyOn(f.queue, 'sync');
    const run = vi.fn(() => ({ rows: [], dispatched: [], notStarted: [] }));

    await runWithRedTeamQueue({ queue: f.queue, ...options, readNetFiles, readSkipCardOnly: () => true, run, log: f.log });

    expect(sync.mock.calls).toEqual([[repo, []]]);
    const persisted = JSON.parse(f.files.get(f.file));
    expect(persisted.map(entry => entry.key)).toEqual([`${otherRepo}#120`]);
    expect(f.open().entries()).toEqual(persisted);
    expect(run.mock.calls[0][0].plan.refusals).toEqual(options.plan.refusals);
    expect(run.mock.calls[0][0].rawPrs).toEqual(options.rawPrs);
    expect(f.logs.some(line => line.startsWith(`${prefix}hold ${repo}#120:`))).toBe(false);
  });
});

describe('FIFO red-team dispatch queue (R752/R785)', () => {
  it('FIFO order under a burst of N owed PRs with capacity 2 over multiple ticks', async () => {
    const f = fixture();
    const pending = [1, 2, 3, 4, 5, 6, 7];
    const batches = [];
    const run = vi.fn(options => {
      batches.push(options.plan.refusals.map(row => row.prNumber));
      return started(options);
    });
    // Later planner order changes must not displace the first-seen FIFO order.
    for (const order of [pending, [7, 6, 5, 4, 3], [7, 6, 5], [7]]) {
      await runWithRedTeamQueue({ queue: f.queue, ...inputs(order), run, log: f.log });
    }
    expect(batches).toEqual([[1, 2], [3, 4], [5, 6], [7]]);
    expect(f.queue.entries()).toEqual([]);
    for (const verb of ['enqueue', 'hold', 'admit', 'remove']) {
      expect(f.logs.some(line => line.startsWith(prefix) && line.includes(verb))).toBe(true);
    }
    expect(f.logs.some(line => line.includes('remove') && /dispatch|start/.test(line))).toBe(true);
  });

  it.each([
    [{ lanes: 2, remainingStarts: 5, budget: { left: 4 } }, 2],
    [{ lanes: 5, remainingStarts: 1, budget: { left: 4 } }, 1],
    [{ lanes: 5, remainingStarts: 4, budget: { left: 2 } }, 2],
    [{ lanes: 2.9, remainingStarts: 8, budget: { left: 9 } }, 2],
    [{ lanes: Infinity, remainingStarts: null, budget: { left: Infinity } }, Infinity],
    [{ lanes: Infinity }, Infinity],
    [{ lanes: 9, remainingStarts: null }, 9],
    [{ lanes: -1, remainingStarts: 9 }, 0],
    [{ lanes: 9, remainingStarts: 0, budget: { left: 9 } }, 0],
    [{ lanes: 9, budget: { left: 0 } }, 0],
  ])('capacity bound never admits more than min(lanes, remainingStarts, budget.left): %j', async (bound, expected) => {
    expect(redTeamQueueAdmitCount(bound)).toBe(expected);
    const f = fixture();
    const run = vi.fn(started);
    await runWithRedTeamQueue({ queue: f.queue, ...inputs([1, 2, 3, 4, 5]), capacity: bound, run });
    expect(run).toHaveBeenCalledOnce();
    // Exhausted but readable capacity passes everything through (the runner refuses before any retry is spent,
    // and worker-free settlement must not wait); unreadable capacity holds all (separate test).
    const passThrough = expected === 0;
    expect(run.mock.calls[0][0].plan.refusals).toHaveLength(passThrough ? 5 : Math.min(5, expected));
  });

  it('exhausted readable capacity still lets worker-free settlement (clear) reach the runner', async () => {
    const f = fixture();
    const run = vi.fn(() => ({ rows: [{ prNumber: 1, action: 'clear' }], dispatched: [], notStarted: [] }));
    await runWithRedTeamQueue({ queue: f.queue, ...inputs([1]), capacity: capacity(0), run, log: f.log });
    expect(run.mock.calls[0][0].plan.refusals.map(row => row.prNumber)).toEqual([1]);
    expect(numbers(f.queue.entries())).toEqual([]);
  });

  it('no retry spend while queued: run never receives held-out PRs', async () => {
    const f = fixture();
    const spentRetries = new Set();
    const run = vi.fn(options => {
      expect(options.plan.refusals.map(row => row.prNumber)).toEqual([1, 2]);
      expect(options.rawPrs.map(row => row.number)).toEqual([1, 2]);
      for (const row of options.plan.refusals) spentRetries.add(row.prNumber);
      return started(options);
    });
    await runWithRedTeamQueue({ queue: f.queue, ...inputs([1, 2, 3, 4]), run });
    expect([...spentRetries]).toEqual([1, 2]);
    expect(numbers(f.queue.entries())).toEqual([3, 4]);
    expect(f.queue.entries().map(entry => entry.attempts)).toEqual([0, 0]);
  });

  it('head change re-enqueues at tail with attempts reset', async () => {
    const f = fixture();
    await f.queue.sync(repo, candidates([1, 2, 3]));
    await f.queue.admit(repo, 1);
    await f.queue.settle(repo, refused(1, 'lane temporarily unavailable'));
    expect(f.queue.entries()[0].attempts).toBe(1);
    f.advance();
    const changedHead = 'f'.repeat(40);
    await f.queue.sync(repo, [{ pr: 1, head: changedHead }, ...candidates([2, 3])]);
    expect(numbers(f.queue.entries())).toEqual([2, 3, 1]);
    expect(f.queue.entries()[2]).toMatchObject({ key: `${repo}#1`, repo, pr: 1, head: changedHead, attempts: 0 });
    expect(f.queue.entries()[2].enqueuedAt).toBeDefined();
    expect(f.open().entries()).toEqual(f.queue.entries());
  });

  it('closed/merged PR absent from plan is removed without disturbing another repo', async () => {
    const f = fixture();
    await f.queue.sync(repo, candidates([1, 2]));
    await f.queue.sync(otherRepo, candidates([1]));
    await runWithRedTeamQueue({ queue: f.queue, ...inputs([2]), capacity: capacity(0), log: f.log,
      run: () => ({ rows: [{ prNumber: 2, action: 'skip', why: 'no review capacity left' }], dispatched: [],
        notStarted: [{ prNumber: 2, reason: 'no review capacity left' }] }) });
    expect(f.queue.entries().map(entry => entry.key)).toEqual([`${repo}#2`, `${otherRepo}#1`]);
    expect(f.logs.some(line => line.startsWith(prefix) && line.includes('remove') && /closed|merged|absent|candidate/.test(line))).toBe(true);
    await f.queue.sync(repo, []);
    expect(f.open().entries().map(entry => entry.key)).toEqual([`${otherRepo}#1`]);
  });

  it('restart persistence: a new queue instance on the same file continues order and attempts', async () => {
    const f = fixture();
    await f.queue.sync(repo, candidates([3, 1, 2]));
    await f.queue.admit(repo, 1);
    await f.queue.settle(repo, refused(3, 'lane busy'));
    const restarted = f.open();
    expect(restarted.entries()).toEqual(f.queue.entries());
    expect(numbers(await restarted.admit(repo, 1))).toEqual([3]);
    expect(restarted.entries()[0].attempts).toBe(1);
    await restarted.settle(repo, {
      rows: [{ prNumber: 3, action: 'dispatch' }], dispatched: [{ prNumber: 3, jobPid: 42 }], notStarted: [],
    });
    expect(numbers(f.open().entries())).toEqual([1, 2]);
  });

  it('planner skip rows (not in notStarted) count as attempts, rotate, and no longer starve the next PR', async () => {
    const f = fixture({ maxAttempts: 2 });
    const reason = 'stale re-dispatch already spent';
    const dispatchedPrs = [];
    const run = options => {
      const rest = options.plan.refusals.filter(row => row.prNumber !== 1);
      const res = started({ plan: { refusals: rest } });
      dispatchedPrs.push(...res.dispatched.map(d => d.prNumber));
      const skipped = options.plan.refusals.some(row => row.prNumber === 1);
      return { rows: [...(skipped ? [{ prNumber: 1, action: 'skip', why: reason }] : []), ...res.rows],
        dispatched: res.dispatched, notStarted: [] };
    };
    for (let tick = 0; tick < 2; tick++) {
      await runWithRedTeamQueue({ queue: f.queue, ...inputs([1, 2]), capacity: capacity(1), run, log: f.log });
    }
    expect(dispatchedPrs).toEqual([2]); // PR2 really dispatched on tick 2 despite capacity 1
    expect(numbers(f.queue.entries())).toEqual([1]);
    expect(f.logs.some(line => line.includes('requeue') && line.includes(reason))).toBe(true);
  });

  it('stuck head skip-and-requeue after K attempts logs reason and lets the rest dispatch', async () => {
    const f = fixture({ maxAttempts: 2 });
    const reason = 'dispatch refused before start: lane busy';
    const received = [];
    const run = options => {
      const pr = options.plan.refusals[0].prNumber;
      received.push(pr);
      return pr === 1 ? refused(1, reason) : started(options);
    };
    await runWithRedTeamQueue({ queue: f.queue, ...inputs([1, 2, 3]), capacity: capacity(1), run, log: f.log });
    expect(f.queue.entries()[0].attempts).toBe(1);
    expect(numbers(f.queue.entries())).toEqual([1, 2, 3]);
    await runWithRedTeamQueue({ queue: f.queue, ...inputs([1, 2, 3]), capacity: capacity(1), run, log: f.log });
    expect(numbers(f.queue.entries())).toEqual([2, 3, 1]);
    expect(f.queue.entries()[2].attempts).toBe(0);
    expect(f.logs.some(line => line.startsWith(prefix) && line.includes('requeue') && line.includes(reason))).toBe(true);
    await runWithRedTeamQueue({ queue: f.queue, ...inputs([1, 2, 3]), capacity: capacity(2), run: options => {
      received.push(...options.plan.refusals.map(row => row.prNumber));
      return started(options);
    } });
    expect(received).toEqual([1, 1, 2, 3]);
    expect(numbers(f.open().entries())).toEqual([1]);
  });

  it('aged FIFO: an old PR requeued behind newer arrivals is admitted before them across ticks (#6584)', () => {
    const f = fixture({ maxAttempts: 1 });
    f.queue.sync(repo, candidates([1]));
    f.advance();
    f.queue.sync(repo, candidates([1, 2, 3]));
    f.queue.admit(repo, 1);
    // Planner skip with maxAttempts 1 rotates the old PR to the tail and marks it non-runnable.
    f.queue.settle(repo, { rows: [{ prNumber: 1, action: 'skip', why: 'later verdict or hold supersedes acceptance' }], dispatched: [], notStarted: [] });
    expect(numbers(f.queue.entries())).toEqual([2, 3, 1]);
    f.queue.admit(repo, 2);
    // The block clears; both rows stay owed.
    f.queue.settle(repo, { rows: [{ prNumber: 1, action: 'dispatch' }, { prNumber: 2, action: 'dispatch' }], dispatched: [], notStarted: [] });
    expect(f.queue.entries().find(entry => entry.pr === 1).blocked).toBeUndefined();
    for (let tick = 0; tick < 3; tick++) {
      f.advance();
      f.queue.sync(repo, candidates([1, 2, 3, 10 + tick]));
      // Array position alone would admit PR 2 first; the oldest capacity-waiting PR must win every tick.
      expect(numbers(f.queue.admit(repo, 1))).toEqual([1]);
      f.queue.settle(repo, { rows: [], dispatched: [], notStarted: [{ prNumber: 1, reason: 'no review capacity left' }] });
    }
  });

  it('aged FIFO: a poison PR that always fails to start rotates behind the others (attempts rotation kept)', () => {
    const f = fixture({ maxAttempts: 2 });
    f.queue.sync(repo, candidates([1]));
    f.advance();
    f.queue.sync(repo, candidates([1, 2]));
    for (let tick = 0; tick < 2; tick++) {
      expect(numbers(f.queue.admit(repo, 1))).toEqual([1]);
      f.queue.settle(repo, refused(1, 'dispatch refused before start: lane busy'));
      f.advance();
    }
    expect(numbers(f.queue.admit(repo, 1))).toEqual([2]);
  });

  it('no-capacity notStarted does not increment attempts or move the head', async () => {
    const f = fixture();
    await f.queue.sync(repo, candidates([1, 2]));
    await f.queue.admit(repo, 1);
    await f.queue.settle(repo, refused(1, 'lane busy'));
    const before = f.queue.entries().map(entry => ({ ...entry }));
    for (let tick = 0; tick < 4; tick++) {
      await runWithRedTeamQueue({ queue: f.queue, ...inputs([1, 2]), capacity: capacity(1),
        run: () => refused(1, 'no review capacity left') });
    }
    expect(f.queue.entries()).toEqual(before);
    expect(f.open().entries()).toEqual(before);
  });

  it('corrupt file is preserved for inspection, not overwritten', () => {
    const f = fixture();
    f.files.set(f.file, '{ truncated');
    f.open();
    expect(f.files.has(f.file)).toBe(false);
    expect([...f.files.entries()].some(([name, text]) => name.includes('.corrupt-') && text === '{ truncated')).toBe(true);
    expect(f.logs.some(line => line.startsWith(prefix) && line.includes('preserved'))).toBe(true);
  });

  it.each(['corrupt', 'unreadable'])('%s file => empty queue plus log, never throw', kind => {
    const f = fixture();
    if (kind === 'corrupt') f.files.set(f.file, '{ truncated');
    else f.readFile.mockImplementation(() => { throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); });
    f.logs.length = 0;
    const restored = f.open();
    expect(restored.entries()).toEqual([]);
    expect(f.logs.some(line => line.startsWith(prefix) && /corrupt|unreadable|read|load|invalid/.test(line))).toBe(true);
  });

  it('atomic write: same-directory temp plus rename, no partial queue file visible', async () => {
    const f = fixture();
    await f.queue.sync(repo, candidates([1]));
    const oldFile = f.files.get(f.file);
    f.operations.length = 0;
    await f.queue.sync(repo, candidates([1, 2]));
    expect(f.operations.length).toBeGreaterThanOrEqual(2);
    expect(f.operations.every(op => op.type !== 'write' || op.path !== f.file)).toBe(true);
    const commits = f.operations.filter(op => op.type === 'rename');
    expect(commits.length).toBeGreaterThan(0);
    for (const commit of commits) {
      expect(commit.to).toBe(f.file);
      expect(commit.from).not.toBe(f.file);
      expect(dirname(commit.from)).toBe(dirname(f.file));
      const write = f.operations.find(op => op.type === 'write' && op.path === commit.from);
      expect(write).toBeDefined();
      expect(() => JSON.parse(write.data)).not.toThrow();
      expect(write.visible).toBe(oldFile);
      expect(commit.visible).toBe(oldFile);
    }
    expect(numbers(f.open().entries())).toEqual([1, 2]);
  });

  it.each([undefined, null, {}, { lanes: NaN }, { lanes: '2' }, { lanes: 2, remainingStarts: NaN }])(
    'missing/invalid capacity => admits 0 and logs a hold: %j', async bound => {
      const f = fixture();
      expect(redTeamQueueAdmitCount(bound)).toBe(0);
      const run = vi.fn(options => {
        expect(options.plan.refusals).toEqual([]);
        expect(options.rawPrs).toEqual([]);
        return { rows: [], dispatched: [], notStarted: [] };
      });
      await runWithRedTeamQueue({ queue: f.queue, ...inputs([1, 2]), capacity: bound, run, log: f.log });
      expect(run).toHaveBeenCalledOnce();
      expect(numbers(f.queue.entries())).toEqual([1, 2]);
      expect(f.logs.some(line => line.startsWith(prefix) && /capacity|hold/.test(line))).toBe(true);
    },
  );

  it('clear, carry and absent (not owed) rows remove only settled PRs', async () => {
    const f = fixture();
    await f.queue.sync(repo, candidates([1, 2, 3, 4]));
    await f.queue.sync(otherRepo, candidates([1]));
    await runWithRedTeamQueue({ queue: f.queue, ...inputs([1, 2, 3, 4]), capacity: capacity(3),
      run: () => ({ rows: [{ prNumber: 1, action: 'clear' }, { prNumber: 2, action: 'carry' }],
        dispatched: [], notStarted: [] }), log: f.log });
    expect(f.queue.entries().map(entry => entry.key)).toEqual([`${repo}#4`, `${otherRepo}#1`]);
    expect(f.logs.filter(line => line.includes('remove'))).toHaveLength(3);
    expect(f.logs.filter(line => line.includes('remove')).every(line => /clear|carry|owed|absent/.test(line))).toBe(true);
  });

  it('passes unrelated rows, headless rows and extra options through without mutating inputs', async () => {
    const f = fixture();
    const options = inputs([1, 2]);
    delete options.plan.refusals[0].headSha; // resolve from rawPr.headRefOid
    const headless = { prNumber: 3, kind: 'already-reviewed-head' };
    const invalidHead = { prNumber: 4, kind: 'already-reviewed-head', headSha: 'unknown' };
    const unrelated = { prNumber: 9, kind: 'other-refusal' };
    options.plan.refusals.push(headless, invalidHead, unrelated);
    options.plan.marker = 'preserve plan metadata';
    options.rawPrs.push({ number: 3 }, { number: 4, headRefOid: 'unknown' }, { number: 9 });
    const snapshot = structuredClone(options);
    const dispatch = vi.fn();
    const run = vi.fn(received => {
      expect(received.plan.refusals).toEqual([options.plan.refusals[0], headless, invalidHead, unrelated]);
      expect(received.rawPrs.map(pr => pr.number)).toEqual([1, 3, 4, 9]);
      expect(received.plan.marker).toBe(options.plan.marker);
      expect(received.capacity).toBe(bound);
      expect(received.dispatch).toBe(dispatch);
      expect(received.paused).toBe(true);
      return { rows: [], dispatched: [], notStarted: [] };
    });
    const bound = capacity(1);
    await runWithRedTeamQueue({ queue: f.queue, ...options, capacity: bound, run, dispatch, paused: true });
    expect(run).toHaveBeenCalledOnce();
    expect(options).toEqual(snapshot);
    expect(numbers(f.queue.entries())).toEqual([2]);
  });

  it('run throws: queue order, attempts and persisted state remain unchanged and error propagates', async () => {
    const f = fixture();
    await f.queue.sync(repo, candidates([1, 2]));
    await f.queue.admit(repo, 1);
    await f.queue.settle(repo, refused(1, 'lane busy'));
    const before = structuredClone(f.queue.entries());
    const persisted = f.files.get(f.file);
    const error = new Error('runner failed');
    let caught;
    try {
      await runWithRedTeamQueue({ queue: f.queue, ...inputs([1, 2]), run: () => { throw error; } });
    } catch (failure) { caught = failure; }
    expect(caught).toBe(error);
    expect(f.queue.entries()).toEqual(before);
    expect(f.files.get(f.file)).toBe(persisted);
    expect(f.open().entries()).toEqual(before);
  });

  it.each(['sync', 'async'])('runner %s failure rolls back sync mutations, admissions and persisted state', async mode => {
    const f = fixture();
    await f.queue.sync(repo, candidates([1, 2, 3]));
    await f.queue.admit(repo, 1);
    const before = structuredClone(f.queue.entries());
    const persisted = new Map(f.files);
    f.operations.length = 0;
    const error = new Error('runner failed after sync mutations');
    const options = inputs([2, 3, 4], { capacity: capacity(1) });
    options.plan.refusals[0].headSha = 'f'.repeat(40);
    const run = vi.fn(() => {
      // Sync removed PR 1, replaced PR 2's head and appended PR 4 before admission.
      expect(numbers(f.queue.entries())).toEqual([3, 2, 4]);
      expect(f.queue.entries()[1]).toMatchObject({ head: 'f'.repeat(40), attempts: 0 });
      if (mode === 'async') return Promise.reject(error);
      throw error;
    });
    let caught;
    try {
      await runWithRedTeamQueue({ queue: f.queue, ...options, run });
    } catch (failure) { caught = failure; }
    expect(caught).toBe(error);
    expect(run).toHaveBeenCalledOnce();
    expect(f.queue.entries()).toEqual(before);
    expect(f.files).toEqual(persisted);
    expect(f.operations).toEqual([]);
    expect(f.open().entries()).toEqual(before);
    // Settlement without another admit must still act on the pre-transaction admission (PR 1),
    // rather than the failed transaction's admission (PR 3).
    await f.queue.settle(repo, {
      rows: [{ prNumber: 1, action: 'clear' }, { prNumber: 3, action: 'clear' }],
      dispatched: [], notStarted: [],
    });
    expect(numbers(f.queue.entries())).toEqual([2, 3]);
    expect(numbers(f.open().entries())).toEqual([2, 3]);
  });

  it('admit is FIFO per repo, supports Infinity and does not dequeue before settlement', async () => {
    const f = fixture();
    await f.queue.sync(repo, candidates([3, 1, 2]));
    await f.queue.sync(otherRepo, candidates([7]));
    const before = structuredClone(f.queue.entries());
    expect(numbers(await f.queue.admit(repo, Infinity))).toEqual([3, 1, 2]);
    expect(numbers(await f.queue.admit(otherRepo, 2))).toEqual([7]);
    expect(await f.queue.admit(repo, 0)).toEqual([]);
    expect(f.queue.entries()).toEqual(before);
  });

  it('omitted maxAttempts rotates on exactly the third failed attempt', async () => {
    const f = fixture();
    const run = options => options.plan.refusals[0].prNumber === 1 ? refused(1, 'lane busy') : started(options);
    const tick = () => runWithRedTeamQueue({ queue: f.queue, ...inputs([1, 2]), capacity: capacity(1), run, log: f.log });
    await tick();
    expect(numbers(f.queue.entries())).toEqual([1, 2]);
    expect(f.queue.entries()[0].attempts).toBe(1);
    await tick();
    expect(numbers(f.queue.entries())).toEqual([1, 2]);
    expect(f.queue.entries()[0].attempts).toBe(2);
    await tick();
    expect(numbers(f.queue.entries())).toEqual([2, 1]);
    expect(f.queue.entries()[1].attempts).toBe(0);
  });

  it('throwing diagnostics do not interrupt queue recovery or settlement', async () => {
    const f = fixture({ logger: () => { throw new Error('logger down'); } });
    f.files.set(f.file, '{ truncated');
    const recovered = f.open();
    expect(recovered.entries()).toEqual([]);
    const run = vi.fn(started);
    const result = await runWithRedTeamQueue({ queue: recovered, ...inputs([1, 2]), capacity: capacity(1), run,
      log: () => { throw new Error('logger down'); } });
    expect(result.dispatched.map(row => row.prNumber)).toEqual([1]);
    expect(numbers(recovered.entries())).toEqual([2]);
    expect(numbers(f.open().entries())).toEqual([2]);
  });

  describe.each([['writeFile'], ['rename']])('persist failure (%s) after a successful run', failing => {
    it.each(['sync', 'async'])('%s runner: result is still returned, failure is only logged', async mode => {
      const f = fixture();
      const outcome = { dispatched: [{ prNumber: 1, jobPid: 1001 }], rows: [{ prNumber: 1, action: 'dispatch' }], notStarted: [] };
      const run = vi.fn(() => {
        // Break persistence only after the runner has started its job (its side effect is done).
        f[failing].mockImplementation(() => { throw Object.assign(new Error('ENOSPC fixture'), { code: 'ENOSPC' }); });
        return mode === 'async' ? Promise.resolve(outcome) : outcome;
      });
      const result = await runWithRedTeamQueue({ queue: f.queue, ...inputs([1, 2]), capacity: capacity(1), run, log: f.log });
      expect(result).toBe(outcome);
      // Memory keeps the settled state so the started PR is not re-offered next tick.
      expect(numbers(f.queue.entries())).toEqual([2]);
      expect(f.logs.some(line => line.startsWith(prefix) && line.includes('persist failed') && line.includes('ENOSPC fixture'))).toBe(true);
      // No orphaned temp file is left behind by the failed write.
      expect([...f.files.keys()].filter(name => name.endsWith('.tmp'))).toEqual([]);
    });

    it('the next tick rewrites the stale file even with no new change, so a restart cannot re-offer a started PR', async () => {
      const f = fixture();
      let broken = true;
      f[failing].mockImplementation((...args) => {
        if (broken) throw new Error('ENOSPC fixture');
        return failing === 'rename' ? undefined : f.files.set(args[0], String(args[1]));
      });
      const outcome = { dispatched: [{ prNumber: 1, jobPid: 1001 }], rows: [{ prNumber: 1, action: 'dispatch' }], notStarted: [] };
      await runWithRedTeamQueue({ queue: f.queue, ...inputs([1, 2]), capacity: capacity(1), run: () => outcome, log: f.log });
      expect(f.files.has(f.file)).toBe(false);
      broken = false;
      if (failing === 'rename') f[failing].mockImplementation((from, to) => { f.files.set(to, f.files.get(from)); f.files.delete(from); });
      // Same candidates minus the started PR: sync/admit/settle change nothing.
      await runWithRedTeamQueue({ queue: f.queue, ...inputs([2]), capacity: capacity(0), run: () => refused(2, 'no review capacity left'), log: f.log });
      expect(numbers(f.open().entries())).toEqual([2]);
    });
  });

  it('defaultQueueFile uses the environment override or the supplied home, never the real home', () => {
    const home = join('fixture-home', 'operator');
    expect(defaultQueueFile({}, home)).toBe(join(home, 'workspace', '.operations', 'red-team-dispatch-queue.json'));
    const override = join('fixture-state', 'custom-queue.json');
    expect(defaultQueueFile({ WE_RED_TEAM_QUEUE_FILE: override }, home)).toBe(override);
  });
  describe('non-runnable head does not consume an admission', () => {
    const block = async (f, pr) => {
      f.queue.admit(repo, pr);
      await f.queue.settle(repo, refused(pr, 'review-unfinished'));
    };
    it('a review-unfinished head is probed each tick but the next runnable PR is admitted in the same tick', async () => {
      const f = fixture();
      await f.queue.sync(repo, candidates([1, 2, 3]));
      await block(f, 1);
      expect(numbers(f.queue.admit(repo, 1))).toEqual([1, 2]);
      expect(f.logs.some(line => line.includes('probe example/project#1'))).toBe(true);
      expect(f.logs.some(line => line.includes('admit example/project#2: capacity 1'))).toBe(true);
      expect(f.logs.some(line => line.includes('hold example/project#3: capacity 1'))).toBe(true);
    });
    it('a planner-skipped head (superseded acceptance) frees its slot for the next runnable PR', async () => {
      const f = fixture();
      await f.queue.sync(repo, candidates([1, 2, 3]));
      f.queue.admit(repo, 1);
      await f.queue.settle(repo, { rows: [{ prNumber: 1, action: 'skip', why: 'later verdict or hold supersedes acceptance' }], dispatched: [], notStarted: [] });
      expect(numbers(f.queue.admit(repo, 1))).toEqual([1, 2]);
    });
    it('keeps FIFO order and the capacity bound among runnable PRs', async () => {
      const f = fixture();
      await f.queue.sync(repo, candidates([1, 2, 3, 4, 5]));
      await block(f, 1);
      expect(numbers(f.queue.admit(repo, 2))).toEqual([1, 2, 3]);
      expect(numbers(f.queue.admit(repo, 0))).toEqual([1]); // a probe uses no slot, so it still runs at zero admission
    });
    it('bounds probes per tick and rotates a head that stays blocked to the tail after maxAttempts', async () => {
      const f = fixture();
      await f.queue.sync(repo, candidates([1, 2, 3, 4]));
      for (const pr of [1, 2, 3]) {
        f.queue.admit(repo, 3);
        await f.queue.settle(repo, { rows: [1, 2, 3].map(n => ({ prNumber: n, action: 'skip', why: 'review-unfinished' })),
          dispatched: [], notStarted: [1, 2, 3].map(n => ({ prNumber: n, reason: 'review-unfinished' })) });
        break;
      }
      expect(numbers(f.queue.admit(repo, 1))).toEqual([1, 2, 4]); // 2 probes max, 1 runnable slot; #3 held
      for (let tick = 0; tick < 3; tick++) {
        const ids = numbers(f.queue.admit(repo, 1));
        const why = n => (n === 4 ? 'no review capacity left' : 'review-unfinished');
        await f.queue.settle(repo, { rows: ids.map(n => ({ prNumber: n, action: 'skip', why: why(n) })),
          dispatched: [], notStarted: ids.map(n => ({ prNumber: n, reason: why(n) })) });
      }
      expect(numbers(f.queue.entries()).slice(-2)).toEqual([1, 2]); // rotated behind #3/#4
      expect(numbers(f.queue.entries())).toContain(3);
    });
    it('a dispatched blocked head leaves the queue', async () => {
      const f = fixture();
      await f.queue.sync(repo, candidates([1, 2]));
      await block(f, 1);
      f.queue.admit(repo, 1);
      await f.queue.settle(repo, started({ plan: { refusals: [{ prNumber: 1, kind: 'already-reviewed-head' }] } }));
      expect(numbers(f.queue.entries())).not.toContain(1);
    });
    it('an ordinary refusal after a block clears the exemption', async () => {
      const f = fixture();
      await f.queue.sync(repo, candidates([1, 2, 3]));
      await block(f, 1);
      f.queue.admit(repo, 1);
      await f.queue.settle(repo, refused(1, 'lane busy'));
      expect(f.queue.entries()[0].blocked).toBeUndefined();
      expect(numbers(f.queue.admit(repo, 1))).toEqual([1]);
    });
    it('an unrecognized persisted blocked value is corrupt and loads empty', async () => {
      const f = fixture();
      f.files.set(f.file, JSON.stringify(candidates([1, 2, 3]).map(c => ({ key: `${repo}#${c.pr}`, repo, pr: c.pr, head: c.head,
        enqueuedAt: 1, attempts: 0, blocked: 'unrecognized-reason' }))));
      expect(f.open().entries()).toEqual([]);
    });
    const planned = async (f, capacityValue) => {
      let seen, cap;
      runWithRedTeamQueue({ ...inputs([1, 2, 3], { capacity: capacityValue }), queue: f.queue,
        run: options => { seen = options.plan.refusals.map(row => row.prNumber); cap = options.capacity; return { rows: [], dispatched: [], notStarted: [] }; } });
      return { seen, cap };
    };
    it('normalizes capacity at intake: 0.5 gives 0 (runner sees 0), 1.7 gives 1', async () => {
      const f = fixture();
      await f.queue.sync(repo, candidates([1, 2, 3]));
      expect((await planned(f, { lanes: 0.5, remainingStarts: 0.5, budget: { left: 0.5 } })).cap).toEqual({ lanes: 0, remainingStarts: 0, budget: { left: 0 } });
      const g = fixture();
      await g.queue.sync(repo, candidates([1, 2, 3]));
      const { seen, cap } = await planned(g, { lanes: 1.7, remainingStarts: 1.7, budget: { left: 1.7 } });
      expect(seen).toEqual([1]);
      expect(cap).toEqual({ lanes: 1, remainingStarts: 1, budget: { left: 1 } });
    });
    it('floors the shared budget in place and never lets a negative figure through', async () => {
      const f = fixture();
      const budget = { left: 0.5 };
      await planned(f, { lanes: 1, remainingStarts: 1, budget });
      expect(budget.left).toBe(0);
      expect((await planned(f, { lanes: -0.5, remainingStarts: 1 })).cap.lanes).toBe(0);
    });
    it('at capacity 0 blocked heads are still probed and rotated, counters stay >= 0', async () => {
      const f = fixture();
      await f.queue.sync(repo, candidates([1, 2]));
      await block(f, 1);
      for (let tick = 0; tick < 3; tick++) {
        let cap;
        runWithRedTeamQueue({ ...inputs([1, 2], { capacity: { lanes: 0.5, remainingStarts: 0.5 } }), queue: f.queue,
          run: options => { cap = options.capacity; const r = refused(1, 'review-unfinished');
            return { rows: [...r.rows, { prNumber: 2, action: 'skip', why: 'no review capacity left' }], dispatched: [],
              notStarted: [...r.notStarted, { prNumber: 2, reason: 'no review capacity left' }] }; } });
        expect(cap.lanes).toBeGreaterThanOrEqual(0);
      }
      expect(numbers(f.queue.entries())).toEqual([2, 1]); // rotated to the tail after maxAttempts
    });
    it('an invalid admission count admits nothing, probes included (fail closed)', async () => {
      const f = fixture();
      await f.queue.sync(repo, candidates([1, 2]));
      await block(f, 1);
      for (const bad of [undefined, NaN, '1']) expect(f.queue.admit(repo, bad)).toEqual([]);
    });
    it('floors the caller capacity object in place so runner decrements reach it', async () => {
      const f = fixture();
      await f.queue.sync(repo, candidates([1]));
      const cap = { lanes: 1.7, remainingStarts: 2.2 };
      runWithRedTeamQueue({ ...inputs([1], { capacity: cap }), queue: f.queue,
        run: options => { expect(options.capacity).toBe(cap); options.capacity.lanes--; return { rows: [], dispatched: [], notStarted: [] }; } });
      expect(cap).toEqual({ lanes: 0, remainingStarts: 2 });
    });
    it('survives a restart', async () => {
      const f = fixture();
      await f.queue.sync(repo, candidates([1, 2]));
      await block(f, 1);
      expect(numbers(f.open().admit(repo, 1))).toEqual([1, 2]);
    });
  });
});

describe('red-team queue floor idle override', () => {
  it('an invalid idle override keeps a valid stricter file threshold instead of loosening to 10', () => {
    const text = JSON.stringify({ redTeam: { queue: { minConcurrent: 2, minConcurrentIdlePct: 80 } } });
    for (const bad of ['bad', '', ' ', 'Infinity', '-1', '101', '1.5']) {
      expect(loadRedTeamQueueFloor({ env: { WE_RED_TEAM_QUEUE_MIN_CONCURRENT_IDLE_PCT: bad }, file: 'x', readFile: () => text }))
        .toEqual({ minConcurrent: 2, idlePct: 80, reviewStartsPerTick: 0 });
    }
  });
});


describe('idle-only review start allowance', () => {
  const floor = { minConcurrent: 2, idlePct: 10, reviewStartsPerTick: 3 };
  it.each([[10, 3], [100, 3], [9, 2], [NaN, 2], [undefined, 2], ['10', 2]])(
    'idle %s yields allowance %s', (cpuIdlePct, expected) => {
      expect(raiseReviewStartsPerTick(2, { floor, cpuIdlePct })).toBe(expected);
    });
  it.each([Infinity, -Infinity, NaN, 0, -1, undefined, '2', 4])('preserves existing allowance %s', max => {
    expect(raiseReviewStartsPerTick(max, { floor, cpuIdlePct: 100 })).toBe(max);
  });
  it('disabled floor never raises the allowance', () => {
    expect(raiseReviewStartsPerTick(2, { floor: { ...floor, minConcurrent: 0 }, cpuIdlePct: 100 })).toBe(2);
  });
  it.each([undefined, null, '3', -1, 1.5, 99, 3])('loads file review starts %j with fail-closed integer bounds', value => {
    const readFile = () => JSON.stringify({ redTeam: { queue: { reviewStartsPerTickWhileIdle: value } } });
    const expected = Number.isInteger(value) && value >= 0 ? Math.min(value, 6) : 0;
    expect(loadRedTeamQueueFloor({ env: {}, readFile }).reviewStartsPerTick).toBe(expected);
    expect(RED_TEAM_QUEUE_REVIEW_STARTS_CAP).toBe(6);
  });
  it.each([['3', 3], ['99', 6], ['', 0], [' ', 0], ['bad', 0], ['Infinity', 0], ['1.5', 0], ['-1', 0]])(
    'environment review starts %j overrides file with %s', (value, expected) => {
      const log = vi.fn();
      const readFile = () => JSON.stringify({ redTeam: { queue: { reviewStartsPerTickWhileIdle: 4 } } });
      expect(loadRedTeamQueueFloor({ env: { WE_RED_TEAM_QUEUE_REVIEW_STARTS_WHILE_IDLE: value }, readFile, log }).reviewStartsPerTick).toBe(expected);
      expect(log.mock.calls.flat().join(' ')).toContain('env WE_RED_TEAM_QUEUE_REVIEW_STARTS_WHILE_IDLE');
    });
});

describe('raiseReviewStartsPerTick guards', () => {
  const f = { minConcurrent: 2, idlePct: 10, reviewStartsPerTick: 3 };
  it('raises 2 to 3 only while idle, never from 1, never on impossible readings', () => {
    expect(raiseReviewStartsPerTick(2, { floor: f, cpuIdlePct: 50 })).toBe(3);
    expect(raiseReviewStartsPerTick(2, { floor: f, cpuIdlePct: 5 })).toBe(2);
    expect(raiseReviewStartsPerTick(1, { floor: f, cpuIdlePct: 50 })).toBe(1);
    expect(raiseReviewStartsPerTick(2, { floor: f, cpuIdlePct: 101 })).toBe(2);
    expect(raiseReviewStartsPerTick(0, { floor: f, cpuIdlePct: 50 })).toBe(0);
    expect(raiseReviewStartsPerTick(Infinity, { floor: f, cpuIdlePct: 50 })).toBe(Infinity);
  });
});

describe('R878 red-team queue admits up to 4 only within the host ceiling', () => {
  const floor4 = { minConcurrent: 6, idlePct: 10, reviewStartsPerTick: 6 };
  it('idle host with ceiling 4 raises remainingStarts to 4', () => {
    const capacity = { lanes: 9, remainingStarts: 2, startsCeiling: 4 };
    applyRedTeamQueueFloor(capacity, { floor: floor4, cpuIdlePct: 50 });
    expect(capacity.remainingStarts).toBe(4);
  });
  it('host ceiling of 2 (R853 not admitting more) holds the queue at 2', () => {
    const capacity = { lanes: 9, remainingStarts: 2, startsCeiling: 2 };
    applyRedTeamQueueFloor(capacity, { floor: floor4, cpuIdlePct: 50 });
    expect(capacity.remainingStarts).toBe(2);
  });
  it('busy CPU never raises above the existing allowance', () => {
    const capacity = { lanes: 9, remainingStarts: 2, startsCeiling: 4 };
    applyRedTeamQueueFloor(capacity, { floor: floor4, cpuIdlePct: 5 });
    expect(capacity.remainingStarts).toBe(2);
  });
});
