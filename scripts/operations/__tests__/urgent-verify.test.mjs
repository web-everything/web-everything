import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ciUnitPlan, urgentMarker, urgentLedger } from '../urgent-verify-marker.mjs';
import { createUrgentDeps, urgentVerify } from '../urgent-verify.mjs';
import { resolveOperation } from '../run.mjs';
import { parseOperationArgv } from '../cli-adapter.mjs';

const sha = 'a'.repeat(40), now = Date.parse('2026-11-18T12:00:00Z');
const marker = { sha, suite: 'full', shards: 10, result: 'green', startedAt: new Date(now - 2000).toISOString(), finishedAt: new Date(now - 1000).toISOString(), host: 'host', repo: '/repo' };
const check = (m = marker, input = {}) => urgentMarker({ urgent: true, reason: 'Urgent daemon repair', sha, shards: 10, now, ledger: JSON.stringify(m), ...input });

describe('urgent marker', () => {
  it('accepts an exact full green marker', () => expect(check()).toMatchObject({ ok: true, evidence: { source: 'urgent-local-full', marker } }));
  it.each([
    ['wrong sha', { sha: 'b'.repeat(40) }], ['short sha record', { sha: sha.slice(0, 8) }],
    ['scoped suite', { suite: 'scoped' }], ['red result', { result: 'red' }],
    ['stale', { finishedAt: new Date(now - 7200001).toISOString() }],
    ['future', { finishedAt: new Date(now + 300001).toISOString() }],
    ['wrong shard count', { shards: 9 }], ['missing host', { host: '' }],
    ['non-string host', { host: 42 }], ['invalid finish', { finishedAt: 'invalid' }],
    ['invalid start', { startedAt: null }], ['reversed times', { startedAt: marker.finishedAt }],
  ])('rejects %s', (_, change) => expect(check({ ...marker, ...change })).toMatchObject({ ok: false, fallback: expect.stringContaining('urgent-verify') }));
  it.each([
    ['missing reason', { reason: undefined }], ['short reason', { reason: 'short' }],
    ['missing urgent flag', { urgent: false }], ['short input sha', { sha: sha.slice(0, 8) }],
    ['unreadable ledger', { ledger: undefined }], ['malformed ledger', { ledger: '{oops' }],
    ['unreadable shard count', { shards: undefined }],
  ])('rejects %s', (_, input) => expect(check(marker, input).ok).toBe(false));
  it('later red for same sha supersedes green, regardless of its timestamp', () => {
    expect(check(marker, { ledger: [marker, { ...marker, result: 'red' }].map(JSON.stringify).join('\n') }).ok).toBe(false);
  });
  it('ignores a later red for a different sha', () => {
    expect(check(marker, { ledger: [marker, { ...marker, sha: 'b'.repeat(40), result: 'red' }].map(JSON.stringify).join('\n') }).ok).toBe(true);
  });
});

function fixture() {
  let tick = now - 1000;
  return { repo: '/repo', host: 'host', now: () => new Date(tick += 1000).toISOString(), clean: vi.fn(() => true), head: vi.fn(() => sha),
    plan: () => [{ shard: '1/2' }, { shard: '2/2' }], shard: vi.fn(), standards: vi.fn(), append: vi.fn() };
}
describe('urgent verifier', () => {
  it('records green only after all shards sequentially and standards', async () => {
    const d = fixture(), order = [];
    d.shard = async s => { order.push(s.shard); await Promise.resolve(); order.push('done'); };
    d.standards = () => order.push('standards');
    expect(await urgentVerify({ sha, result: 'red' }, d)).toMatchObject({ ok: true });
    expect(order).toEqual(['1/2', 'done', '2/2', 'done', 'standards']);
    expect(d.append).toHaveBeenCalledTimes(1);
    expect(d.append).toHaveBeenCalledWith(expect.objectContaining({ sha, suite: 'full', result: 'green', shards: 2, host: 'host', repo: '/repo' }));
  });
  it.each(['shard', 'standards'])('records red when %s fails', async stage => {
    const d = fixture(); d[stage] = vi.fn(() => { throw new Error('failed'); });
    expect(await urgentVerify({ sha, result: 'green' }, d)).toMatchObject({ ok: false, marker: { result: 'red' } });
    expect(d.append).toHaveBeenCalledTimes(1);
    if (stage === 'shard') { expect(d.shard).toHaveBeenCalledTimes(1); expect(d.standards).not.toHaveBeenCalled(); }
  });
  it.each(['dirty', 'wrong head', 'short sha', 'unreadable workflow'])('refuses %s before suites and writes no marker', async kind => {
    const d = fixture();
    if (kind === 'dirty') d.clean.mockReturnValue(false);
    if (kind === 'wrong head') d.head.mockReturnValue('b'.repeat(40));
    if (kind === 'unreadable workflow') d.plan = () => { throw new Error('unreadable'); };
    expect(await urgentVerify({ sha: kind === 'short sha' ? 'abc' : sha }, d)).toMatchObject({ ok: false, fallback: expect.stringContaining('wait for passing CI') });
    expect(d.shard).not.toHaveBeenCalled(); expect(d.append).not.toHaveBeenCalled();
  });
  it('records red if the checkout changes during suites', async () => {
    const d = fixture(); d.clean.mockReturnValueOnce(true).mockReturnValue(false);
    expect(await urgentVerify({ sha }, d)).toMatchObject({ marker: { result: 'red' } });
  });
  it('binds the operation and exposes sha in generated argv parsing', () => {
    const { declaration, sinks } = resolveOperation('urgent-verify');
    expect(parseOperationArgv(declaration, [`--sha=${sha}`])).toMatchObject({ input: { sha } });
    expect(sinks['urgent-verify.run']).toBeTypeOf('function');
  });
  it('declares urgent as opt-in and parses its reason for prototype-load', () => {
    const { declaration } = resolveOperation('prototype-load');
    expect(declaration.input.urgent.default).toBe(false);
    expect(parseOperationArgv(declaration, ['--urgent', '--reason=Critical daemon repair'])).toMatchObject({ input: { urgent: true, reason: 'Critical daemon repair' } });
  });
});

