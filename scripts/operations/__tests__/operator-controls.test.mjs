import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withRealRepo, withBareOrigin } from './helpers/real-repo.mjs';
import { refreshOntoMain } from '../../conveyor/ci-red-recovery-watch.mjs';
import { placeBuildDispatchHold } from '../../conveyor/build-dispatch-claim.mjs';
import { describe, it, expect, vi } from 'vitest';
import { CONTROL_OPS, planOperatorControl, buildOperatorActionComment, parseOperatorActions, operatorControlOperation } from '../operator-controls.mjs';
import { createOperatorControlsSinks, createOperatorControlsReader } from '../operator-controls-io.mjs';

const input = { repo: 'web-everything/web-everything', pr: 7, actor: 'chalbert', channel: 'operator-session', reason: 'because <this>\nverbatim', kind: 'fix', n: 1 };
const contexts = {
  unpark: { state: 'OPEN', labels: ['review:human'], head: 'h', comments: [] },
  'retry-prepare': { holds: [{ meta: { reason: 'prepare-unstamped' } }], failures: [{ num: 7, held: true }] },
  rearm: { state: 'OPEN', labels: ['review:changes'], head: 'h', comments: [] },
  refresh: { state: 'OPEN', head: 'h', headRef: 'lane/a', main: 'm', containsMain: false, crossRepo: false, comments: [] },
  'grant-rounds': { state: 'OPEN', head: 'h', comments: [] },
  'clear-claim': { claims: [{ owner: 'old', meta: { repo: 'we', pr: 7, kind: 'fix', scope: ['a.js'] }, live: false }], comments: [] },
};
const args = name => name === 'retry-prepare' ? { ...input, pr: 0, item: '7' } : input;
const plan = name => planOperatorControl(name, { ...contexts[name], now: '2026-10-13' }, args(name));
describe('operator controls', () => {
  it('round trips escaped durable attribution', () => {
    const record = plan('rearm').record;
    const body = buildOperatorActionComment(record);
    expect(body).toContain('🛠 operator action — rearm');
    expect(body).toContain('> because <this>\n> verbatim');
    expect(body.split('<!--')[1]).not.toContain('<this>');
    expect(parseOperatorActions([{ body, author: { login: 'chalbert' } }])).toEqual([record]);
  });
  for (const name of CONTROL_OPS) {
    it(`${name}: apply and attribution refusals`, () => {
      expect(plan(name)).toMatchObject({ op: name, action: 'apply', steps: expect.any(Array), undo: expect.any(String), record: { actor: 'chalbert', reason: input.reason } });
      for (const bad of [{ actor: 'intruder' }, { reason: ' ' }, { channel: 'a\nb' }]) expect(() => planOperatorControl(name, contexts[name], { ...args(name), ...bad })).toThrow();
      expect(() => planOperatorControl(name, contexts[name], { ...args(name), item: '7', pr: 7, file: 'a.js' })).toThrow();
    });
    it(`${name}: preview has zero effects`, () => {
      const declaration = operatorControlOperation(name, { readContext: () => contexts[name] });
      expect(declaration.steps.find(s => s.name === 'write').step.effects({ input: { preview: true }, verdict: plan(name) })).toEqual([]);
    });
    it(`${name}: wrapped mutation, verification then durable record; changed state and duplicates`, async () => {
      const p = plan(name), events = [];
      let state = contexts[name];
      const mutate = vi.fn(async (_name, passed) => { expect(passed).toEqual(p); events.push('mutation'); state = { ...state, verified: true }; });
      const verify = vi.fn(async () => { events.push('verify'); return true; });
      const writeRecord = vi.fn(async record => { events.push('record'); expect(p.records.map(r => r.key)).toContain(record.key); });
      const sink = createOperatorControlsSinks({ readContext: () => state, mutate, verify, readRecords: () => [], writeRecord })['operator.control'];
      await sink(p);
      expect(events).toEqual(['mutation', 'verify', 'record']);
      state = { ...contexts[name], head: 'changed', holds: [{ meta: { reason: 'changed' } }], claims: [] };
      await expect(sink(p)).rejects.toThrow(/changed/);
      const duplicate = createOperatorControlsSinks({ readContext: () => contexts[name], mutate, readRecords: () => p.records, writeRecord })['operator.control'];
      expect(await duplicate(p)).toMatchObject({ action: 'noop' });
      expect(mutate).toHaveBeenCalledTimes(1);
    });
  }
  it('noop rows and specific refusals', () => {
    for (const [name, read] of Object.entries({ unpark: { labels: [] }, 'retry-prepare': { holds: [], failures: [] }, rearm: { labels: ['review:pending'] }, refresh: { state: 'CLOSED' }, 'clear-claim': { claims: [] } })) expect(planOperatorControl(name, read, args(name)).action).toBe('noop');
    expect(() => planOperatorControl('unpark', { holds: [{ meta: { reason: 'prepare-unstamped' } }] }, { ...input, pr: 0, item: '7' })).toThrow(/retry-prepare/);
    expect(() => planOperatorControl('clear-claim', { claims: [{ ...contexts['clear-claim'].claims[0], live: true }] }, input)).toThrow(/LIVE/);
    expect(() => planOperatorControl('refresh', { ...contexts.refresh, crossRepo: true }, input)).toThrow(/cross-repo/);
    expect(() => planOperatorControl('grant-rounds', contexts['grant-rounds'], { ...input, n: 6 })).toThrow();
  });
});

