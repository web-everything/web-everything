// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { retireBatch } from '../card-batch-io.mjs';
import { reconcileCardBatches, resolveReconcileIntervalMin, main } from '../card-batch-reconcile.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'batch-reconcile-')); roots.push(stateDir);
  const path = join(stateDir, 'org-repo-prevention.json');
  const state = { seq: 9, batchRef: 'lane/card-batch-prevention-9', headSha: 'a'.repeat(40),
    repo: 'org/repo', kind: 'prevention', sealedAt: '2026-10-18T12:00:00Z', pr: 272, seal: { step: 'label-on-green' }, members: [] };
  writeFileSync(path, JSON.stringify(state));
  return { stateDir, path, state, seal: vi.fn(async () => []), drain: vi.fn(), log: () => {} };
}

describe('reconcileCardBatches', () => {
  it.each(['OPEN', 'unreadable', 'unknown', null, undefined, '', 'merged', 'wrong-pr', 'wrong-branch'])('keeps %s state untouched', async status => {
    const f = fixture(); f.state.terminalPrState = 'MERGED'; writeFileSync(f.path, JSON.stringify(f.state));
    const before = readFileSync(f.path, 'utf8');
    const results = await reconcileCardBatches({ ...f, gh: async () => {
      if (status === 'unreadable') throw Error('offline');
      return JSON.stringify({ number: status === 'wrong-pr' ? 999 : 272,
        headRefName: status === 'wrong-branch' ? 'other' : 'lane/card-batch-prevention-9',
        state: ['wrong-pr', 'wrong-branch'].includes(status) ? 'MERGED' : status });
    } });
    expect(results[0]).toMatchObject({ action: 'refuse', reason: 'batch-sealed' });
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(existsSync(`${f.path}.lock`)).toBe(false);
    expect(f.drain).not.toHaveBeenCalled();
    expect(f.seal).toHaveBeenCalledOnce();
  });
  it.each(['identity', 'lease', 'expired'])('preserves the %s guard', async scenario => {
    const f = fixture();
    if (scenario === 'identity') { f.state.repo = 'wrong/repo'; writeFileSync(f.path, JSON.stringify(f.state)); }
    const gh = vi.fn(async () => '{"number":272,"headRefName":"lane/card-batch-prevention-9","state":"MERGED"}');
    let clock = 100;
    if (scenario === 'lease') writeFileSync(`${f.path}.lock`, JSON.stringify({ token: 'other', expiresAt: 1000 }));
    if (scenario === 'expired') gh.mockImplementation(async () => { clock = 1000; return '{"number":272,"headRefName":"lane/card-batch-prevention-9","state":"MERGED"}'; });
    const before = readFileSync(f.path, 'utf8');
    await reconcileCardBatches({ ...f, gh, clock: () => clock, leaseMs: 50 });
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    if (scenario !== 'expired') expect(gh).not.toHaveBeenCalled();
  });
  it('continues past corrupt states and never scans sealed archives', async () => {
    const f = fixture(); writeFileSync(join(f.stateDir, 'aaa.json'), '{');
    mkdirSync(join(f.stateDir, 'sealed')); writeFileSync(join(f.stateDir, 'sealed', 'bad.json'), '{');
    const results = await reconcileCardBatches({ ...f, gh: async () => '{"number":272,"headRefName":"lane/card-batch-prevention-9","state":"MERGED"}' });
    expect(results.map(result => result.action)).toEqual(['error', 'retired']);
    expect(JSON.parse(readFileSync(f.path))).toMatchObject({ seq: 9, lastSealedState: expect.any(String) });
    expect(f.seal).toHaveBeenCalledOnce();
  });
  it('drains an open slot using the scoped state directory and then flushes', async () => {
    const f = fixture(); writeFileSync(f.path, JSON.stringify({ seq: 9, lastSealedState: 'archive' }));
    mkdirSync(join(f.stateDir, 'pending-prevention')); writeFileSync(join(f.stateDir, 'pending-prevention/card.json'), '{}');
    const batch = vi.fn();
    f.drain.mockImplementation(async (input, options) => {
      expect(input.drainPending).toBe(true);
      await options.batch({ cardPath: 'backlog/card.md' }, {});
      expect(f.seal).not.toHaveBeenCalled();
      return { ok: true };
    });
    await reconcileCardBatches({ ...f, batch });
    expect(batch).toHaveBeenCalledWith({ cardPath: 'backlog/card.md' }, { stateDir: f.stateDir });
    expect(f.seal).toHaveBeenCalledOnce();
  });
  it('dry-run leaves state and leases untouched and does not invoke external operations', async () => {
    const f = fixture(); const gh = vi.fn(); const before = readFileSync(f.path, 'utf8');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { expect(await main(['--dry-run', '--json'], { ...f, gh })).toBe(0); }
    finally { output.mockRestore(); }
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(existsSync(`${f.path}.lock`)).toBe(false);
    for (const fn of [gh, f.seal, f.drain]) expect(fn).not.toHaveBeenCalled();
  });
});

it.each([undefined, null, 0, -1, 1.5, '10', 5, 12])('reads interval %s with positive integer fallback', value => {
  expect(resolveReconcileIntervalMin({ read: () => ({ cardBatch: { reconcileIntervalMin: value } }) }))
    .toBe(Number.isSafeInteger(value) && value > 0 ? value : 5);
});


it('reports drain and seal failures independently', async () => {
  const f = fixture(); writeFileSync(f.path, JSON.stringify({ seq: 9 }));
  mkdirSync(join(f.stateDir, 'pending-prevention')); writeFileSync(join(f.stateDir, 'pending-prevention/card.json'), '{}');
  f.drain.mockResolvedValue({ ok: false, reason: 'lane unavailable' });
  f.seal.mockRejectedValue(Error('seal failed'));
  expect(await reconcileCardBatches(f)).toEqual([
    { action: 'error', step: 'drain', reason: 'lane unavailable' },
    { action: 'error', step: 'seal', reason: 'seal failed' },
  ]);
});

it('defaults the interval when settings cannot be read', () => {
  expect(resolveReconcileIntervalMin({ read: () => { throw Error('unreadable'); } })).toBe(5);
});

it.each(['OPEN', 'MERGED', 'CLOSED', null, undefined, 'UNKNOWN'])(
  'the archive writer refuses an unverified terminalPrState hint %s', terminalPrState => {
    const f = fixture(); const before = readFileSync(f.path, 'utf8');
    expect(() => retireBatch(f.path, f.state, { repo: 'org/repo', kind: 'prevention', held: () => true, terminalPrState }))
      .toThrow('batch-sealed');
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(existsSync(join(f.stateDir, 'sealed'))).toBe(false);
  });