describe('real adapter contract with injected filesystem and subprocesses', () => {
  it('reads the current ten CI groups, runs every shard through admission and appends privately', async () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const plan = ciUnitPlan(workflow);
    expect(plan).toHaveLength(10);
    expect(plan[0]).toEqual({ group: 'covered', shard: '1/9' });
    expect(plan[9]).toEqual({ group: 'nocov', shard: '1/1' });
    const packageText = readFileSync('package.json', 'utf8');
    const fs = { readFileSync: vi.fn(p => p.endsWith('package.json') ? packageText : workflow), mkdirSync: vi.fn(), appendFileSync: vi.fn() };
    const spawnSync = vi.fn((cmd, args) => ({ status: 0, stdout: args[0] === 'status' ? '' : args[0] === 'rev-parse' ? sha : args[0]?.includes('shard-assign') ? 'scripts/example.test.mjs\n' : '' }));
    const d = createUrgentDeps({ cwd: '/repo', home: '/home/test', fs, spawnSync });
    expect((await urgentVerify({ sha }, d)).ok).toBe(true);
    const heavy = spawnSync.mock.calls.filter(([, args]) => args[0] === 'scripts/readiness/heavy-admission.mjs');
    expect(heavy).toHaveLength(11);
    expect(heavy.every(([, args, opts]) => args.includes('--wait-ms=60000') && opts.maxBuffer > 0 && opts.timeout > 0)).toBe(true);
    expect(heavy.slice(0, 10).every(([, args]) => args.includes('vitest') && args.includes('scripts/example.test.mjs'))).toBe(true);
    const coverageArgs = JSON.parse(packageText).scripts['test:coverage:shard'].split(' -- ')[1].split(' ');
    expect(heavy[0][1].slice(4, -1)).toEqual(coverageArgs);
    expect(heavy[10][1]).toContain('check:standards');
    expect(fs.appendFileSync).toHaveBeenCalledWith(urgentLedger('/home/test'), expect.stringMatching(/"suite":"full".*\n$/), { encoding: 'utf8', mode: 0o600 });
  });
  it.each(['broken', 'jobs: {}', 'jobs:\n  test-shard:\n    strategy:\n      matrix:\n        shard: [1, 3]', `jobs:\n  test-shard:\n    strategy:\n      matrix:\n        shard: [${Array.from({ length: 65 }, (_, i) => i + 1)}]`])('refuses unreadable or oversized CI plans with a diagnostic', workflow => {
    expect(() => ciUnitPlan(workflow)).toThrow();
  });
  it('refuses unknown npm command syntax without running a shard', () => {
    const spawnSync = vi.fn(() => ({ status: 0, stdout: 'scripts/example.test.mjs\n' }));
    const d = createUrgentDeps({ fs: { readFileSync: () => JSON.stringify({ scripts: { 'test:unit': 'vitest run; echo bypass' } }) }, spawnSync });
    expect(() => d.shard({ group: 'nocov', shard: '1/1' })).toThrow('unreadable CI Vitest command');
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
  it('treats admission failure as red and appends once without retrying', async () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8'), packageText = readFileSync('package.json', 'utf8');
    const fs = { readFileSync: p => p.endsWith('package.json') ? packageText : workflow, mkdirSync: vi.fn(), appendFileSync: vi.fn() };
    const spawnSync = vi.fn((cmd, args) => ({ status: args[0].includes('heavy-admission') ? 75 : 0, stdout: args[0] === 'status' ? '' : args[0] === 'rev-parse' ? sha : 'scripts/example.test.mjs\n' }));
    expect(await urgentVerify({ sha }, createUrgentDeps({ fs, spawnSync }))).toMatchObject({ ok: false, marker: { result: 'red' } });
    expect(spawnSync.mock.calls.filter(([, args]) => args[0].includes('heavy-admission'))).toHaveLength(1);
    expect(fs.appendFileSync).toHaveBeenCalledTimes(1);
  });
});