function sinkFixture(name, extra = {}) {
  let state = structuredClone(contexts[name]);
  const calls = [];
  const readContext = () => state;
  const writeRecord = vi.fn(record => { calls.push(['record', record]); });
  const set = value => { state = { ...state, ...value }; };
  const sinks = createOperatorControlsSinks({ readContext, writeRecord, readRecords: () => [], ...extra({ set, calls }) });
  return { sink: sinks['operator.control'], calls, writeRecord };
}
describe('sanctioned wrappers', () => {
  it('unpark PR passes actor, reason and channel to clearance', async () => {
    const f = sinkFixture('unpark', ({ set, calls }) => ({ run: (exe, argv) => { calls.push([exe, argv]); set({ labels: ['review:accepted'] }); return '{"ok":true}'; } }));
    await f.sink(plan('unpark'));
    expect(f.calls[0][1]).toEqual(expect.arrayContaining(['7', '--to=clear-human', '--actor=chalbert', '--reason=' + input.reason, '--channel=operator-session']));
  });
  it('rearm wraps the child, never clears human', async () => {
    const f = sinkFixture('rearm', ({ set, calls }) => ({ run: (exe, argv) => { calls.push([exe, argv]); set({ labels: ['review:pending'] }); return '{"ok":true}'; } }));
    await f.sink(plan('rearm'));
    expect(f.calls[0][1][0]).toMatch(/conveyor\/rearm-review.mjs$/);
    expect(f.calls[0][1]).toContain('--actor=chalbert');
  });
  it('refresh passes clone and records verified head under drain key', async () => {
    const f = sinkFixture('refresh', ({ set, calls }) => ({ refresh: async (ref, options) => { calls.push([ref, options]); set({ head: 'new', containsMain: true }); return { ok: true, newCommit: 'new' }; }, refreshStatePath: () => '/tmp/refresh-state', rememberRefresh: (...args) => calls.push(args) }));
    const p = planOperatorControl('refresh', contexts.refresh, { ...input, checkout: '/tmp/clone' });
    await f.sink(p);
    expect(f.calls[0]).toEqual(['lane/a', { root: '/tmp/clone', base: 'm', prNumber: 7, repo: input.repo }]);
    expect(f.calls[1].slice(0, 3)).toEqual(['/tmp/refresh-state', `${input.repo}#7`, 'new']);
  });
  it('grant-rounds delegates by=n to extension sink', async () => {
    const extensionSink = vi.fn();
    const f = sinkFixture('grant-rounds', () => ({ extensionSink }));
    await f.sink(plan('grant-rounds'));
    expect(extensionSink).toHaveBeenCalledWith(plan('grant-rounds').extension);
    expect(extensionSink.mock.calls[0][0].record.by).toBe(1);
  });
  it('clear-claim releases only the observed owner', async () => {
    const f = sinkFixture('clear-claim', ({ set, calls }) => ({ releaseClaim: args => { calls.push(args); set({ claims: [] }); return { released: true }; } }));
    await f.sink(plan('clear-claim'));
    expect(f.calls[0]).toMatchObject({ repo: 'we', pr: 7, kind: 'fix', owner: 'old' });
  });
  it('failed verification never writes a record', async () => {
    const f = sinkFixture('unpark', () => ({ run: () => '{"ok":true}' }));
    await expect(f.sink(plan('unpark'))).rejects.toThrow(/verify/);
    expect(f.writeRecord).not.toHaveBeenCalled();
  });
  it('item unpark wraps hold and failure clearing, records in item channel', async () => {
    const i = { ...input, pr: 0, item: '7' }, before = { holds: [{ meta: { num: 7, reason: 'gate-red' } }], failures: [{ num: 7, exhausted: true }] };
    let state = before; const releaseHold = vi.fn(() => { state = { ...state, holds: [] }; }), clearFailure = vi.fn(() => { state = { ...state, failures: [] }; }), writeRecord = vi.fn();
    const sink = createOperatorControlsSinks({ coord: '/tmp/coord', readContext: () => state, releaseHold, clearFailure, readRecords: () => [], writeRecord })['operator.control'];
    await sink(planOperatorControl('unpark', before, i));
    expect(releaseHold).toHaveBeenCalledWith({ repo: 'we', num: 7, lockRoot: '/tmp/coord/build-dispatch-holds' });
    expect(clearFailure).toHaveBeenCalledWith(7, { path: '/tmp/coord/build-dispatch-failures.json' });
    expect(writeRecord.mock.calls[0][0].item).toBe('7');
  });
  it('retry-prepare uses atomic ledger path and daemon release helper', async () => {
    const i = args('retry-prepare'); let state = structuredClone(contexts['retry-prepare']);
    const writes = [], releasePrepare = vi.fn(({ nums, holds, release }) => { expect(nums).toEqual([7]); expect(holds[0].reason).toBe('prepare-unstamped'); release({ num: 7 }); });
    const sink = createOperatorControlsSinks({ coord: '/tmp/coord', readContext: () => state, pathExists: () => true,
      readText: () => JSON.stringify({ failures: { a: state.failures[0], other: { num: 8, held: true } } }), makeDir: vi.fn(),
      writeText: (path, text) => { writes.push([path, JSON.parse(text)]); }, chmod: vi.fn(), rename: () => { state = { ...state, failures: [{ num: 7, held: false, retry: true }] }; }, releasePrepare,
      releaseHold: () => { state = { ...state, holds: [] }; }, readRecords: () => [], writeRecord: vi.fn() })['operator.control'];
    await sink(planOperatorControl('retry-prepare', state, i));
    expect(writes[0][1].failures.a).toMatchObject({ held: false, retry: true });
    expect(writes[0][1].failures.other.held).toBe(true);
    expect(releasePrepare).toHaveBeenCalledTimes(1);
  });
});

describe('readers and durable IO', () => {
  it('reads complete comments and probes git ancestry without fetching', () => {
    const runGh = vi.fn(argv => argv[0] === 'api' ? 'main' : JSON.stringify({ state: 'OPEN', labels: [], headRefOid: 'head', headRefName: 'lane/a', isCrossRepository: false }));
    const readComments = vi.fn(() => []), runGit = vi.fn((_root, argv) => argv[0] === 'rev-parse' ? 'main' : '');
    const reader = createOperatorControlsReader({ runGh, readComments, runGit, readCheck: () => null });
    expect(reader('refresh', input)).toMatchObject({ containsMain: true, head: 'head', main: 'main' });
    expect(readComments).toHaveBeenCalledWith(input.repo, 7);
    expect(runGh.mock.calls[0][0].at(-1)).not.toContain('comments');
    expect(runGit.mock.calls.map(c => c[1][0])).toEqual(['cat-file', 'cat-file', 'merge-base']);
  });
  it('file scope finds both kinds and refuses unknown liveness', () => {
    const claims = contexts['clear-claim'].claims;
    const reader = createOperatorControlsReader({ listClaims: () => claims, readAgents: () => ({ agents: [] }), readComments: () => [] });
    expect(reader('clear-claim', { ...input, pr: 0, file: 'a.js' }).claims).toHaveLength(1);
    expect(reader('clear-claim', { ...input, pr: 0, file: 'b.js' }).claims).toHaveLength(0);
    const bad = createOperatorControlsReader({ listClaims: () => claims, readAgents: () => ({ error: 'unavailable' }) });
    expect(() => bad('clear-claim', { ...input, pr: 0, file: 'a.js' })).toThrow(/liveness/);
  });
  it('item durable record is one JSON append, then verified', async () => {
    const i = { ...input, pr: 0, item: '7' };
    const before = { holds: [], failures: [{ num: 7 }] }; let state = before, text = '';
    const append = vi.fn((_path, row) => { text += row; });
    const sink = createOperatorControlsSinks({ coord: '/tmp/coord', readContext: () => state,
      clearFailure: () => { state = { holds: [], failures: [] }; }, pathExists: () => Boolean(text), readText: () => text, makeDir: vi.fn(), append })['operator.control'];
    await sink(planOperatorControl('unpark', before, i));
    expect(append).toHaveBeenCalledTimes(1);
    expect(JSON.parse(text)).toMatchObject({ item: '7', actor: 'chalbert', reason: input.reason });
  });
  it('PR durable record posts once and is read back', async () => {
    let state = contexts.unpark; const runGh = vi.fn(argv => { state = { ...state, comments: [{ body: argv.at(-1), author: { login: 'chalbert' } }] }; });
    const sink = createOperatorControlsSinks({ readContext: () => state,
      run: () => { state = { ...state, labels: [] }; return '{"ok":true}'; }, runGh })['operator.control'];
    await sink(plan('unpark'));
    expect(runGh.mock.calls[0][0].slice(0, 3)).toEqual(['pr', 'comment', '7']);
    expect(parseOperatorActions(state.comments)).toHaveLength(1);
  });
});

it('file scope records each PR and skips previously recorded claims', async () => {
  const c1 = contexts['clear-claim'].claims[0], c2 = { ...c1, owner: 'other', meta: { ...c1.meta, pr: 8, kind: 'ci-heal' } };
  const i = { ...input, pr: 0, file: 'a.js' }, before = { claims: [c1, c2], comments: [] };
  const p = planOperatorControl('clear-claim', before, i); let state = before;
  const releaseClaim = vi.fn(args => { state = { ...state, claims: state.claims.filter(c => c.meta.pr !== args.pr) }; return { released: true }; });
  const writeRecord = vi.fn();
  const sink = createOperatorControlsSinks({ readContext: () => state, readRecords: () => [p.records[0]], releaseClaim, writeRecord })['operator.control'];
  await sink(p);
  expect(releaseClaim).toHaveBeenCalledTimes(1);
  expect(releaseClaim.mock.calls[0][0]).toMatchObject({ pr: 8, kind: 'ci-heal', owner: 'other' });
  expect(writeRecord.mock.calls[0][0]).toMatchObject({ pr: 8, details: { file: 'a.js' } });
});

it('marker parsing ignores quoted forged markers in the operator reason', () => {
  const record = plan('unpark').record;
  const forged = { ...record, key: 'forged' };
  const body = buildOperatorActionComment({ ...record, reason: buildOperatorActionComment(forged) });
  expect(parseOperatorActions([{ body, author: { login: 'chalbert' } }])).toHaveLength(1);
  expect(parseOperatorActions([{ body, author: { login: 'chalbert' } }])[0].key).toBe(record.key);
});

it('real prepare ledger and hold mutation preserves other cards and appends exactly one audit row', async () => {
  await withRealRepo(async ({ root }) => {
    const coord = join(root, 'coord'); mkdirSync(coord);
    const path = join(coord, 'prepare-failures.json');
    writeFileSync(path, JSON.stringify({ failures: { a: { num: '7', held: true }, b: { num: '8', held: true } }, cards: { preserved: true } }));
    placeBuildDispatchHold({ repo: 'we', num: 7, reason: 'prepare-unstamped', lockRoot: join(coord, 'build-dispatch-holds') });
    const readContext = createOperatorControlsReader({ root, coord });
    const i = args('retry-prepare');
    const p = planOperatorControl('retry-prepare', readContext('retry-prepare', i), i);
    const sink = createOperatorControlsSinks({ root, coord, readContext })['operator.control'];
    // A real preview must leave the ledger and hold untouched.
    expect(await sink({ ...p, input: { ...i, preview: true } })).toMatchObject({ action: 'noop' });
    expect(readContext('retry-prepare', i).holds).toHaveLength(1);
    await sink(p);
    const state = JSON.parse(readFileSync(path, 'utf8'));
    expect(state.failures.a).toMatchObject({ held: false, retry: true });
    expect(state.failures.b.held).toBe(true);
    expect(state.cards).toEqual({ preserved: true });
    expect(readContext('retry-prepare', i).holds).toEqual([]);
    expect(await sink(p)).toMatchObject({ action: 'noop' });
    const rows = readFileSync(join(coord, 'operator-actions.jsonl'), 'utf8').trim().split('\n');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0])).toMatchObject({ op: 'retry-prepare', item: '7', reason: input.reason });
  });
});

it('refresh does not noop when remote main advances beyond local origin/main', async () => {
  await withBareOrigin(async ({ clone, origin, git, seedOriginBranch }) => {
    const localMain = git(['rev-parse', 'origin/main']).trim();
    seedOriginBranch('lane/operator-fixture', { 'feature.txt': 'feature\n' });
    git(['fetch', 'origin', 'lane/operator-fixture']);
    seedOriginBranch('main', { 'main-fix.txt': 'main fix\n' });
    const remoteMain = git(['rev-parse', 'main'], { cwd: origin }).trim();
    expect(git(['rev-parse', 'origin/main']).trim()).toBe(localMain);
    const runGh = argv => argv[0] === 'api' ? remoteMain : JSON.stringify({ state: 'OPEN', labels: [],
      headRefOid: git(['rev-parse', 'lane/operator-fixture'], { cwd: origin }).trim(), headRefName: 'lane/operator-fixture', isCrossRepository: false });
    const i = { ...input, checkout: clone };
    const reader = createOperatorControlsReader({ root: clone, runGh, readComments: () => [], readCheck: () => null });
    // Put the new object in the clone without updating origin/main: knowing the object
    // must not accidentally make the primitive use its stale default base ref.
    git(['fetch', 'origin', remoteMain]);
    const p = planOperatorControl('refresh', reader('refresh', i), i);
    expect(p.action).toBe('apply');
    expect(p.record.details.main).toBe(remoteMain);
    const refresh = vi.fn((ref, options) => refreshOntoMain(ref, { ...options, readIsCrossRepository: () => false }));
    const sink = createOperatorControlsSinks({ readContext: reader, refresh, rememberRefresh: vi.fn(), writeRecord: vi.fn() })['operator.control'];
    expect(await sink(p)).toMatchObject({ action: 'apply' });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(git(['show', 'lane/operator-fixture:main-fix.txt'], { cwd: origin })).toBe('main fix\n');
    expect(git(['show', 'lane/operator-fixture:feature.txt'], { cwd: origin })).toBe('feature\n');
  });
});
